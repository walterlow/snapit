//! Channel-based webcam encoder with drift tracking.
//!
//! Consumes frames from a flume channel and encodes them with proper
//! timestamp correction using VideoDriftTracker.
//!
//! This encoder runs in its own thread and receives NativeCameraFrame
//! instances from the capture service.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::capture::FrameReceiver;
use super::drift::VideoDriftTracker;
use super::native_frame::NativeCameraFrame;

/// Channel-based webcam encoder that runs in a background thread.
///
/// Receives frames from the capture service via a channel and encodes
/// them using FFmpeg. Uses drift tracking to maintain proper A/V sync.
pub struct ChannelWebcamEncoder {
    /// Thread handle for the encoder.
    thread: Option<JoinHandle<EncoderResult>>,
    /// Signal to stop encoding.
    stop_signal: Arc<AtomicBool>,
    /// Output path.
    output_path: PathBuf,
}

/// Result of encoder operation.
pub struct EncoderResult {
    /// Number of frames encoded.
    pub frames_encoded: u64,
    /// Actual duration of encoded video.
    pub duration_secs: f64,
    /// Number of frames dropped (encoder backed up).
    pub frames_dropped: u64,
    /// Number of frames with capped timestamps.
    pub frames_capped: u64,
    /// Any error that occurred.
    pub error: Option<String>,
}

impl ChannelWebcamEncoder {
    /// Create and start a channel-based encoder.
    ///
    /// # Arguments
    /// * `output_path` - Path for output video file
    /// * `frame_receiver` - Channel receiver for camera frames
    /// * `recording_start` - Wall clock time when recording started
    pub fn new(
        output_path: PathBuf,
        frame_receiver: FrameReceiver,
        recording_start: Instant,
    ) -> Result<Self, String> {
        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_signal_clone = Arc::clone(&stop_signal);
        let output_path_clone = output_path.clone();

        let thread = std::thread::Builder::new()
            .name("webcam-encoder".to_string())
            .spawn(move || {
                encoder_thread(
                    output_path_clone,
                    frame_receiver,
                    recording_start,
                    stop_signal_clone,
                )
            })
            .map_err(|e| format!("Failed to spawn encoder thread: {}", e))?;

        Ok(Self {
            thread: Some(thread),
            stop_signal,
            output_path,
        })
    }

    /// Signal the encoder to stop and wait for completion.
    pub fn finish(mut self, actual_duration: f64) -> Result<EncoderResult, String> {
        // Signal stop
        self.stop_signal.store(true, Ordering::SeqCst);

        // Wait for thread to complete
        let result = self
            .thread
            .take()
            .ok_or("Encoder thread already finished")?
            .join()
            .map_err(|_| "Encoder thread panicked")?;

        // Remux to correct duration if needed
        if result.error.is_none() && result.frames_encoded > 0 {
            let target_fps = result.frames_encoded as f64 / actual_duration;
            remux_with_correct_fps(&self.output_path, target_fps)?;
        }

        Ok(result)
    }

    /// Cancel encoding and discard output.
    pub fn cancel(mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = std::fs::remove_file(&self.output_path);
    }

    /// Check if encoder is still running.
    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .map(|t| !t.is_finished())
            .unwrap_or(false)
    }
}

