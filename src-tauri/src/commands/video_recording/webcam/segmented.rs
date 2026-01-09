//! Segmented webcam output for crash recovery.
//!
//! Records webcam to multiple short segments (~3 seconds each) with a manifest
//! file that enables recovery of completed segments if recording is interrupted.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::capture::FrameReceiver;
use super::drift::VideoDriftTracker;
use super::native_frame::NativeCameraFrame;
use crate::commands::video_recording::fragmentation::{
    atomic_write_json, sync_file, FragmentManifest,
};

/// Default segment duration (3 seconds).
const DEFAULT_SEGMENT_DURATION: Duration = Duration::from_secs(3);

/// Maximum frames to buffer in encoder channel.
const ENCODER_BUFFER_SIZE: usize = 30;

/// Configuration for segmented webcam recording.
#[derive(Debug, Clone)]
pub struct SegmentedWebcamConfig {
    /// Duration of each segment.
    pub segment_duration: Duration,
    /// JPEG quality for encoding (1-100).
    pub jpeg_quality: u8,
    /// FFmpeg CRF value (lower = better quality).
    pub crf: u8,
}

impl Default for SegmentedWebcamConfig {
    fn default() -> Self {
        Self {
            segment_duration: DEFAULT_SEGMENT_DURATION,
            jpeg_quality: 85,
            crf: 18,
        }
    }
}

/// Information about a completed segment.
#[derive(Debug, Clone)]
pub struct SegmentInfo {
    /// Path to the segment file.
    pub path: PathBuf,
    /// Segment index (0-based).
    pub index: u32,
    /// Duration of this segment.
    pub duration: Duration,
    /// Number of frames in this segment.
    pub frame_count: u64,
}

/// Result of segmented recording.
pub struct SegmentedRecordingResult {
    /// List of completed segments.
    pub segments: Vec<SegmentInfo>,
    /// Total frames encoded across all segments.
    pub total_frames: u64,
    /// Total duration across all segments.
    pub total_duration: Duration,
    /// Number of frames dropped due to backpressure.
    pub frames_dropped: u64,
    /// Path to the manifest file.
    pub manifest_path: PathBuf,
    /// Any error that occurred.
    pub error: Option<String>,
}

/// State for the current segment being recorded.
struct CurrentSegment {
    /// FFmpeg process.
    child: Child,
    /// FFmpeg stdin for frame data (Option to allow taking ownership).
    stdin: Option<ChildStdin>,
    /// Segment index.
    index: u32,
    /// Output path for this segment.
    path: PathBuf,
    /// When this segment started (recording time).
    start_time: Duration,
    /// Frame count for this segment.
    frame_count: u64,
    /// Frame dimensions.
    width: u32,
    height: u32,
}

/// Segmented webcam muxer that records to multiple short segments.
pub struct SegmentedWebcamMuxer {
    /// Base output directory.
    output_dir: PathBuf,
    /// Configuration.
    config: SegmentedWebcamConfig,
    /// Signal to stop recording.
    stop_signal: Arc<AtomicBool>,
    /// Frame receiver from capture service.
    frame_receiver: FrameReceiver,
    /// Recording start time.
    recording_start: Instant,
    /// Pause flag (shared with capture pipeline).
    pause_flag: Option<Arc<AtomicBool>>,
}

impl SegmentedWebcamMuxer {
    /// Create a new segmented webcam muxer.
    ///
    /// # Arguments
    /// * `output_dir` - Directory to store segments and manifest
    /// * `frame_receiver` - Channel receiver for camera frames
    /// * `recording_start` - Wall clock time when recording started
    pub fn new(
        output_dir: PathBuf,
        frame_receiver: FrameReceiver,
        recording_start: Instant,
    ) -> Self {
        Self {
            output_dir,
            config: SegmentedWebcamConfig::default(),
            stop_signal: Arc::new(AtomicBool::new(false)),
            frame_receiver,
            recording_start,
            pause_flag: None,
        }
    }

    /// Set the segment duration.
    pub fn with_segment_duration(mut self, duration: Duration) -> Self {
        self.config.segment_duration = duration;
        self
    }

    /// Set a pause flag to check during recording.
    pub fn with_pause_flag(mut self, flag: Arc<AtomicBool>) -> Self {
        self.pause_flag = Some(flag);
        self
    }

