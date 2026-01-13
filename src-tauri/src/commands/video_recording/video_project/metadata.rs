//! Video metadata extraction and project loading.

use std::path::PathBuf;

use super::types::{VideoProject, VisibilitySegment};

// ============================================================================
// Video Metadata Extraction (FFmpeg)
// ============================================================================

/// Video metadata extracted from ffprobe.
#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub fps: u32,
}

impl VideoMetadata {
    /// Extract metadata from a video file using ffprobe.
    pub fn from_file(video_path: &std::path::Path) -> Result<Self, String> {
        let ffprobe_path = find_ffprobe()
            .ok_or_else(|| "ffprobe not found. Ensure FFmpeg is installed.".to_string())?;

        let mut cmd = std::process::Command::new(&ffprobe_path);
        cmd.args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-select_streams",
            "v:0",
        ])
        .arg(video_path);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffprobe failed: {}", stderr));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let json: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

        // Extract video stream info
        let stream = json["streams"]
            .as_array()
            .and_then(|s| s.first())
            .ok_or_else(|| "No video stream found".to_string())?;

        let width = stream["width"]
            .as_u64()
            .ok_or_else(|| "Missing width".to_string())? as u32;
        let height = stream["height"]
            .as_u64()
            .ok_or_else(|| "Missing height".to_string())? as u32;

        // Parse frame rate (can be "30/1" or "29.97")
        let fps = parse_frame_rate(
            stream["r_frame_rate"]
                .as_str()
                .or_else(|| stream["avg_frame_rate"].as_str())
                .unwrap_or("30/1"),
        );

        // Get duration from format (more reliable) or stream
        let duration_secs = json["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| {
                stream["duration"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
            })
            .unwrap_or(0.0);

        let duration_ms = (duration_secs * 1000.0) as u64;

        Ok(VideoMetadata {
            width,
            height,
            duration_ms,
            fps,
        })
    }
}

/// Find ffprobe binary (next to ffmpeg).
fn find_ffprobe() -> Option<PathBuf> {
    let binary_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };

    // Check bundled location (next to executable)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled = exe_dir.join(binary_name);
            if bundled.exists() {
                return Some(bundled);
            }
            let resources = exe_dir.join("resources").join(binary_name);
            if resources.exists() {
                return Some(resources);
            }
        }
    }

    // Check ffmpeg-sidecar cache
    if let Ok(sidecar_dir) = ffmpeg_sidecar::paths::sidecar_dir() {
        let cached = sidecar_dir.join(binary_name);
        if cached.exists() {
            return Some(cached);
        }
    }

    // Check system PATH
    let cmd_name = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(cmd_name);
    cmd.arg(binary_name);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let first_line = path_str.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                let path = PathBuf::from(first_line);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    None
}

/// Parse frame rate string like "30/1" or "29.97" to integer FPS.
fn parse_frame_rate(rate: &str) -> u32 {
    if let Some((num, den)) = rate.split_once('/') {
        let num: f64 = num.parse().unwrap_or(30.0);
        let den: f64 = den.parse().unwrap_or(1.0);
        if den > 0.0 {
            return (num / den).round() as u32;
        }
    }
    rate.parse::<f64>().unwrap_or(30.0).round() as u32
}

// ============================================================================
// Project Loading
// ============================================================================

/// Load a VideoProject from a screen recording file or project folder.
///
/// Supports two structures:
/// 1. **New folder structure**: `recording_123456/screen.mp4` with `project.json` alongside
/// 2. **Legacy flat files**: `recording_123456.mp4` with `_webcam.mp4`, `_cursor.json` siblings
///
/// For folder structure:
/// - Loads project.json if it exists
/// - Resolves relative paths to absolute paths
///
/// For legacy structure:
/// - Extracts video metadata using ffprobe
/// - Detects associated files by naming convention
/// - Creates a VideoProject with default configurations
pub fn load_video_project_from_file(video_path: &std::path::Path) -> Result<VideoProject, String> {
    // Check if this is a video inside a project folder
    // (e.g., recording_123456/screen.mp4)
    if let Some(parent) = video_path.parent() {
        let project_json = parent.join("project.json");
        if project_json.exists() {
            // Load from project.json
            return load_video_project_from_folder(parent);
        }
    }

    // Fall back to legacy flat file handling
    load_video_project_legacy(video_path)
}

