//! Helper functions for video recording.
//!
//! Includes video validation, audio muxing, sync utilities, window helpers,
//! and project file creation.

use std::path::PathBuf;

use super::super::video_project::VideoProject;
use super::super::RecordingMode;

// ============================================================================
// Video Fast Start (moov atom relocation)
// ============================================================================

/// Relocate the moov atom to the start of an MP4 file for faster streaming.
/// This allows browsers to start playing immediately without downloading the entire file.
pub fn make_video_faststart(video_path: &PathBuf) -> Result<(), String> {
    if !video_path.exists() {
        return Err(format!(
            "Video file does not exist: {}",
            video_path.to_string_lossy()
        ));
    }

    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or_else(|| "FFmpeg not found - cannot make faststart".to_string())?;

    let temp_path = video_path.with_extension("faststart_temp.mp4");

    log::info!(
        "[FASTSTART] Relocating moov atom for: {}",
        video_path.to_string_lossy()
    );

    let output = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
        .args([
            "-y",
            "-i",
            &video_path.to_string_lossy(),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            &temp_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg for faststart: {}", e))?;

    if output.status.success() {
        // Replace original with faststart version
        std::fs::remove_file(video_path)
            .map_err(|e| format!("Failed to remove original video: {}", e))?;
        std::fs::rename(&temp_path, video_path)
            .map_err(|e| format!("Failed to rename faststart video: {}", e))?;
        log::info!("[FASTSTART] Successfully relocated moov atom");
        Ok(())
    } else {
        let _ = std::fs::remove_file(&temp_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("FFmpeg faststart failed: {}", stderr))
    }
}

// ============================================================================
// Video Validation
// ============================================================================

/// Validate that a video file is properly formed (has moov atom for MP4).
/// Returns Ok(()) if valid, Err with message if corrupted.
pub fn validate_video_file(path: &PathBuf) -> Result<(), String> {
    // Only validate MP4 files
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if extension != "mp4" {
        return Ok(()); // Skip validation for non-MP4 files
    }

    // Check if file exists
    if !path.exists() {
        return Err(format!(
            "Video file does not exist: {}",
            path.to_string_lossy()
        ));
    }

    // Check file size
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    log::debug!(
        "[VALIDATION] Checking video file: {} ({} bytes)",
        path.to_string_lossy(),
        file_size
    );

    if file_size == 0 {
        return Err("Video file is empty (0 bytes)".to_string());
    }

    // Find ffprobe
    let ffprobe_path = crate::commands::storage::find_ffprobe()
        .ok_or_else(|| "ffprobe not available for validation".to_string())?;
    log::info!(
        "[VALIDATION] Using ffprobe: {}",
        ffprobe_path.to_string_lossy()
    );

    // Run ffprobe to check if file is valid
    // A corrupted MP4 (missing moov atom) will fail with an error
    let output = crate::commands::storage::ffmpeg::create_hidden_command(&ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path.to_string_lossy().to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        log::error!(
            "[VALIDATION] ffprobe failed - exit code: {:?}, stdout: '{}', stderr: '{}'",
            output.status.code(),
            stdout.trim(),
            stderr.trim()
        );
        // Check for common corruption indicators
        if stderr.contains("moov atom not found")
            || stderr.contains("Invalid data found")
            || stderr.contains("could not find codec parameters")
        {
            return Err(format!("Video file is corrupted: {}", stderr.trim()));
        }
        return Err(format!(
            "Video validation failed (exit code {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    // Check that we got a valid duration
    let stdout = String::from_utf8_lossy(&output.stdout);
    let duration_str = stdout.trim();
    if duration_str.is_empty() || duration_str == "N/A" {
        return Err("Video file has no valid duration (likely corrupted)".to_string());
    }

    log::debug!(
        "[VALIDATION] Video file is valid, duration: {}s",
        duration_str
    );
    Ok(())
}

// ============================================================================
// Audio Helpers
// ============================================================================

/// Mux audio WAV file(s) with video MP4 using FFmpeg.
///
/// This is called post-recording to combine the video-only MP4 (from windows-capture)
/// with the perfect WAV audio files (from MultiTrackAudioRecorder).
///
/// The windows-capture encoder introduces audio jitter, so we bypass it entirely
/// and use FFmpeg for audio encoding (AAC) which produces clean, jitter-free audio.
///
/// # Arguments
/// * `video_path` - Path to the video-only MP4 file (will be replaced with muxed version)
/// * `system_audio_path` - Path to system audio WAV file (optional)
/// * `mic_audio_path` - Path to microphone WAV file (optional)
///
/// # Returns
/// Ok(()) if muxing succeeded, Err with message if failed.
pub fn mux_audio_to_video(
    video_path: &PathBuf,
    system_audio_path: Option<&PathBuf>,
    mic_audio_path: Option<&PathBuf>,
) -> Result<(), String> {
    let has_system = system_audio_path.map(|p| p.exists()).unwrap_or(false);
    let has_mic = mic_audio_path.map(|p| p.exists()).unwrap_or(false);

    if !has_system && !has_mic {
        return Ok(());
    }

    // Check video file exists and log size
    if !video_path.exists() {
        return Err(format!(
            "Video file does not exist for muxing: {}",
            video_path.to_string_lossy()
        ));
    }
    let video_size = std::fs::metadata(video_path).map(|m| m.len()).unwrap_or(0);
    log::debug!(
        "[MUX] Starting audio mux for {} ({} bytes)",
        video_path.to_string_lossy(),
        video_size
    );

    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or_else(|| "FFmpeg not found - cannot mux audio".to_string())?;
    log::info!("[MUX] Using ffmpeg: {}", ffmpeg_path.to_string_lossy());

    let temp_video_path = video_path.with_extension("video_only.mp4");

    std::fs::rename(video_path, &temp_video_path)
        .map_err(|e| format!("Failed to rename video for muxing: {}", e))?;

    let result = if has_system && has_mic {
        let system_path = system_audio_path.unwrap();
        let mic_path = mic_audio_path.unwrap();

        crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
            .args([
                "-y",
                "-i",
                &temp_video_path.to_string_lossy(),
                "-i",
                &system_path.to_string_lossy(),
                "-i",
                &mic_path.to_string_lossy(),
                "-filter_complex",
                "[1:a][2:a]amix=inputs=2:duration=longest[aout]",
                "-map",
                "0:v",
                "-map",
                "[aout]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                &video_path.to_string_lossy(),
            ])
            .output()
    } else if has_system {
        let system_path = system_audio_path.unwrap();

        crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
            .args([
                "-y",
                "-i",
                &temp_video_path.to_string_lossy(),
                "-i",
                &system_path.to_string_lossy(),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                &video_path.to_string_lossy(),
            ])
            .output()
    } else {
        let mic_path = mic_audio_path.unwrap();

        crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
            .args([
                "-y",
                "-i",
                &temp_video_path.to_string_lossy(),
                "-i",
                &mic_path.to_string_lossy(),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                &video_path.to_string_lossy(),
            ])
            .output()
    };

    match result {
        Ok(output) => {
            if output.status.success() {
                log::debug!("[MUX] Audio muxing succeeded");
                let _ = std::fs::remove_file(&temp_video_path);
                if let Some(path) = system_audio_path {
                    let _ = std::fs::remove_file(path);
                }
                if let Some(path) = mic_audio_path {
                    let _ = std::fs::remove_file(path);
                }
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                log::error!(
                    "[MUX] FFmpeg failed - exit code: {:?}, stdout: '{}', stderr: '{}'",
                    output.status.code(),
                    stdout.trim(),
                    stderr.trim()
                );
                // Restore original video file
                if let Err(rename_err) = std::fs::rename(&temp_video_path, video_path) {
                    log::error!(
                        "[MUX] Failed to restore video file after mux failure: {}",
                        rename_err
                    );
                }
                Err(format!(
                    "FFmpeg muxing failed (exit {:?}): {}",
                    output.status.code(),
                    stderr.trim()
                ))
            }
        },
        Err(e) => {
            log::error!("[MUX] Failed to run FFmpeg: {}", e);
            // Restore original video file
            if let Err(rename_err) = std::fs::rename(&temp_video_path, video_path) {
                log::error!(
                    "[MUX] Failed to restore video file after mux failure: {}",
                    rename_err
                );
            }
            Err(format!("Failed to run FFmpeg: {}", e))
        },
    }
}

// ============================================================================
// Sync Helpers
// ============================================================================

/// Sync webcam video duration to match screen video duration.
/// Uses FFmpeg to stretch or pad the webcam video.
#[allow(dead_code)]
pub fn sync_webcam_to_screen_duration(
    screen_path: &PathBuf,
    webcam_path: &PathBuf,
) -> Result<(), String> {
    let ffprobe_path = crate::commands::storage::find_ffprobe().ok_or("ffprobe not found")?;
    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("ffmpeg not found")?;

    // Get screen video duration
    let screen_duration = get_video_duration(&ffprobe_path, screen_path)?;
    let webcam_duration = get_video_duration(&ffprobe_path, webcam_path)?;

    // If webcam is within 100ms of screen, no sync needed
    let diff = (screen_duration - webcam_duration).abs();
    if diff < 0.1 {
        return Ok(());
    }

    log::debug!(
        "[SYNC] Adjusting webcam: {:.3}s -> {:.3}s",
        webcam_duration,
        screen_duration
    );

    // Create temp file for synced webcam
    let synced_path = webcam_path.with_extension("synced.mp4");

    // Use setpts filter to stretch/compress webcam to match screen duration
    // PTS * (target_duration / current_duration) adjusts playback speed
    let speed_factor = webcam_duration / screen_duration;
    let pts_filter = format!("setpts={}*PTS", speed_factor);

    let output = crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
        .args([
            "-y",
            "-i",
            &webcam_path.to_string_lossy(),
            "-vf",
            &pts_filter,
            "-an", // No audio in webcam
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
        ])
        .arg(&synced_path)
        .output()
        .map_err(|e| format!("FFmpeg failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg sync failed: {}", stderr));
    }

    // Replace original webcam with synced version
    std::fs::remove_file(webcam_path)
        .map_err(|e| format!("Failed to remove original webcam: {}", e))?;
    std::fs::rename(&synced_path, webcam_path)
        .map_err(|e| format!("Failed to rename synced webcam: {}", e))?;

    Ok(())
}

/// Get video duration in seconds using ffprobe.
pub fn get_video_duration(ffprobe_path: &PathBuf, video_path: &PathBuf) -> Result<f64, String> {
    let output = std::process::Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(video_path)
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    if !output.status.success() {
        return Err("ffprobe failed to get duration".to_string());
    }

    let duration_str = String::from_utf8_lossy(&output.stdout);
    duration_str
        .trim()
        .parse::<f64>()
        .map_err(|_| "Failed to parse duration".to_string())
}

// ============================================================================
// Window Helpers
// ============================================================================

/// Get window bounds using Windows API.
/// Returns (x, y, width, height) of the window's visible bounds.
#[cfg(target_os = "windows")]
pub fn get_window_rect(window_id: u32) -> Result<(i32, i32, u32, u32), String> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{IsIconic, IsWindowVisible},
    };

    unsafe {
        let hwnd = HWND(window_id as *mut std::ffi::c_void);

        // Check if window is visible and not minimized
        if !IsWindowVisible(hwnd).as_bool() {
            return Err("Window is not visible".to_string());
        }

        if IsIconic(hwnd).as_bool() {
            return Err("Window is minimized".to_string());
        }

        // Get window bounds using DWM (excludes shadow, includes titlebar)
        let mut rect = RECT::default();
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .map_err(|e| format!("Failed to get window bounds: {:?}", e))?;

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;

        if width < 10 || height < 10 {
            return Err("Window is too small".to_string());
        }

        Ok((rect.left, rect.top, width, height))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_window_rect(_window_id: u32) -> Result<(i32, i32, u32, u32), String> {
    Err("Window capture not supported on this platform".to_string())
}

/// Convert Window mode to Region mode by getting window bounds.
/// Only used for modes that don't support native window capture.
#[allow(dead_code)]
pub fn resolve_window_to_region(mode: &RecordingMode) -> Result<RecordingMode, String> {
    match mode {
        RecordingMode::Window { window_id } => {
            let (x, y, width, height) = get_window_rect(*window_id)?;
            Ok(RecordingMode::Region {
                x,
                y,
                width,
                height,
            })
        },
        other => Ok(other.clone()),
    }
}

/// Check if mode is Window capture (for native window recording).
pub fn is_window_mode(mode: &RecordingMode) -> Option<u32> {
    match mode {
        RecordingMode::Window { window_id } => Some(*window_id),
        _ => None,
    }
}

// ============================================================================
// Video Project Creation
// ============================================================================

/// Create a project.json file in the video project folder.
///
/// This creates the VideoProject metadata file that allows the video editor
/// to load and edit the recording with all its associated files.
pub fn create_video_project_file(
    project_folder: &PathBuf,
    width: u32,
    height: u32,
    duration_ms: u64,
    fps: u32,
    has_webcam: bool,
    has_cursor_data: bool,
    has_system_audio: bool,
    has_mic_audio: bool,
) -> Result<(), String> {
    // Create the VideoProject with relative paths (files are in the same folder)
    let screen_video = "screen.mp4".to_string();

    let mut project = VideoProject::new(&screen_video, width, height, duration_ms, fps);

    // Set project name from folder name
    if let Some(folder_name) = project_folder.file_name() {
        project.name = folder_name.to_string_lossy().to_string();
    }

    // Update sources with relative paths for files that exist
    if has_webcam {
        project.sources.webcam_video = Some("webcam.mp4".to_string());
        project.webcam.enabled = true;
    }

    if has_cursor_data {
        project.sources.cursor_data = Some("cursor.json".to_string());
    }

    // Add audio file paths (editor flow keeps separate audio files)
    if has_system_audio {
        project.sources.system_audio = Some("system.wav".to_string());
    }

    if has_mic_audio {
        project.sources.microphone_audio = Some("mic.wav".to_string());
    }

    // Save project.json to the folder
    let project_file = project_folder.join("project.json");
    project.save(&project_file)?;

    log::info!("[PROJECT] Created project.json in {:?}", project_folder);

    Ok(())
}