    /// Get the stop signal for external control.
    pub fn stop_signal(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop_signal)
    }

    /// Run the segmented recording loop (blocking).
    ///
    /// Returns when stop_signal is set or an error occurs.
    pub fn run(self) -> SegmentedRecordingResult {
        let mut result = SegmentedRecordingResult {
            segments: Vec::new(),
            total_frames: 0,
            total_duration: Duration::ZERO,
            frames_dropped: 0,
            manifest_path: self.output_dir.join("manifest.json"),
            error: None,
        };

        // Ensure output directory exists
        if let Err(e) = std::fs::create_dir_all(&self.output_dir) {
            result.error = Some(format!("Failed to create output dir: {}", e));
            return result;
        }

        // Wait for first frame to get dimensions
        let first_frame = match self.wait_for_first_frame() {
            Some(f) => f,
            None => {
                result.error = Some("No frames received before stop".to_string());
                return result;
            },
        };

        let width = first_frame.width;
        let height = first_frame.height;

        log::info!(
            "[SEGMENTED] Starting segmented recording: {}x{} @ {:?} segments",
            width,
            height,
            self.config.segment_duration
        );

        // Initialize drift tracker
        let mut drift_tracker = VideoDriftTracker::new();
        let mut pause_offset = Duration::ZERO;
        let mut paused_at: Option<Duration> = None;

        // Start first segment
        let mut current_segment = match self.create_segment(0, width, height) {
            Ok(s) => s,
            Err(e) => {
                result.error = Some(e);
                return result;
            },
        };
        let mut segment_start_time = Duration::ZERO;

        // Write manifest with first segment in progress
        let mut manifest = FragmentManifest::new();
        manifest.add_in_progress_fragment(current_segment.path.clone(), 0);
        let _ = atomic_write_json(&result.manifest_path, &manifest);

        // Process first frame
        if let Some(jpeg) = first_frame.to_jpeg(self.config.jpeg_quality) {
            if let Some(ref mut stdin) = current_segment.stdin {
                if stdin.write_all(&jpeg).is_ok() {
                    current_segment.frame_count = 1;
                    result.total_frames = 1;
                }
            }
        }

        // Main recording loop
        loop {
            // Check stop signal
            if self.stop_signal.load(Ordering::Relaxed) {
                break;
            }

            // Receive frame with timeout
            match self.frame_receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(frame) => {
                    // Calculate wall clock elapsed
                    let wall_clock_elapsed = self.recording_start.elapsed();

                    // Handle pause
                    if let Some(ref pause_flag) = self.pause_flag {
                        if pause_flag.load(Ordering::Acquire) {
                            // We're paused
                            if paused_at.is_none() {
                                paused_at = Some(wall_clock_elapsed);
                                log::debug!("[SEGMENTED] Paused at {:?}", wall_clock_elapsed);
                            }
                            continue; // Drop frame during pause
                        } else if let Some(pause_start) = paused_at.take() {
                            // Resuming from pause
                            let pause_duration = wall_clock_elapsed.saturating_sub(pause_start);
                            pause_offset += pause_duration;
                            log::debug!("[SEGMENTED] Resumed, pause offset now {:?}", pause_offset);
                        }
                    }

                    // Adjust for pause offset
                    let adjusted_wall_clock = wall_clock_elapsed.saturating_sub(pause_offset);

                    // Calculate corrected timestamp using drift tracker
                    let corrected_pts = drift_tracker
                        .calculate_timestamp(frame.camera_timestamp, adjusted_wall_clock);

                    // Check if we need to rotate segments
                    let segment_elapsed = corrected_pts.saturating_sub(segment_start_time);
                    if segment_elapsed >= self.config.segment_duration {
                        // Finish current segment
                        let segment_duration = corrected_pts.saturating_sub(segment_start_time);
                        drop(current_segment.stdin.take());

                        match current_segment.child.wait() {
                            Ok(status) if !status.success() => {
                                log::warn!("[SEGMENTED] FFmpeg exited with: {}", status);
                            },
                            Err(e) => {
                                log::warn!("[SEGMENTED] FFmpeg wait error: {}", e);
                            },
                            _ => {},
                        }

                        // Sync segment file
                        let _ = sync_file(&current_segment.path);

                        // Record completed segment
                        let segment_info = SegmentInfo {
                            path: current_segment.path.clone(),
                            index: current_segment.index,
                            duration: segment_duration,
                            frame_count: current_segment.frame_count,
                        };
                        result.segments.push(segment_info);
                        result.total_duration = corrected_pts;

                        // Update manifest
                        manifest = FragmentManifest::new();
                        for seg in &result.segments {
                            manifest.add_completed_fragment(
                                seg.path.clone(),
                                seg.index,
                                seg.duration,
                            );
                        }

                        // Start next segment
                        let next_index = current_segment.index + 1;
                        segment_start_time = corrected_pts;

                        current_segment = match self.create_segment(next_index, width, height) {
                            Ok(s) => s,
                            Err(e) => {
                                result.error = Some(e);
                                break;
                            },
                        };

                        // Add new segment as in-progress
                        manifest.add_in_progress_fragment(current_segment.path.clone(), next_index);
                        let _ = atomic_write_json(&result.manifest_path, &manifest);

                        log::info!(
                            "[SEGMENTED] Rotated to segment {} at {:?}",
                            next_index,
                            corrected_pts
                        );
                    }

                    // Encode frame to current segment
                    if let Some(jpeg) = frame.to_jpeg(self.config.jpeg_quality) {
                        if let Some(ref mut stdin) = current_segment.stdin {
                            if stdin.write_all(&jpeg).is_err() {
                                result.error = Some("Failed to write to FFmpeg".to_string());
                                break;
                            }
                            current_segment.frame_count += 1;
                            result.total_frames += 1;
                        }
                    }
                },
                Err(flume::RecvTimeoutError::Timeout) => {
                    continue;
                },
                Err(flume::RecvTimeoutError::Disconnected) => {
                    log::info!("[SEGMENTED] Frame channel disconnected");
                    break;
                },
            }
        }

        // Finish final segment
        let final_duration = self.recording_start.elapsed().saturating_sub(pause_offset);
        let segment_duration = final_duration.saturating_sub(segment_start_time);

        drop(current_segment.stdin.take());
        let _ = current_segment.child.wait();
        let _ = sync_file(&current_segment.path);

        // Add final segment if it has frames
        if current_segment.frame_count > 0 {
            let segment_info = SegmentInfo {
                path: current_segment.path,
                index: current_segment.index,
                duration: segment_duration,
                frame_count: current_segment.frame_count,
            };
            result.segments.push(segment_info);
        }

        result.total_duration = final_duration;

        // Write final manifest
        manifest = FragmentManifest::new();
        for seg in &result.segments {
            manifest.add_completed_fragment(seg.path.clone(), seg.index, seg.duration);
        }
        manifest.finalize();
        let _ = atomic_write_json(&result.manifest_path, &manifest);

        log::info!(
            "[SEGMENTED] Recording complete: {} segments, {} frames, {:?}",
            result.segments.len(),
            result.total_frames,
            result.total_duration
        );

        result
    }

    /// Wait for first frame from channel.
    fn wait_for_first_frame(&self) -> Option<NativeCameraFrame> {
        for _ in 0..50 {
            // 5 seconds max wait
            if self.stop_signal.load(Ordering::Relaxed) {
                return None;
            }
            match self.frame_receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(frame) => return Some(frame),
                Err(_) => continue,
            }
        }
        None
    }

    /// Create a new segment.
    fn create_segment(
        &self,
        index: u32,
        width: u32,
        height: u32,
    ) -> Result<CurrentSegment, String> {
        let path = self.output_dir.join(format!("fragment_{:03}.mp4", index));
        let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

        log::debug!("[SEGMENTED] Creating segment {} at {:?}", index, path);

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
                &self.config.crf.to_string(),
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ])
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get FFmpeg stdin")?;

        Ok(CurrentSegment {
            child,
            stdin: Some(stdin),
            index,
            path,
            start_time: Duration::ZERO,
            frame_count: 0,
            width,
            height,
        })
    }
}

