//! Webcam video encoder - zero-encode MJPEG passthrough using FFmpeg.
//!
//! If camera outputs MJPEG, we pipe directly to FFmpeg which muxes
//! into a container WITHOUT re-encoding. This is extremely fast.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use super::capture::WEBCAM_BUFFER;

/// Background webcam encoder using FFmpeg MJPEG passthrough.
/// Zero encoding - just muxes JPEG frames into a container.
pub struct BackgroundWebcamEncoder {
    stop_flag: Arc<AtomicBool>,
    thread_handle: Option<JoinHandle<()>>,
    frame_count: Arc<AtomicU64>,
}

impl BackgroundWebcamEncoder {
    /// Start background encoder thread.
    pub fn start(output_path: PathBuf) -> Result<Self, String> {
        // Get dimensions from buffer
        let (width, height) = WEBCAM_BUFFER.dimensions();
        let (width, height) = if width > 0 && height > 0 {
            (width, height)
        } else {
            (1280, 720) // Default fallback
        };

        eprintln!("[WEBCAM_ENC] Starting encoder: {}x{}", width, height);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let frame_count = Arc::new(AtomicU64::new(0));

        let stop_clone = Arc::clone(&stop_flag);
        let count_clone = Arc::clone(&frame_count);

        let handle = thread::Builder::new()
            .name("webcam-encoder".to_string())
            .spawn(move || {
                if let Err(e) =
                    run_ffmpeg_passthrough(&output_path, width, height, &stop_clone, &count_clone)
                {
                    eprintln!("[WEBCAM_ENC] Error: {}", e);
                }
            })
            .map_err(|e| format!("Failed to spawn thread: {}", e))?;

        Ok(Self {
            stop_flag,
            thread_handle: Some(handle),
            frame_count,
        })
    }

    /// Get frame count.
    pub fn frame_count(&self) -> u64 {
        self.frame_count.load(Ordering::Relaxed)
    }

    /// Stop and wait for completion.
    pub fn finish(mut self) -> Result<(), String> {
        self.stop_flag.store(true, Ordering::SeqCst);

        if let Some(handle) = self.thread_handle.take() {
            handle.join().map_err(|_| "Thread panicked")?;
        }

        let frames = self.frame_count.load(Ordering::Relaxed);
        if frames > 0 {
            eprintln!("[WEBCAM_ENC] Encoded {} frames", frames);
        }
        Ok(())
    }
}

/// Run FFmpeg encoder for webcam frames.
fn run_ffmpeg_passthrough(
    output_path: &PathBuf,
    width: u32,
    height: u32,
    stop_flag: &AtomicBool,
    frame_count: &AtomicU64,
) -> Result<(), String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

    // Start FFmpeg process:
    // -f image2pipe: read JPEG images from stdin
    // -c:v libx264: encode to H.264 (good compression, widely compatible)
    // -preset ultrafast: fast encoding for real-time
    // -crf 18: high quality (0-51, lower=better, 18 is visually lossless)
    let mut child = Command::new(&ffmpeg_path)
        .args([
            "-y", // Overwrite output
            "-f",
            "image2pipe", // Input: pipe of images
            "-framerate",
            "30", // Input framerate
            "-i",
            "pipe:0", // Read from stdin
            "-c:v",
            "libx264", // Output codec: H.264
            "-preset",
            "ultrafast", // Fast encoding
            "-crf",
            "18", // High quality
            "-pix_fmt",
            "yuv420p", // Compatible pixel format
            "-movflags",
            "+faststart", // Optimize for playback
        ])
        .arg(output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

    let mut stdin = child.stdin.take().ok_or("Failed to get FFmpeg stdin")?;
    let stderr = child.stderr.take();

    let mut last_frame_id: u64 = 0;

    // Main loop: pipe JPEG frames to FFmpeg
    while !stop_flag.load(Ordering::Relaxed) {
        // Get frame if newer
        let frame = match WEBCAM_BUFFER.get_if_newer(last_frame_id) {
            Some(f) => f,
            None => {
                std::thread::sleep(std::time::Duration::from_millis(1));
                continue;
            }
        };

        last_frame_id = frame.frame_id;

        // Use jpeg_cache (already JPEG, or encoded from BGRA)
        if frame.jpeg_cache.is_empty() {
            continue;
        }

        // Write JPEG to FFmpeg
        if let Err(_) = stdin.write_all(&frame.jpeg_cache) {
            break; // Pipe closed, stop
        }

        frame_count.fetch_add(1, Ordering::Relaxed);
    }

    // Close stdin to signal EOF to FFmpeg
    drop(stdin);

    // Wait for FFmpeg to finish
    let status = child
        .wait()
        .map_err(|e| format!("FFmpeg wait error: {}", e))?;

    // Read stderr for error debugging only
    if !status.success() {
        if let Some(mut stderr_handle) = stderr {
            use std::io::Read;
            let mut stderr_output = String::new();
            let _ = stderr_handle.read_to_string(&mut stderr_output);
            return Err(format!(
                "FFmpeg failed: {}",
                stderr_output.lines().last().unwrap_or("unknown error")
            ));
        }
        return Err(format!("FFmpeg exited with: {}", status));
    }

    Ok(())
}
