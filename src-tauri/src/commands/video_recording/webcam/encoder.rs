//! Webcam video encoder - main loop controls frame timing.
//!
//! FFmpeg is spawned BEFORE recording starts and kept ready.
//! The main recording loop pipes frames directly, ensuring perfect sync
//! with screen recording (same loop iteration = same timestamp).

// Allow unused encoder variants - keeping for potential future use
#![allow(dead_code)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Instant;

use super::capture::WEBCAM_BUFFER;

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

        let mut child = Command::new(&ffmpeg_path)
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
        let output = Command::new(&ffmpeg_path)
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