/// Load a VideoProject from a project folder containing project.json.
/// Resolves relative paths in the project to absolute paths.
fn load_video_project_from_folder(folder_path: &std::path::Path) -> Result<VideoProject, String> {
    let project_json = folder_path.join("project.json");

    let content = std::fs::read_to_string(&project_json)
        .map_err(|e| format!("Failed to read project.json: {}", e))?;

    let mut project: VideoProject = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse project.json: {}", e))?;

    // Resolve relative paths to absolute paths
    // The sources contain relative paths like "screen.mp4", "webcam.mp4", etc.
    // We need to convert them to absolute paths for the video editor to use

    let resolve_path = |relative: &str| -> String {
        let path = folder_path.join(relative);
        path.to_string_lossy().to_string()
    };

    // Resolve screen video path
    project.sources.screen_video = resolve_path(&project.sources.screen_video);

    // Resolve optional paths
    if let Some(ref webcam) = project.sources.webcam_video {
        project.sources.webcam_video = Some(resolve_path(webcam));
    }
    if let Some(ref cursor) = project.sources.cursor_data {
        project.sources.cursor_data = Some(resolve_path(cursor));
    }
    if let Some(ref audio) = project.sources.audio_file {
        project.sources.audio_file = Some(resolve_path(audio));
    }
    if let Some(ref system) = project.sources.system_audio {
        project.sources.system_audio = Some(resolve_path(system));
    }
    if let Some(ref mic) = project.sources.microphone_audio {
        project.sources.microphone_audio = Some(resolve_path(mic));
    }
    if let Some(ref music) = project.sources.background_music {
        project.sources.background_music = Some(resolve_path(music));
    }

    log::info!(
        "[PROJECT] Loaded video project from folder: {:?}",
        folder_path
    );

    Ok(project)
}

/// Load a VideoProject from a legacy flat MP4 file.
/// Detects associated files by naming convention (_webcam.mp4, _cursor.json, etc.)
fn load_video_project_legacy(video_path: &std::path::Path) -> Result<VideoProject, String> {
    // Get video metadata
    let metadata = VideoMetadata::from_file(video_path)?;

    // Create base project
    let video_path_str = video_path.to_string_lossy().to_string();
    let mut project = VideoProject::new(
        &video_path_str,
        metadata.width,
        metadata.height,
        metadata.duration_ms,
        metadata.fps,
    );

    // Check for associated files
    let base_path = video_path.with_extension("");
    let base_str = base_path.to_string_lossy();

    // Check for webcam video (e.g., recording_123456_webcam.mp4)
    let webcam_path = PathBuf::from(format!("{}_webcam.mp4", base_str));
    if webcam_path.exists() {
        project.sources.webcam_video = Some(webcam_path.to_string_lossy().to_string());
        // Enable webcam by default if we have a webcam video
        project.webcam.enabled = true;
        // Default to full visibility
        project.webcam.visibility_segments.push(VisibilitySegment {
            start_ms: 0,
            end_ms: metadata.duration_ms,
            visible: true,
        });
    }

    // Check for cursor data (e.g., recording_123456_cursor.json)
    let cursor_path = PathBuf::from(format!("{}_cursor.json", base_str));
    if cursor_path.exists() {
        project.sources.cursor_data = Some(cursor_path.to_string_lossy().to_string());
    }

    // Check for system audio (e.g., recording_123456_system.wav)
    let system_audio_path = PathBuf::from(format!("{}_system.wav", base_str));
    if system_audio_path.exists() {
        project.sources.system_audio = Some(system_audio_path.to_string_lossy().to_string());
    }

    // Check for microphone audio (e.g., recording_123456_mic.wav)
    let mic_audio_path = PathBuf::from(format!("{}_mic.wav", base_str));
    if mic_audio_path.exists() {
        project.sources.microphone_audio = Some(mic_audio_path.to_string_lossy().to_string());
    }

    Ok(project)
}
