//! Webcam video encoder - supports both feed-based and legacy buffer modes.
//!
//! FeedWebcamEncoder: Subscribes to camera feed, encodes frames as they arrive.
//! WebcamEncoderPipe: Legacy - reads from WEBCAM_BUFFER (deprecated).

// Allow unused encoder variants - keeping for potential future use
#![allow(dead_code)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use super::capture::WEBCAM_BUFFER;
use super::feed::{subscribe_global, Subscription};
use super::native_frame::NativeCameraFrame;

/// Webcam encoder pipe - FFmpeg process ready to receive frames.
///
/// Created before recording starts, so FFmpeg startup doesn't affect timing.
/// The main recording loop calls `write_frame()` for each screen frame,
/// ensuring 1:1 correspondence between screen and webcam frames.
pub struct WebcamEncoderPipe {
    stdin: ChildStdin,
    child: Child,
    output_path: PathBuf,
    frames_written: u64,
    last_frame_id: u64,
    start_time: Instant,
    first_frame_time: Option<Instant>,
}

impl WebcamEncoderPipe {
    /// Create and spawn FFmpeg process, ready to receive frames.
    /// Call this BEFORE the recording loop starts.
    pub fn new(output_path: PathBuf) -> Result<Self, String> {
        let (width, height) = WEBCAM_BUFFER.dimensions();
        let (width, height) = if width > 0 && height > 0 {
            (width, height)
        } else {
            (1280, 720)
        };

        eprintln!("[WEBCAM_PIPE] Spawning FFmpeg: {}x{}", width, height);

        let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

        let mut child = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
            .args([
                "-y",
                "-f",
                "image2pipe",
                "-framerate",
                "30",
                "-i",
                "pipe:0",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ])
            .arg(&output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get FFmpeg stdin")?;

        // Clear any stale frames
        let last_frame_id = WEBCAM_BUFFER.current_frame_id();
        let start_time = Instant::now();

        eprintln!(
            "[WEBCAM_PIPE] FFmpeg spawned at {:?}, waiting for frames",
            std::time::SystemTime::now()
        );

        Ok(Self {
            stdin,
            child,
            output_path,
            frames_written: 0,
            last_frame_id,
            start_time,
            first_frame_time: None,
        })
    }

    /// Write current webcam frame to FFmpeg.
    /// Call this once per screen frame in the main recording loop.
    /// Returns true if a frame was written, false if no new frame available.
    pub fn write_frame(&mut self) -> bool {
        // Get latest frame (even if same as last - we need consistent frame rate)
        let frame = match WEBCAM_BUFFER.get() {
            Some(f) => f,
            None => return false,
        };

        if frame.jpeg_cache.is_empty() {
            return false;
        }

        // Write to FFmpeg
        if self.stdin.write_all(&frame.jpeg_cache).is_err() {
            return false;
        }

        // Log first frame timing
        if self.first_frame_time.is_none() {
            self.first_frame_time = Some(Instant::now());
            let delay = self.start_time.elapsed();
            eprintln!(
                "[WEBCAM_PIPE] First frame written after {:.3}s delay from FFmpeg spawn",
                delay.as_secs_f64()
            );
        }

        self.frames_written += 1;
        self.last_frame_id = frame.frame_id;
        true
    }

    /// Get number of frames written.
    pub fn frames_written(&self) -> u64 {
        self.frames_written
    }

    /// Finish encoding and close FFmpeg.
    /// `actual_duration` is the actual recording duration in seconds (from screen recording).
    pub fn finish_with_duration(mut self, actual_duration: f64) -> Result<(), String> {
        let total_elapsed = self.start_time.elapsed();
        let frames_written = self.frames_written;
        let output_path = self.output_path.clone();

        eprintln!("[WEBCAM_PIPE] === WEBCAM ENCODER FINISHING ===");
        eprintln!(
            "[WEBCAM_PIPE] Total time since spawn: {:.3}s",
            total_elapsed.as_secs_f64()
        );
        eprintln!("[WEBCAM_PIPE] Frames written: {}", frames_written);
        eprintln!("[WEBCAM_PIPE] Target duration: {:.3}s", actual_duration);

        // Calculate actual FPS needed to match screen duration
        let actual_fps = if actual_duration > 0.0 {
            frames_written as f64 / actual_duration
        } else {
            30.0
        };
        eprintln!("[WEBCAM_PIPE] Calculated FPS for sync: {:.2}", actual_fps);

        // Close stdin to signal EOF
        drop(self.stdin);

        // Wait for FFmpeg to finish initial encoding
        let status = self
            .child
            .wait()
            .map_err(|e| format!("FFmpeg wait error: {}", e))?;

        if !status.success() {
            return Err(format!("FFmpeg exited with: {}", status));
        }

        // Now re-encode with correct FPS to match screen duration
        // This ensures webcam video has same duration as screen video
        Self::remux_with_correct_fps(&output_path, actual_fps)?;

        eprintln!(
            "[WEBCAM_PIPE] Webcam encoding complete, synced to {:.3}s",
            actual_duration
        );
        Ok(())
    }

    /// Remux the video with correct timing using stream copy (no re-encoding).
    /// Uses -itsscale to scale timestamps to match target duration.
    fn remux_with_correct_fps(output_path: &PathBuf, target_fps: f64) -> Result<(), String> {
        let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

        // Rename original to temp
        let temp_path = output_path.with_extension("temp.mp4");
        std::fs::rename(output_path, &temp_path)
            .map_err(|e| format!("Failed to rename for remux: {}", e))?;

        // Calculate timestamp scale factor
        // Original video: encoded at 30fps (hardcoded in new())
        // Target: actual_fps frames per second
        // Scale = 30 / target_fps (e.g., 30/19.71 = 1.52 means slow down by 1.52x)
        let scale_factor = 30.0 / target_fps;
        let scale_str = format!("{:.6}", scale_factor);

        eprintln!(
            "[WEBCAM_PIPE] Remuxing with itsscale={} (30fps -> {:.2}fps)",
            scale_str, target_fps
        );

        // Use -itsscale to scale input timestamps, -c copy for stream copy (no re-encoding)
        let output = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
            .args([
                "-y",
                "-itsscale",
                &scale_str, // Scale input timestamps
                "-i",
                &temp_path.to_string_lossy(),
                "-c",
                "copy", // Stream copy (no re-encoding)
                "-movflags",
                "+faststart",
                "-an", // No audio
            ])
            .arg(output_path)
            .output()
            .map_err(|e| format!("FFmpeg remux failed: {}", e))?;

        // Clean up temp file
        let _ = std::fs::remove_file(&temp_path);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("FFmpeg remux failed: {}", stderr));
        }

