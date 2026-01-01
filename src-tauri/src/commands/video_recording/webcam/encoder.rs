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
        eprintln!("[WEBCAM_ENC] === BackgroundWebcamEncoder::start() ===");

        // Get dimensions from buffer
        let (width, height) = WEBCAM_BUFFER.dimensions();
        eprintln!("[WEBCAM_ENC] Buffer dimensions: {}x{}", width, height);
        eprintln!(
            "[WEBCAM_ENC] Buffer active: {}, frame_id: {}",
            WEBCAM_BUFFER.is_active(),
            WEBCAM_BUFFER.current_frame_id()
        );

        let (width, height) = if width > 0 && height > 0 {
            eprintln!("[WEBCAM_ENC] Using buffer resolution: {}x{}", width, height);
            (width, height)
        } else {
            eprintln!("[WEBCAM_ENC] No dimensions available, using 1280x720");
            (1280, 720)
        };

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

        eprintln!(
            "[WEBCAM_ENC] Finished ({} frames)",
            self.frame_count.load(Ordering::Relaxed)
        );
        Ok(())
    }
}

/// Run FFmpeg with MJPEG passthrough (zero encode).
fn run_ffmpeg_passthrough(
    output_path: &PathBuf,
    width: u32,
    height: u32,
    stop_flag: &AtomicBool,
    frame_count: &AtomicU64,
) -> Result<(), String> {
    eprintln!("[WEBCAM_ENC] === ENCODER THREAD STARTED ===");
    eprintln!(
        "[WEBCAM_ENC] Output: {:?}, size: {}x{}",
        output_path, width, height
    );

    // Check buffer state immediately
    eprintln!(
        "[WEBCAM_ENC] Initial buffer: active={}, frame_id={}, dims={:?}",
        super::capture::WEBCAM_BUFFER.is_active(),
        super::capture::WEBCAM_BUFFER.current_frame_id(),
        super::capture::WEBCAM_BUFFER.dimensions()
    );

    // Get ffmpeg path
    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;
    eprintln!("[WEBCAM_ENC] FFmpeg path: {:?}", ffmpeg_path);

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

    eprintln!("[WEBCAM_ENC] FFmpeg started, entering main loop...");

    let mut last_frame_id: u64 = 0;
    let start = std::time::Instant::now();
    let mut poll_count: u64 = 0;
    let mut last_log_time = start;

    // Main loop: pipe JPEG frames to FFmpeg
    while !stop_flag.load(Ordering::Relaxed) {
        poll_count += 1;

        // Log first 5 polls, then every second
        let now = std::time::Instant::now();
        if poll_count <= 5 || now.duration_since(last_log_time).as_secs() >= 1 {
            last_log_time = now;
            eprintln!(
                "[WEBCAM_ENC] Poll #{}: buffer_id={}, my_last_id={}, active={}, stop={}",
                poll_count,
                WEBCAM_BUFFER.current_frame_id(),
                last_frame_id,
                WEBCAM_BUFFER.is_active(),
                stop_flag.load(Ordering::Relaxed)
            );
        }

        // Get frame if newer
        let frame = match WEBCAM_BUFFER.get_if_newer(last_frame_id) {
            Some(f) => f,
            None => {
                std::thread::sleep(std::time::Duration::from_millis(1));
                continue;
            }
        };

        last_frame_id = frame.frame_id;

        // Log first frame details
        let count = frame_count.load(Ordering::Relaxed);
        if count == 0 {
            eprintln!(
                "[WEBCAM_ENC] First frame received! id={}, jpeg_cache={} bytes, data={} bytes",
                frame.frame_id,
                frame.jpeg_cache.len(),
                frame.data.len()
            );
        }

        // Use jpeg_cache (already JPEG, or encoded from BGRA)
        if frame.jpeg_cache.is_empty() {
            eprintln!(
                "[WEBCAM_ENC] WARNING: Empty jpeg_cache for frame {}",
                frame.frame_id
            );
            continue;
        }

        // Write JPEG directly to FFmpeg (zero encode!)
        if let Err(e) = stdin.write_all(&frame.jpeg_cache) {
            eprintln!("[WEBCAM_ENC] Write error: {}", e);
            break;
        }

        let new_count = frame_count.fetch_add(1, Ordering::Relaxed) + 1;

        if new_count == 1 || new_count % 60 == 0 {
            eprintln!(
                "[WEBCAM_ENC] Piped {} frames ({:.1}s)",
                new_count,
                start.elapsed().as_secs_f64()
            );
        }
    }

    // Close stdin to signal EOF to FFmpeg
    drop(stdin);

    // Wait for FFmpeg to finish
    eprintln!("[WEBCAM_ENC] Waiting for FFmpeg to finish...");
    let status = child
        .wait()
        .map_err(|e| format!("FFmpeg wait error: {}", e))?;

    // Read stderr for debugging
    if let Some(mut stderr_handle) = stderr {
        use std::io::Read;
        let mut stderr_output = String::new();
        if stderr_handle.read_to_string(&mut stderr_output).is_ok() && !stderr_output.is_empty() {
            eprintln!("[WEBCAM_ENC] FFmpeg stderr: {}", stderr_output.trim());
        }
    }

    if !status.success() {
        return Err(format!("FFmpeg exited with: {}", status));
    }

    eprintln!("[WEBCAM_ENC] FFmpeg finished successfully");
    Ok(())
}
