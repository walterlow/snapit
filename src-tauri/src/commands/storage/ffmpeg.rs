//! FFmpeg utilities for video processing and thumbnail generation.

use image::DynamicImage;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// Create a Command configured to hide the console window on Windows.
/// This prevents FFmpeg from popping up a black console window during execution.
pub fn create_hidden_command(program: &PathBuf) -> Command {
    let mut cmd = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// Thumbnail size in pixels (longest edge).
pub const THUMBNAIL_SIZE: u32 = 400;

/// Find ffmpeg binary using ffmpeg-sidecar's API with validation.
/// Tests if the binary works, falls back to system PATH if not.
pub fn find_ffmpeg() -> Option<PathBuf> {
    // First try ffmpeg-sidecar's path resolution
    let sidecar_path = ffmpeg_sidecar::paths::ffmpeg_path();

    // Test if it actually works by running -version
    if test_ffmpeg_binary(&sidecar_path) {
        log::debug!("[FFMPEG] Using sidecar path: {}", sidecar_path.display());
        return Some(sidecar_path);
    }

    log::debug!(
        "[FFMPEG] Sidecar path failed ({}), trying system PATH",
        sidecar_path.display()
    );

    // Fall back to system PATH
    let binary_name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    if let Some(path) = find_in_system_path(binary_name) {
        if test_ffmpeg_binary(&path) {
            log::debug!("[FFMPEG] Using system PATH: {}", path.display());
            return Some(path);
        }
    }

    log::warn!("[FFMPEG] No working ffmpeg found");
    None
}

/// Find ffprobe binary using ffmpeg-sidecar's API with validation.
/// Tests if the binary works, falls back to system PATH if not.
pub fn find_ffprobe() -> Option<PathBuf> {
    // First try ffmpeg-sidecar's path resolution
    let sidecar_path = ffmpeg_sidecar::ffprobe::ffprobe_path();

    // Test if it actually works by running -version
    if test_ffprobe_binary(&sidecar_path) {
        log::debug!("[FFPROBE] Using sidecar path: {}", sidecar_path.display());
        return Some(sidecar_path);
    }

    log::debug!(
        "[FFPROBE] Sidecar path failed ({}), trying system PATH",
        sidecar_path.display()
    );

    // Fall back to system PATH
    let binary_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };

    if let Some(path) = find_in_system_path(binary_name) {
        if test_ffprobe_binary(&path) {
            log::debug!("[FFPROBE] Using system PATH: {}", path.display());
            return Some(path);
        }
    }

    log::warn!("[FFPROBE] No working ffprobe found");
    None
}

/// Test if an ffmpeg binary works by running -version
fn test_ffmpeg_binary(path: &PathBuf) -> bool {
    std::process::Command::new(path)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Test if an ffprobe binary works by running -version
fn test_ffprobe_binary(path: &PathBuf) -> bool {
    std::process::Command::new(path)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Find an executable in system PATH
fn find_in_system_path(name: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };

    std::process::Command::new(cmd)
        .arg(name)
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout);
                let first_line = path_str.lines().next()?.trim();
                if !first_line.is_empty() {
                    return Some(PathBuf::from(first_line));
                }
            }
            None
        })
}