        eprintln!(
            "[WEBCAM_PIPE] Remuxed with stream copy, target FPS: {:.2}",
            target_fps
        );
        Ok(())
    }

    /// Finish encoding without duration sync (legacy).
    pub fn finish(self) -> Result<(), String> {
        // Fall back to 30fps if no duration provided
        let frames = self.frames_written;
        self.finish_with_duration(frames as f64 / 30.0)
    }

    /// Cancel encoding and kill FFmpeg.
    pub fn cancel(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// Keep the old BackgroundWebcamEncoder for compatibility, but it's deprecated
pub struct BackgroundWebcamEncoder {
    pipe: Option<WebcamEncoderPipe>,
}

impl BackgroundWebcamEncoder {
    pub fn new(
        _output_path: PathBuf,
        _go_signal: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Self, String> {
        // Deprecated - use WebcamEncoderPipe directly
        Err("BackgroundWebcamEncoder is deprecated, use WebcamEncoderPipe".to_string())
    }

    pub fn frame_count(&self) -> u64 {
        self.pipe.as_ref().map(|p| p.frames_written()).unwrap_or(0)
    }

    pub fn finish(self) -> Result<(), String> {
        if let Some(pipe) = self.pipe {
            pipe.finish()
        } else {
            Ok(())
        }
    }
}

// ============================================================================
// Feed-based Webcam Encoder (uses camera feed subscription)
// ============================================================================

/// Webcam encoder that subscribes to the camera feed.
/// Runs encoding in a background thread, receives frames via subscription.
pub struct FeedWebcamEncoder {
    stop_signal: Arc<AtomicBool>,
    frames_written: Arc<AtomicU64>,
    thread: Option<JoinHandle<Result<(), String>>>,
    output_path: PathBuf,
    start_time: Instant,
}

impl FeedWebcamEncoder {
    /// Create and start the encoder.
    /// Subscribes to the global camera feed and encodes frames as they arrive.
    pub fn new(output_path: PathBuf, width: u32, height: u32) -> Result<Self, String> {
        let stop_signal = Arc::new(AtomicBool::new(false));
        let frames_written = Arc::new(AtomicU64::new(0));
        let start_time = Instant::now();

        // Subscribe to the camera feed
        let subscription = subscribe_global("encoder", 8)?;

        log::info!(
            "[FEED_ENCODER] Starting webcam encoder: {}x{} -> {}",
            width,
            height,
            output_path.display()
        );

        let stop = Arc::clone(&stop_signal);
        let frames = Arc::clone(&frames_written);
        let path = output_path.clone();

        let thread = std::thread::Builder::new()
            .name("webcam-encoder".to_string())
            .spawn(move || Self::encode_loop(subscription, path, width, height, stop, frames))
            .map_err(|e| format!("Failed to spawn encoder thread: {}", e))?;

        Ok(Self {
            stop_signal,
            frames_written,
            thread: Some(thread),
            output_path,
            start_time,
        })
    }

    fn encode_loop(
        subscription: Subscription,
        output_path: PathBuf,
        _width: u32,
        _height: u32,
        stop_signal: Arc<AtomicBool>,
        frames_written: Arc<AtomicU64>,
    ) -> Result<(), String> {
        let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

        // Wait for first frame to get actual dimensions and format
        let first_frame = loop {
            if stop_signal.load(Ordering::Relaxed) {
                return Ok(());
            }
            if let Some(frame) = subscription.recv_timeout(std::time::Duration::from_millis(100)) {
                break frame;
            }
        };

        let width = first_frame.width;
        let height = first_frame.height;
        let pixel_format = first_frame.pixel_format;
        let expected_bgra_size = (width * height * 4) as usize;

        log::info!(
            "[FEED_ENCODER] First frame: {}x{} format={:?} raw_bytes={} expected_bgra={}",
            width,
            height,
            pixel_format,
            first_frame.bytes().len(),
            expected_bgra_size
        );

        // Convert first frame to BGRA for FFmpeg
        let first_bgra = first_frame
            .to_bgra()
            .ok_or_else(|| format!("Failed to convert first frame (format={:?})", pixel_format))?;

        // Verify BGRA size and content
        if first_bgra.len() != expected_bgra_size {
            return Err(format!(
                "BGRA size mismatch: got {} expected {}",
                first_bgra.len(),
                expected_bgra_size
            ));
        }

        // Check if data is non-zero (not all black)
        let non_zero_count = first_bgra.iter().filter(|&&b| b > 0).count();
        let non_zero_pct = (non_zero_count as f32 / first_bgra.len() as f32) * 100.0;
        log::info!(
            "[FEED_ENCODER] First frame BGRA: {} bytes, {:.1}% non-zero pixels",
            first_bgra.len(),
            non_zero_pct
        );

        if non_zero_pct < 1.0 {
            log::warn!("[FEED_ENCODER] WARNING: First frame appears to be mostly black!");
        }

        log::info!(
            "[FEED_ENCODER] First frame: {}x{}, starting FFmpeg with rawvideo input",
            width,
            height
        );

        // Spawn FFmpeg with rawvideo input (much faster than image2pipe + JPEG)
        let mut child = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
            .args([
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "-s",
                &format!("{}x{}", width, height),
                "-r",
                "30",
                "-i",
                "pipe:0",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ])
            .arg(&output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let mut stdin = child.stdin.take().ok_or("Failed to get FFmpeg stdin")?;
        let mut frame_count = 0u64;

        // Write first frame
        if stdin.write_all(&first_bgra).is_ok() {
            frame_count += 1;
            frames_written.store(frame_count, Ordering::Relaxed);
        }

        // Receive and encode remaining frames
        let mut conversion_failures = 0u64;
        while !stop_signal.load(Ordering::Relaxed) {
            match subscription.recv_timeout(std::time::Duration::from_millis(50)) {
                Some(frame) => {
                    // Convert to BGRA (fast - just pixel reordering, no compression)
                    let bgra = match frame.to_bgra() {
                        Some(data) => data,
                        None => {
                            conversion_failures += 1;
                            if conversion_failures <= 3 {
                                log::warn!(
                                    "[FEED_ENCODER] BGRA conversion failed for frame {} (format={:?}, {} bytes)",
                                    frame.frame_id, frame.pixel_format, frame.bytes().len()
                                );
                            }
                            continue;
                        },
                    };

                    // Write raw BGRA to FFmpeg
                    if let Err(e) = stdin.write_all(&bgra) {
                        log::error!("[FEED_ENCODER] Write error: {}", e);
                        break;
                    }

                    frame_count += 1;
                    frames_written.store(frame_count, Ordering::Relaxed);

                    if frame_count % 300 == 0 {
                        log::debug!("[FEED_ENCODER] {} frames encoded", frame_count);
                    }
                },
                None => {},
            }
        }

        // Flush and close stdin to signal EOF to FFmpeg
        if let Err(e) = stdin.flush() {
            log::warn!("[FEED_ENCODER] Failed to flush stdin: {}", e);
        }
        drop(stdin);

        log::info!(
            "[FEED_ENCODER] Wrote {} frames to FFmpeg ({} conversion failures), waiting for completion...",
            frame_count, conversion_failures
        );

        // Capture FFmpeg output for debugging
        let output = child
            .wait_with_output()
            .map_err(|e| format!("FFmpeg wait error: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::error!("[FEED_ENCODER] FFmpeg failed: {}", stderr);
            return Err(format!(
                "FFmpeg exited with: {} - {}",
                output.status, stderr
            ));
        }

        // Log FFmpeg stderr even on success (might have warnings)
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            log::debug!("[FEED_ENCODER] FFmpeg stderr: {}", stderr);
        }

        log::info!("[FEED_ENCODER] Encoding complete: {} frames", frame_count);
        Ok(())
    }

    /// Get number of frames written.
    pub fn frames_written(&self) -> u64 {
        self.frames_written.load(Ordering::Relaxed)
    }

    /// Stop encoding and finalize with correct duration.
    pub fn finish_with_duration(mut self, actual_duration: f64) -> Result<(), String> {
        let frames = self.frames_written();
        log::info!(
            "[FEED_ENCODER] Finishing: {} frames, target duration {:.2}s",
            frames,
            actual_duration
        );

        // Signal stop
        self.stop_signal.store(true, Ordering::SeqCst);

        // Wait for thread
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| "Encoder thread panicked")??;
        }

        // Remux with correct FPS for sync
        let actual_fps = if actual_duration > 0.0 && frames > 0 {
            frames as f64 / actual_duration
        } else {
            30.0
        };

        WebcamEncoderPipe::remux_with_correct_fps(&self.output_path, actual_fps)?;

        log::info!(
            "[FEED_ENCODER] Synced to {:.2}fps for {:.2}s duration",
            actual_fps,
            actual_duration
        );
        Ok(())
    }

    /// Cancel encoding.
    pub fn cancel(mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // Remove partial file
        let _ = std::fs::remove_file(&self.output_path);
    }
}

impl Drop for FeedWebcamEncoder {
    fn drop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
    }
}
