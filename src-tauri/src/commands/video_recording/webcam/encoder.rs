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
        let is_mjpeg = first_frame.is_mjpeg();

        log::info!(
            "[FEED_ENCODER] First frame: {}x{} format={:?} raw_bytes={} is_mjpeg={}",
            width,
            height,
            pixel_format,
            first_frame.bytes().len(),
            is_mjpeg
        );

        // Cap output resolution to 1280 width (like Cap does) for consistent output
        const MAX_OUTPUT_WIDTH: u32 = 1280;
        let (output_width, output_height) = if width > MAX_OUTPUT_WIDTH {
            let scale = MAX_OUTPUT_WIDTH as f32 / width as f32;
            let scaled_height = ((height as f32 * scale) as u32) & !1; // Ensure even
            (MAX_OUTPUT_WIDTH, scaled_height)
        } else {
            (width, height)
        };

        log::info!(
            "[FEED_ENCODER] Input: {}x{}, Output: {}x{} (capped at {})",
            width,
            height,
            output_width,
            output_height,
            MAX_OUTPUT_WIDTH
        );

        // Build scale filter if downscaling needed
        let scale_filter = if width > MAX_OUTPUT_WIDTH {
            format!("scale={}:{}:flags=bilinear", output_width, output_height)
        } else {
            String::new()
        };

        // Choose input format based on frame type
        // MJPEG: use image2pipe (FFmpeg decodes JPEG directly - much faster)
        // Other formats: use rawvideo with BGRA conversion
        let mut cmd = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path);
        cmd.arg("-y");

        if is_mjpeg {
            // MJPEG: pipe JPEG directly to FFmpeg (no CPU decode needed)
            log::info!("[FEED_ENCODER] Using image2pipe for MJPEG input (fast path)");
            cmd.args(["-f", "image2pipe", "-framerate", "30", "-i", "pipe:0"]);
        } else {
            // Other formats: convert to BGRA and use rawvideo
            log::info!("[FEED_ENCODER] Using rawvideo for {:?} input", pixel_format);
            cmd.args([
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
            ]);
        }

        // Add scale filter if needed
        if !scale_filter.is_empty() {
            cmd.args(["-vf", &scale_filter]);
        }

        cmd.args([
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
        ]);

        let mut child = cmd
            .arg(&output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let mut stdin = child.stdin.take().ok_or("Failed to get FFmpeg stdin")?;
        let mut frame_count = 0u64;

        // Write first frame
        let first_data = if is_mjpeg {
            // MJPEG: write raw JPEG bytes directly
            first_frame.bytes().to_vec()
        } else {
            // Other: convert to BGRA
            first_frame.to_bgra().ok_or_else(|| {
                format!("Failed to convert first frame (format={:?})", pixel_format)
            })?
        };

        if stdin.write_all(&first_data).is_ok() {
            frame_count += 1;
            frames_written.store(frame_count, Ordering::Relaxed);
        }

        // Receive and encode remaining frames
        let mut conversion_failures = 0u64;
        while !stop_signal.load(Ordering::Relaxed) {
            match subscription.recv_timeout(std::time::Duration::from_millis(50)) {
                Some(frame) => {
                    let frame_data = if is_mjpeg {
                        // MJPEG: write raw JPEG bytes directly (zero-copy path)
                        frame.bytes().to_vec()
                    } else {
                        // Other: convert to BGRA
                        match frame.to_bgra() {
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
                        }
                    };

                    // Write frame data to FFmpeg
                    if let Err(e) = stdin.write_all(&frame_data) {
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