/// Encoder thread main function.
fn encoder_thread(
    output_path: PathBuf,
    frame_receiver: FrameReceiver,
    recording_start: Instant,
    stop_signal: Arc<AtomicBool>,
) -> EncoderResult {
    let mut result = EncoderResult {
        frames_encoded: 0,
        duration_secs: 0.0,
        frames_dropped: 0,
        frames_capped: 0,
        error: None,
    };

    // Wait for first frame to get dimensions
    let first_frame = match wait_for_first_frame(&frame_receiver, &stop_signal) {
        Some(f) => f,
        None => {
            result.error = Some("No frames received before stop".to_string());
            return result;
        },
    };

    let width = first_frame.width;
    let height = first_frame.height;

    log::info!(
        "[ENCODER] Starting with {}x{} {:?}",
        width,
        height,
        first_frame.pixel_format
    );

    // Spawn FFmpeg
    let (mut stdin, mut child) = match spawn_ffmpeg(&output_path, width, height) {
        Ok(r) => r,
        Err(e) => {
            result.error = Some(e);
            return result;
        },
    };

    // Initialize drift tracker
    let mut drift_tracker = VideoDriftTracker::new();
    let mut last_pts = Duration::ZERO;

    // Process first frame
    if let Some(jpeg) = first_frame.to_jpeg(85) {
        if stdin.write_all(&jpeg).is_ok() {
            result.frames_encoded = 1;
        }
    }

    // Main encoding loop
    loop {
        // Check stop signal
        if stop_signal.load(Ordering::Relaxed) {
            break;
        }

        // Receive frame with timeout
        match frame_receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => {
                // Calculate corrected timestamp
                let wall_clock_elapsed = recording_start.elapsed();
                let camera_duration = frame.camera_timestamp;
                let corrected_pts =
                    drift_tracker.calculate_timestamp(camera_duration, wall_clock_elapsed);

                // Ensure monotonic PTS
                let pts = if corrected_pts > last_pts {
                    corrected_pts
                } else {
                    last_pts + Duration::from_micros(1)
                };
                last_pts = pts;

                // Convert to JPEG and write
                if let Some(jpeg) = frame.to_jpeg(85) {
                    if stdin.write_all(&jpeg).is_err() {
                        result.error = Some("Failed to write to FFmpeg".to_string());
                        break;
                    }
                    result.frames_encoded += 1;
                    result.duration_secs = pts.as_secs_f64();
                }
            },
            Err(flume::RecvTimeoutError::Timeout) => {
                // No frame available, continue
                continue;
            },
            Err(flume::RecvTimeoutError::Disconnected) => {
                // Channel closed, stop
                log::info!("[ENCODER] Frame channel disconnected");
                break;
            },
        }
    }

    // Get drift stats
    result.frames_capped = drift_tracker.capped_frame_count();

    // Close FFmpeg
    drop(stdin);
    match child.wait() {
        Ok(status) if !status.success() => {
            result.error = Some(format!("FFmpeg exited with: {}", status));
        },
        Err(e) => {
            result.error = Some(format!("FFmpeg wait error: {}", e));
        },
        _ => {},
    }

    log::info!(
        "[ENCODER] Finished: {} frames, {:.3}s, {} capped",
        result.frames_encoded,
        result.duration_secs,
        result.frames_capped
    );

    result
}

/// Wait for first frame from channel.
fn wait_for_first_frame(
    receiver: &FrameReceiver,
    stop_signal: &Arc<AtomicBool>,
) -> Option<NativeCameraFrame> {
    for _ in 0..50 {
        // 5 seconds max wait
        if stop_signal.load(Ordering::Relaxed) {
            return None;
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => return Some(frame),
            Err(_) => continue,
        }
    }
    None
}

/// Spawn FFmpeg encoder process.
fn spawn_ffmpeg(
    output_path: &PathBuf,
    width: u32,
    height: u32,
) -> Result<(ChildStdin, Child), String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

    log::info!(
        "[ENCODER] Spawning FFmpeg: {}x{} -> {:?}",
        width,
        height,
        output_path
    );

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
        .arg(output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get FFmpeg stdin")?;

    Ok((stdin, child))
}

/// Remux video with correct FPS to match target duration.
fn remux_with_correct_fps(output_path: &PathBuf, target_fps: f64) -> Result<(), String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

    // Rename original to temp
    let temp_path = output_path.with_extension("temp.mp4");
    std::fs::rename(output_path, &temp_path)
        .map_err(|e| format!("Failed to rename for remux: {}", e))?;

    // Calculate timestamp scale (encoded at 30fps, adjust to target)
    let scale_factor = 30.0 / target_fps;
    let scale_str = format!("{:.6}", scale_factor);

    log::info!(
        "[ENCODER] Remuxing with itsscale={} (30fps -> {:.2}fps)",
        scale_str,
        target_fps
    );

    let output = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
        .args([
            "-y",
            "-itsscale",
            &scale_str,
            "-i",
            &temp_path.to_string_lossy(),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-an",
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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encoder_result_default() {
        let result = EncoderResult {
            frames_encoded: 0,
            duration_secs: 0.0,
            frames_dropped: 0,
            frames_capped: 0,
            error: None,
        };
        assert_eq!(result.frames_encoded, 0);
        assert!(result.error.is_none());
    }
}
