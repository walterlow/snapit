//! Video frame extraction and caching.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lazy_static::lazy_static;
use std::collections::HashMap;
use std::sync::Mutex;

// ============================================================================
// Video Frame Extraction (FFmpeg)
// ============================================================================

/// Extract a single frame from a video at the specified timestamp.
///
/// Returns the frame as a base64-encoded JPEG string suitable for display in img tags.
///
/// # Arguments
/// * `video_path` - Path to the video file
/// * `timestamp_ms` - Timestamp in milliseconds to extract the frame from
/// * `max_width` - Optional maximum width to scale down to (maintains aspect ratio)
///
/// # Returns
/// Base64-encoded JPEG image data (without data URI prefix)
pub fn extract_video_frame(
    video_path: &std::path::Path,
    timestamp_ms: u64,
    max_width: Option<u32>,
) -> Result<String, String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or_else(|| "FFmpeg not found. Ensure FFmpeg is installed.".to_string())?;

    // Convert milliseconds to FFmpeg time format (HH:MM:SS.mmm)
    let total_secs = timestamp_ms as f64 / 1000.0;
    let hours = (total_secs / 3600.0).floor() as u32;
    let minutes = ((total_secs % 3600.0) / 60.0).floor() as u32;
    let seconds = total_secs % 60.0;
    let timestamp = format!("{:02}:{:02}:{:06.3}", hours, minutes, seconds);

    // Build FFmpeg command
    let mut args = vec![
        "-ss".to_string(),
        timestamp, // Seek to timestamp (before input for speed)
        "-i".to_string(),
        video_path.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(), // Extract only 1 frame
        "-f".to_string(),
        "image2pipe".to_string(), // Output to pipe
        "-c:v".to_string(),
        "mjpeg".to_string(), // JPEG codec
        "-q:v".to_string(),
        "5".to_string(), // Quality (2-31, lower is better)
    ];

    // Add scale filter if max_width specified
    if let Some(width) = max_width {
        args.extend([
            "-vf".to_string(),
            format!("scale='min({},iw)':-1", width), // Scale down if wider than max
        ]);
    }

    args.push("-".to_string()); // Output to stdout

    let output = std::process::Command::new(&ffmpeg_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg frame extraction failed: {}", stderr));
    }

    if output.stdout.is_empty() {
        return Err("FFmpeg produced no output".to_string());
    }

    // Encode as base64
    let base64_data = BASE64.encode(&output.stdout);
    Ok(base64_data)
}

// ============================================================================
// Frame Cache
// ============================================================================

/// Cache entry for a video frame
#[derive(Clone)]
struct FrameCacheEntry {
    data: String, // Base64 JPEG data
    timestamp_ms: u64,
}

lazy_static! {
    /// Global frame cache - maps video_path -> (timestamp -> frame_data)
    static ref FRAME_CACHE: Mutex<HashMap<String, Vec<FrameCacheEntry>>> = Mutex::new(HashMap::new());
}

/// Maximum frames to cache per video
const MAX_FRAMES_PER_VIDEO: usize = 60;

/// Get a frame from cache or extract it
pub fn get_video_frame_cached(
    video_path: &std::path::Path,
    timestamp_ms: u64,
    max_width: Option<u32>,
    tolerance_ms: u64,
) -> Result<String, String> {
    let path_str = video_path.to_string_lossy().to_string();

    // Check cache first
    {
        let cache = FRAME_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(frames) = cache.get(&path_str) {
            // Find frame within tolerance
            for entry in frames {
                let diff = if entry.timestamp_ms > timestamp_ms {
                    entry.timestamp_ms - timestamp_ms
                } else {
                    timestamp_ms - entry.timestamp_ms
                };
                if diff <= tolerance_ms {
                    return Ok(entry.data.clone());
                }
            }
        }
    }

    // Extract new frame
    let frame_data = extract_video_frame(video_path, timestamp_ms, max_width)?;

    // Add to cache
    {
        let mut cache = FRAME_CACHE.lock().map_err(|e| e.to_string())?;
        let frames = cache.entry(path_str).or_insert_with(Vec::new);

        // Remove oldest frame if at capacity
        if frames.len() >= MAX_FRAMES_PER_VIDEO {
            frames.remove(0);
        }

        frames.push(FrameCacheEntry {
            data: frame_data.clone(),
            timestamp_ms,
        });
    }

    Ok(frame_data)
}

/// Clear frame cache for a specific video or all videos
pub fn clear_frame_cache(video_path: Option<&std::path::Path>) {
    if let Ok(mut cache) = FRAME_CACHE.lock() {
        if let Some(path) = video_path {
            cache.remove(&path.to_string_lossy().to_string());
        } else {
            cache.clear();
        }
    }
}
