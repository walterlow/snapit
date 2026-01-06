//! Streaming video decoder - single FFmpeg process for all frames.
//!
//! Uses tokio async I/O for non-blocking reads from FFmpeg stdout.

use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use super::types::DecodedFrame;

/// Streaming video decoder using a single FFmpeg process.
pub struct StreamDecoder {
    /// FFmpeg child process.
    process: Option<Child>,
    /// Video dimensions.
    width: u32,
    height: u32,
    /// Frame rate.
    fps: f64,
    /// Duration in milliseconds.
    #[allow(dead_code)]
    duration_ms: u64,
    /// Total frame count.
    frame_count: u32,
    /// Current frame index.
    current_frame: u32,
    /// Bytes per frame (width * height * 4 for RGBA).
    frame_size: usize,
    /// Start time offset in seconds.
    start_time_secs: f64,
}

impl StreamDecoder {
    /// Create a new streaming decoder.
    ///
    /// # Arguments
    /// * `path` - Path to video file
    /// * `start_ms` - Start time in milliseconds (for trimming)
    /// * `end_ms` - End time in milliseconds (for trimming)
    pub fn new(path: &Path, start_ms: u64, end_ms: u64) -> Result<Self, String> {
        // Get video metadata
        let metadata = get_video_metadata(path)?;

        let width = metadata.width;
        let height = metadata.height;
        let fps = metadata.fps;
        let duration_ms = end_ms.saturating_sub(start_ms);
        let frame_count = ((duration_ms as f64 / 1000.0) * fps).ceil() as u32;
        let frame_size = (width * height * 4) as usize;
        let start_time_secs = start_ms as f64 / 1000.0;

        Ok(Self {
            process: None,
            width,
            height,
            fps,
            duration_ms,
            frame_count,
            current_frame: 0,
            frame_size,
            start_time_secs,
        })
    }

    /// Start the decoder with a single FFmpeg process (async spawn).
    pub fn start(&mut self, path: &Path) -> Result<(), String> {
        let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

        log::info!(
            "[STREAM_DECODER] Starting: {:?} at {:.3}s, {}x{} @ {:.2}fps, {} frames",
            path,
            self.start_time_secs,
            self.width,
            self.height,
            self.fps,
            self.frame_count
        );

        // Build FFmpeg command to output continuous raw RGBA frames
        #[cfg(windows)]
        let process = {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            Command::new(&ffmpeg_path)
                .creation_flags(CREATE_NO_WINDOW)
                .args([
                    "-ss",
                    &format!("{:.3}", self.start_time_secs),
                    "-i",
                    &path.to_string_lossy(),
                    "-frames:v",
                    &self.frame_count.to_string(),
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgba",
                    "-s",
                    &format!("{}x{}", self.width, self.height),
                    "-",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to start FFmpeg: {}", e))?
        };

        #[cfg(not(windows))]
        let process = Command::new(&ffmpeg_path).args([
                "-ss",
                &format!("{:.3}", self.start_time_secs),
                "-i",
                &path.to_string_lossy(),
                "-frames:v",
                &self.frame_count.to_string(),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-s",
                &format!("{}x{}", self.width, self.height),
                "-",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg decoder: {}", e))?;

        self.process = Some(process);
        self.current_frame = 0;

        Ok(())
    }

    /// Read the next frame from the stream (async).
    pub async fn next_frame(&mut self) -> Result<Option<DecodedFrame>, String> {
        let process = self.process.as_mut().ok_or("Decoder not started")?;
        let stdout = process.stdout.as_mut().ok_or("No stdout available")?;

        // Allocate buffer for one frame
        let mut buffer = vec![0u8; self.frame_size];

        // Read exactly one frame using async read_exact
        match stdout.read_exact(&mut buffer).await {
            Ok(_bytes_read) => {
                let frame_number = self.current_frame;
                let timestamp_ms = ((frame_number as f64 / self.fps) * 1000.0) as u64;

                self.current_frame += 1;

                Ok(Some(DecodedFrame {
                    frame_number,
                    timestamp_ms,
                    data: buffer,
                    width: self.width,
                    height: self.height,
                }))
            },
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                // End of stream
                Ok(None)
            },
            Err(e) => Err(format!("Read error: {}", e)),
        }
    }

    /// Stop the decoder and clean up (async).
    pub async fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill().await;
            let _ = process.wait().await;
        }
    }

    /// Get video width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Get video height.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Get video FPS.
    #[allow(dead_code)]
    pub fn fps(&self) -> f64 {
        self.fps
    }

    /// Get total frame count.
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }
}

impl Drop for StreamDecoder {
    fn drop(&mut self) {
        // Sync cleanup - start kill (doesn't wait)
        if let Some(ref mut process) = self.process {
            let _ = process.start_kill();
        }
    }
}

/// Video metadata from ffprobe.
struct VideoMetadata {
    width: u32,
    height: u32,
    fps: f64,
}

/// Get video metadata using ffprobe.
fn get_video_metadata(path: &Path) -> Result<VideoMetadata, String> {
    use crate::commands::video_recording::video_project::VideoMetadata as ProjectMetadata;

    let meta = ProjectMetadata::from_file(path)?;

    Ok(VideoMetadata {
        width: meta.width,
        height: meta.height,
        fps: meta.fps as f64,
    })
}