/// Concatenate segments into a single output file.
///
/// Uses FFmpeg's concat demuxer for fast concatenation without re-encoding.
pub fn concatenate_segments(segments: &[SegmentInfo], output_path: &Path) -> Result<(), String> {
    if segments.is_empty() {
        return Err("No segments to concatenate".to_string());
    }

    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

    // Create concat list file
    let concat_list_path = output_path.with_extension("concat.txt");
    let mut concat_list = std::fs::File::create(&concat_list_path)
        .map_err(|e| format!("Failed to create concat list: {}", e))?;

    for segment in segments {
        writeln!(concat_list, "file '{}'", segment.path.display())
            .map_err(|e| format!("Failed to write concat list: {}", e))?;
    }
    drop(concat_list);

    log::info!(
        "[SEGMENTED] Concatenating {} segments to {:?}",
        segments.len(),
        output_path
    );

    // Run ffmpeg concat
    let output = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
        .args([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            &concat_list_path.to_string_lossy(),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(output_path)
        .output()
        .map_err(|e| format!("FFmpeg concat failed: {}", e))?;

    // Clean up concat list
    let _ = std::fs::remove_file(&concat_list_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg concat failed: {}", stderr));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = SegmentedWebcamConfig::default();
        assert_eq!(config.segment_duration, Duration::from_secs(3));
        assert_eq!(config.jpeg_quality, 85);
        assert_eq!(config.crf, 18);
    }
}