/// Get video dimensions using bundled ffprobe.
/// Returns (width, height) if successful.
#[allow(dead_code)]
pub fn get_video_dimensions(video_path: &PathBuf) -> Option<(u32, u32)> {
    let ffprobe_path = find_ffprobe()?;

    let output = create_hidden_command(&ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            &video_path.to_string_lossy().to_string(),
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let output_str = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = output_str.trim().split('x').collect();

    if parts.len() == 2 {
        let width = parts[0].parse::<u32>().ok()?;
        let height = parts[1].parse::<u32>().ok()?;
        Some((width, height))
    } else {
        None
    }
}

/// Generate thumbnail from video file using bundled ffmpeg.
/// Returns the thumbnail path if successful.
pub fn generate_video_thumbnail(
    video_path: &PathBuf,
    thumbnail_path: &PathBuf,
) -> Result<(), String> {
    let ffmpeg_path = find_ffmpeg().ok_or_else(|| "ffmpeg not found".to_string())?;

    // Use ffmpeg to extract a frame at 1 second (or 0 if video is shorter)
    let result = create_hidden_command(&ffmpeg_path)
        .args([
            "-y",
            "-ss",
            "1",
            "-i",
            &video_path.to_string_lossy().to_string(),
            "-vframes",
            "1",
            "-vf",
            &format!("scale={}:-1", THUMBNAIL_SIZE),
            &thumbnail_path.to_string_lossy().to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if result.status.success() {
        return Ok(());
    }

    // Try at 0 seconds if 1 second failed (video might be < 1 second)
    let retry_result = create_hidden_command(&ffmpeg_path)
        .args([
            "-y",
            "-ss",
            "0",
            "-i",
            &video_path.to_string_lossy().to_string(),
            "-vframes",
            "1",
            "-vf",
            &format!("scale={}:-1", THUMBNAIL_SIZE),
            &thumbnail_path.to_string_lossy().to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if retry_result.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&retry_result.stderr);
        Err(format!("ffmpeg failed: {}", stderr))
    }
}

/// Generate thumbnail from GIF using pure Rust (image crate).
/// Extracts the first frame and resizes it.
pub fn generate_gif_thumbnail(gif_path: &PathBuf, thumbnail_path: &PathBuf) -> Result<(), String> {
    // Open the GIF and get the first frame
    let file = fs::File::open(gif_path).map_err(|e| format!("Failed to open GIF: {}", e))?;

    let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Failed to decode GIF: {}", e))?;

    use image::AnimationDecoder;
    let frames = decoder.into_frames();
    let first_frame = frames
        .into_iter()
        .next()
        .ok_or_else(|| "GIF has no frames".to_string())?
        .map_err(|e| format!("Failed to get frame: {}", e))?;

    let image = DynamicImage::ImageRgba8(first_frame.into_buffer());
    let thumbnail = image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);

    thumbnail
        .save(thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    Ok(())
}

/// Generate thumbnail from an image.
pub fn generate_thumbnail(image: &DynamicImage) -> Result<DynamicImage, String> {
    Ok(image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE))
}

/// Get video metadata using ffprobe for migration.
pub fn get_video_metadata_for_migration(
    ffprobe_path: &PathBuf,
    video_path: &PathBuf,
) -> Result<(u32, u32, u64, u32), String> {
    let output = create_hidden_command(ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-select_streams",
            "v:0",
        ])
        .arg(video_path)
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    if !output.status.success() {
        return Err("ffprobe failed".to_string());
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let stream = json["streams"]
        .as_array()
        .and_then(|s| s.first())
        .ok_or("No video stream")?;

    let width = stream["width"].as_u64().unwrap_or(0) as u32;
    let height = stream["height"].as_u64().unwrap_or(0) as u32;

    let duration_secs = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let duration_ms = (duration_secs * 1000.0) as u64;

    let fps_str = stream["r_frame_rate"]
        .as_str()
        .or_else(|| stream["avg_frame_rate"].as_str())
        .unwrap_or("30/1");
    let fps = if let Some((num, den)) = fps_str.split_once('/') {
        let n: f64 = num.parse().unwrap_or(30.0);
        let d: f64 = den.parse().unwrap_or(1.0);
        if d > 0.0 {
            (n / d).round() as u32
        } else {
            30
        }
    } else {
        fps_str.parse::<f64>().unwrap_or(30.0).round() as u32
    };

    Ok((width, height, duration_ms, fps))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test that find_ffmpeg returns a working binary.
    /// This prevents regressions where broken shims are returned instead of real binaries.
    #[test]
    fn test_find_ffmpeg_returns_working_binary() {
        let ffmpeg_path = find_ffmpeg();
        assert!(
            ffmpeg_path.is_some(),
            "find_ffmpeg() should return Some path"
        );

        let path = ffmpeg_path.unwrap();

        // Verify the binary actually works by running -version
        let output = std::process::Command::new(&path)
            .arg("-version")
            .output()
            .expect("Failed to execute ffmpeg");

        assert!(
            output.status.success(),
            "ffmpeg -version should succeed. Path: {}. Stderr: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        );

        // Verify output contains "ffmpeg" to ensure it's the real binary
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.to_lowercase().contains("ffmpeg"),
            "ffmpeg -version output should contain 'ffmpeg'. Got: {}",
            stdout
        );
    }

    /// Test that find_ffprobe returns a working binary.
    /// This prevents regressions where broken shims are returned instead of real binaries.
    #[test]
    fn test_find_ffprobe_returns_working_binary() {
        let ffprobe_path = find_ffprobe();
        assert!(
            ffprobe_path.is_some(),
            "find_ffprobe() should return Some path"
        );

        let path = ffprobe_path.unwrap();

        // Verify the binary actually works by running -version
        let output = std::process::Command::new(&path)
            .arg("-version")
            .output()
            .expect("Failed to execute ffprobe");

        assert!(
            output.status.success(),
            "ffprobe -version should succeed. Path: {}. Stderr: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        );

        // Verify output contains "ffprobe" to ensure it's the real binary
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.to_lowercase().contains("ffprobe"),
            "ffprobe -version output should contain 'ffprobe'. Got: {}",
            stdout
        );
    }

    /// Test that ffmpeg can actually encode video (not just run -version).
    /// Uses testsrc filter to generate a test frame without needing input files.
    #[test]
    fn test_ffmpeg_can_encode() {
        let ffmpeg_path = find_ffmpeg().expect("ffmpeg not found");

        // Generate a single test frame using testsrc filter
        let output = std::process::Command::new(&ffmpeg_path)
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=0.1:size=64x64:rate=1",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-", // Output to null
            ])
            .output()
            .expect("Failed to execute ffmpeg");

        assert!(
            output.status.success(),
            "ffmpeg should be able to encode test video. Stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Test that ffprobe can analyze video streams.
    /// Uses testsrc filter to generate test input without needing files.
    #[test]
    fn test_ffprobe_can_analyze() {
        let ffprobe_path = find_ffprobe().expect("ffprobe not found");

        // Analyze a test source
        let output = std::process::Command::new(&ffprobe_path)
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_streams",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=0.1:size=64x64:rate=1",
            ])
            .output()
            .expect("Failed to execute ffprobe");

        assert!(
            output.status.success(),
            "ffprobe should be able to analyze test source. Stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // Verify we got valid JSON with stream info
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("\"streams\""),
            "ffprobe output should contain streams. Got: {}",
            stdout
        );
    }
}
