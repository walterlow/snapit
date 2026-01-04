//! Core video recording implementation.
//!
//! Uses windows-capture's DXGI Duplication API for frame capture
//! and VideoEncoder for hardware-accelerated MP4 encoding.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ============================================================================
// Frame Buffer Pool - Reuses buffers to avoid per-frame allocations
// ============================================================================

/// Pre-allocated buffer pool for frame capture to avoid allocations in the hot loop.
///
/// The capture loop needs several buffers per frame:
/// - `frame_buffer`: Working copy for cursor/webcam compositing
/// - `flip_buffer`: Vertically flipped output for encoder
///
/// Note: DXGI's `as_nopadding_buffer` requires a fresh Vec each call, so we can't
/// pool that allocation. But we still save allocations on frame_buffer and flip_buffer.
struct FrameBufferPool {
    /// Buffer for compositing operations (cursor, webcam)
    frame_buffer: Vec<u8>,
    /// Buffer for vertical flip before encoding
    flip_buffer: Vec<u8>,
    /// Expected frame size in bytes (width * height * 4)
    frame_size: usize,
}

impl FrameBufferPool {
    /// Create a new buffer pool pre-sized for the given dimensions.
    fn new(width: u32, height: u32) -> Self {
        let frame_size = (width as usize) * (height as usize) * 4;
        Self {
            frame_buffer: vec![0u8; frame_size],
            flip_buffer: vec![0u8; frame_size],
            frame_size,
        }
    }

    /// Flip frame_buffer vertically into flip_buffer and return reference.
    fn flip_vertical(&mut self, width: u32, height: u32) -> &[u8] {
        let row_size = (width as usize) * 4;
        let total_size = row_size * (height as usize);

        // Flip from frame_buffer to flip_buffer
        for (i, row) in self.frame_buffer[..total_size]
            .chunks_exact(row_size)
            .enumerate()
        {
            let dest_row = height as usize - 1 - i;
            let dest_start = dest_row * row_size;
            self.flip_buffer[dest_start..dest_start + row_size].copy_from_slice(row);
        }

        &self.flip_buffer[..total_size]
    }
}

use crossbeam_channel::{Receiver, TryRecvError};
use tauri::AppHandle;
use windows_capture::{
    dxgi_duplication_api::DxgiDuplicationApi,
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
        VideoSettingsSubType,
    },
    monitor::Monitor,
};

use super::audio_multitrack::MultiTrackAudioRecorder;
use super::cursor::{save_cursor_recording, CursorEventCapture};
use super::desktop_icons::{hide_desktop_icons, show_desktop_icons};
use super::gif_encoder::GifRecorder;
use super::state::{RecorderCommand, RecordingProgress, RECORDING_CONTROLLER};
use super::video_project::VideoProject;
use super::webcam::{stop_capture_service, WebcamEncoderPipe};
use super::wgc_capture::WgcVideoCapture;
use super::{
    emit_state_change, get_webcam_settings, RecordingFormat, RecordingMode, RecordingSettings,
    RecordingState,
};

// ============================================================================
// Video Validation
// ============================================================================

/// Validate that a video file is properly formed (has moov atom for MP4).
/// Returns Ok(()) if valid, Err with message if corrupted.
fn validate_video_file(path: &PathBuf) -> Result<(), String> {
    // Only validate MP4 files
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if extension != "mp4" {
        return Ok(()); // Skip validation for non-MP4 files
    }

    // Find ffprobe
    let ffprobe_path = crate::commands::storage::find_ffprobe()
        .ok_or_else(|| "ffprobe not available for validation".to_string())?;

    // Run ffprobe to check if file is valid
    // A corrupted MP4 (missing moov atom) will fail with an error
    let output = std::process::Command::new(&ffprobe_path)
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
        // Check for common corruption indicators
        if stderr.contains("moov atom not found")
            || stderr.contains("Invalid data found")
            || stderr.contains("could not find codec parameters")
        {
            return Err(format!("Video file is corrupted: {}", stderr.trim()));
        }
        return Err(format!("Video validation failed: {}", stderr.trim()));
    }

    // Check that we got a valid duration
    let stdout = String::from_utf8_lossy(&output.stdout);
    let duration_str = stdout.trim();
    if duration_str.is_empty() || duration_str == "N/A" {
        return Err("Video file has no valid duration (likely corrupted)".to_string());
    }

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
fn mux_audio_to_video(
    video_path: &PathBuf,
    system_audio_path: Option<&PathBuf>,
    mic_audio_path: Option<&PathBuf>,
) -> Result<(), String> {
    let has_system = system_audio_path.map(|p| p.exists()).unwrap_or(false);
    let has_mic = mic_audio_path.map(|p| p.exists()).unwrap_or(false);

    if !has_system && !has_mic {
        return Ok(());
    }

    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or_else(|| "FFmpeg not found - cannot mux audio".to_string())?;

    let temp_video_path = video_path.with_extension("video_only.mp4");

    std::fs::rename(video_path, &temp_video_path)
        .map_err(|e| format!("Failed to rename video for muxing: {}", e))?;

    let result = if has_system && has_mic {
        let system_path = system_audio_path.unwrap();
        let mic_path = mic_audio_path.unwrap();

        std::process::Command::new(&ffmpeg_path)
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

        std::process::Command::new(&ffmpeg_path)
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

        std::process::Command::new(&ffmpeg_path)
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
                log::error!("[MUX] FFmpeg failed: {}", stderr);
                let _ = std::fs::rename(&temp_video_path, video_path);
                Err(format!("FFmpeg muxing failed: {}", stderr))
            }
        },
        Err(e) => {
            log::error!("[MUX] Failed to run FFmpeg: {}", e);
            let _ = std::fs::rename(&temp_video_path, video_path);
            Err(format!("Failed to run FFmpeg: {}", e))
        },
    }
}

// ============================================================================
// DXGI Recovery Helpers
// ============================================================================

/// Capture backend abstraction.
///
/// Allows switching between DXGI and WGC capture methods.
enum CaptureBackend {
    /// DXGI Desktop Duplication (preferred, lower latency)
    Dxgi(DxgiDuplicationApi),
    /// Windows Graphics Capture (fallback, more compatible)
    Wgc(WgcVideoCapture),
}

impl CaptureBackend {
    fn width(&self) -> u32 {
        match self {
            CaptureBackend::Dxgi(dxgi) => dxgi.width(),
            CaptureBackend::Wgc(wgc) => wgc.width(),
        }
    }

    fn height(&self) -> u32 {
        match self {
            CaptureBackend::Dxgi(dxgi) => dxgi.height(),
            CaptureBackend::Wgc(wgc) => wgc.height(),
        }
    }

    fn name(&self) -> &'static str {
        match self {
            CaptureBackend::Dxgi(_) => "DXGI",
            CaptureBackend::Wgc(_) => "WGC",
        }
    }
}

/// Result of trying to acquire a frame from the capture backend.
enum FrameAcquireResult {
    /// Successfully acquired a frame
    Frame(Vec<u8>),
    /// No frame available (timeout)
    Timeout,
    /// GPU device was lost - should switch to WGC
    DeviceLost,
    /// Other error
    Error(String),
}

/// Try to switch from DXGI to WGC capture backend.
fn switch_to_wgc(monitor_index: usize, include_cursor: bool) -> Result<CaptureBackend, String> {
    log::warn!("[CAPTURE] GPU device lost, switching to WGC fallback");

    let wgc = WgcVideoCapture::new(monitor_index, include_cursor)
        .map_err(|e| format!("Failed to create WGC capture: {}", e))?;

    Ok(CaptureBackend::Wgc(wgc))
}

// ============================================================================
// Window Helpers
// ============================================================================

/// Get window bounds using Windows API.
/// Returns (x, y, width, height) of the window's visible bounds.
#[cfg(target_os = "windows")]
fn get_window_rect(window_id: u32) -> Result<(i32, i32, u32, u32), String> {
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
fn get_window_rect(_window_id: u32) -> Result<(i32, i32, u32, u32), String> {
    Err("Window capture not supported on this platform".to_string())
}

/// Convert Window mode to Region mode by getting window bounds.
/// Only used for modes that don't support native window capture.
fn resolve_window_to_region(mode: &RecordingMode) -> Result<RecordingMode, String> {
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
fn is_window_mode(mode: &RecordingMode) -> Option<u32> {
    match mode {
        RecordingMode::Window { window_id } => Some(*window_id),
        _ => None,
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Start a new recording.
pub async fn start_recording(
    app: AppHandle,
    settings: RecordingSettings,
    output_path: PathBuf,
) -> Result<(), String> {
    log::debug!(
        "[RECORDING] Starting: format={:?}, countdown={}",
        settings.format,
        settings.countdown_secs
    );

    let (progress, command_rx) = {
        let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
        controller.start(settings.clone(), output_path.clone())?
    };

    // Note: Webcam and screen capture are pre-warmed when toolbar appears.
    // See prewarm_capture() in mod.rs

    // Handle countdown
    if settings.countdown_secs > 0 {
        let app_clone = app.clone();
        let settings_clone = settings.clone();
        let output_path_clone = output_path.clone();
        let progress_clone = Arc::clone(&progress);
        let command_rx_clone = command_rx.clone();

        // Use tauri's async runtime instead of tokio::spawn to ensure the task
        // persists even when called from a temporary runtime (like in trigger_capture)
        tauri::async_runtime::spawn(async move {
            // Brief delay to allow countdown window to initialize its event listener
            // Without this, the first countdown event (3) may be emitted before the window is ready
            tokio::time::sleep(Duration::from_millis(150)).await;

            for i in (1..=settings_clone.countdown_secs).rev() {
                // Check for stop/cancel commands during countdown
                match command_rx_clone.try_recv() {
                    Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                        if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                            controller.reset();
                        }
                        emit_state_change(&app_clone, &RecordingState::Idle);
                        return;
                    },
                    _ => {},
                }

                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.update_countdown(i);
                }

                emit_state_change(
                    &app_clone,
                    &RecordingState::Countdown {
                        seconds_remaining: i,
                    },
                );

                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            // Final check before starting recording
            match command_rx_clone.try_recv() {
                Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.reset();
                    }
                    emit_state_change(&app_clone, &RecordingState::Idle);
                    return;
                },
                _ => {},
            }

            // Start actual recording
            if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                controller.start_actual_recording();
            }

            // Emit recording state IMMEDIATELY for instant UI feedback (optimistic UI)
            // Border shows right away, init happens in background
            let started_at = chrono::Local::now().to_rfc3339();
            emit_state_change(
                &app_clone,
                &RecordingState::Recording {
                    started_at: started_at.clone(),
                    elapsed_secs: 0.0,
                    frame_count: 0,
                },
            );

            // Start capture in background thread
            start_capture_thread(
                app_clone,
                settings_clone,
                output_path_clone,
                progress_clone,
                command_rx_clone,
                started_at,
            );
        });
    } else {
        // No countdown, start immediately
        // Emit recording state IMMEDIATELY for instant UI feedback
        let started_at = chrono::Local::now().to_rfc3339();
        emit_state_change(
            &app,
            &RecordingState::Recording {
                started_at: started_at.clone(),
                elapsed_secs: 0.0,
                frame_count: 0,
            },
        );

        start_capture_thread(app, settings, output_path, progress, command_rx, started_at);
    }

    Ok(())
}

/// Start the capture thread based on recording mode and format.
fn start_capture_thread(
    app: AppHandle,
    settings: RecordingSettings,
    output_path: PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
    started_at: String,
) {
    let app_clone = app.clone();
    let output_path_clone = output_path.clone();

    let _handle = std::thread::spawn(move || {
        // Hide desktop icons if enabled (will be restored when recording ends)
        hide_desktop_icons();

        // Catch any panics to ensure we log them
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Window mode is now handled natively by WGC in run_video_capture/run_gif_capture
            // No need to resolve to region mode anymore

            let result = match settings.format {
                RecordingFormat::Mp4 => run_video_capture(
                    &app,
                    &settings,
                    &output_path,
                    progress.clone(),
                    command_rx,
                    &started_at,
                ),
                RecordingFormat::Gif => run_gif_capture(
                    &app,
                    &settings,
                    &output_path,
                    progress.clone(),
                    command_rx,
                    &started_at,
                ),
            };

            // Check if recording was cancelled
            let was_cancelled = RECORDING_CONTROLLER
                .lock()
                .map(|c| {
                    c.active
                        .as_ref()
                        .map(|a| a.progress.was_cancelled())
                        .unwrap_or(false)
                })
                .unwrap_or(false);

            if was_cancelled {
                let _ = std::fs::remove_file(&output_path_clone);
                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.reset();
                }
                emit_state_change(&app_clone, &RecordingState::Idle);
                return;
            }

            // Handle result
            match result {
                Ok(recording_duration) => {
                    // Validate the video file to ensure it's not corrupted
                    // This catches issues like missing moov atom from improper shutdown
                    if let Err(validation_error) = validate_video_file(&output_path_clone) {
                        log::error!("[RECORDING] Video validation failed: {}", validation_error);
                        // Delete the corrupted file
                        let _ = std::fs::remove_file(&output_path_clone);
                        // Emit error state
                        let error_msg = format!("Recording failed: {}", validation_error);
                        if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                            controller.set_error(error_msg.clone());
                        }
                        emit_state_change(
                            &app_clone,
                            &RecordingState::Error { message: error_msg },
                        );
                        return;
                    }

                    let file_size = std::fs::metadata(&output_path_clone)
                        .map(|m| m.len())
                        .unwrap_or(0);

                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.complete(
                            output_path_clone.to_string_lossy().to_string(),
                            recording_duration,
                            file_size,
                        );
                    }

                    emit_state_change(
                        &app_clone,
                        &RecordingState::Completed {
                            output_path: output_path_clone.to_string_lossy().to_string(),
                            duration_secs: recording_duration,
                            file_size_bytes: file_size,
                        },
                    );
                },
                Err(e) => {
                    log::error!("[RECORDING] Failed: {}", e);
                    // Also try to clean up any partial file on error
                    let _ = std::fs::remove_file(&output_path_clone);
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.set_error(e.clone());
                    }
                    emit_state_change(&app_clone, &RecordingState::Error { message: e });
                },
            }
        })); // End of catch_unwind

        // Handle panics
        if let Err(panic_info) = result {
            let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic".to_string()
            };
            log::error!("[RECORDING] Capture thread panicked: {}", panic_msg);
            if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                controller.set_error(format!("Capture thread panicked: {}", panic_msg));
            }
            emit_state_change(
                &app_clone,
                &RecordingState::Error {
                    message: format!("Capture thread panicked: {}", panic_msg),
                },
            );
        }

        // Always restore desktop icons when recording ends (success, error, or panic)
        show_desktop_icons();
    });
}

/// Run video (MP4) capture using DXGI Duplication API.
///
/// For MP4, `output_path` is a project folder containing:
///   - screen.mp4 (main recording)
///   - webcam.mp4 (optional)
///   - cursor.json (optional)
///   - project.json (video project metadata, created after recording)
///
/// Returns the actual recording duration in seconds.
fn run_video_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
    started_at: &str,
) -> Result<f64, String> {
    log::debug!(
        "[CAPTURE] Starting video capture, mode={:?}, quick_capture={}",
        settings.mode,
        settings.quick_capture
    );

    // Determine video output path based on capture mode:
    // - Quick capture: output_path IS the final MP4 file
    // - Editor flow: output_path is a folder, video goes to screen.mp4 inside
    let screen_video_path = if settings.quick_capture {
        output_path.clone()
    } else {
        output_path.join("screen.mp4")
    };

    // === WEBCAM OUTPUT PATH ===
    // Webcam is only supported in editor flow (not quick capture).
    // Webcam capture service is already running (pre-warmed during countdown).
    let webcam_output_path: Option<PathBuf> = if !settings.quick_capture {
        let webcam_enabled = get_webcam_settings().map(|s| s.enabled).unwrap_or(false);
        if webcam_enabled {
            Some(output_path.join("webcam.mp4"))
        } else {
            None
        }
    } else {
        // Quick capture: no webcam support
        None
    };

    // Check if this is Window mode (native window capture via WGC)
    let window_id = is_window_mode(&settings.mode);

    // Get crop region if in region mode (not used for Window mode)
    let crop_region = match &settings.mode {
        RecordingMode::Region {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Get monitor index for potential WGC fallback (not used for Window mode)
    let monitor_index = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => *monitor_index,
        RecordingMode::Region { x, y, .. } => {
            // Find monitor that contains this region's top-left corner
            if let Ok(monitors) = xcap::Monitor::all() {
                let mut found_idx = 0;
                for (idx, m) in monitors.iter().enumerate() {
                    let mx = m.x().unwrap_or(0);
                    let my = m.y().unwrap_or(0);
                    let mw = m.width().unwrap_or(0) as i32;
                    let mh = m.height().unwrap_or(0) as i32;
                    if *x >= mx && *x < mx + mw && *y >= my && *y < my + mh {
                        found_idx = idx;
                        break;
                    }
                }
                found_idx
            } else {
                0
            }
        },
        _ => 0,
    };

    // Create capture backend based on mode
    // For WGC window capture, we need to wait for the first frame to get accurate dimensions
    // (window rect may differ from actual capture due to DPI scaling on multi-monitor setups)
    let (mut capture, first_wgc_frame) = if let Some(wid) = window_id {
        let wgc = WgcVideoCapture::new_window(wid, settings.include_cursor)
            .map_err(|e| format!("Failed to create WGC window capture: {}", e))?;

        // Wait for first frame to get actual dimensions (important for DPI scaling)
        let first_frame = wgc.wait_for_first_frame(1000);
        (CaptureBackend::Wgc(wgc), first_frame)
    } else {
        // Monitor/Region mode: use DXGI with WGC fallback
        let monitor = match &settings.mode {
            RecordingMode::Monitor { monitor_index } => {
                let monitors = Monitor::enumerate()
                    .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
                monitors
                    .get(*monitor_index)
                    .ok_or("Monitor not found")?
                    .clone()
            },
            _ => Monitor::primary().map_err(|e| format!("Failed to get primary monitor: {}", e))?,
        };

        // Create DXGI duplication session (will fallback to WGC if needed)
        let dxgi = DxgiDuplicationApi::new(monitor)
            .map_err(|e| format!("Failed to create DXGI duplication: {:?}", e))?;

        (CaptureBackend::Dxgi(dxgi), None)
    };

    // Get capture dimensions - for WGC window capture, use actual frame dimensions
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else if let Some((w, h, _)) = &first_wgc_frame {
        // Use actual frame dimensions from WGC (handles DPI scaling correctly)
        (*w, *h)
    } else {
        (capture.width(), capture.height())
    };

    let bitrate = settings.calculate_bitrate(width, height);
    let max_duration = settings
        .max_duration_secs
        .map(|s| Duration::from_secs(s as u64));

    // Determine if we need audio
    let _capture_audio =
        settings.audio.capture_system_audio || settings.audio.microphone_device_index.is_some();

    // Create video encoder with audio enabled if needed
    // Use H.264 codec for better browser/WebView compatibility (HEVC requires paid extension)
    let video_settings = VideoSettingsBuilder::new(width, height)
        .sub_type(VideoSettingsSubType::H264)
        .bitrate(bitrate)
        .frame_rate(settings.fps);

    // ALWAYS disable audio in VideoEncoder - windows-capture's MediaTranscoder
    // introduces audio jitter. Instead, we use MultiTrackAudioRecorder to capture
    // perfect WAV files, then mux with FFmpeg post-recording.
    let audio_settings = AudioSettingsBuilder::default().disabled(true);

    let mut encoder = VideoEncoder::new(
        video_settings,
        audio_settings,
        ContainerSettingsBuilder::default(),
        &screen_video_path,
    )
    .map_err(|e| format!("Failed to create encoder: {:?}", e))?;

    // === SHARED CONTROL FLAGS ===
    let should_stop = Arc::new(AtomicBool::new(false));
    let is_paused = Arc::new(AtomicBool::new(false));

    // NOTE: Cursor is now captured via CursorEventCapture (events + images)
    // and rendered by the video editor/exporter - not composited during recording.

    // === WEBCAM ENCODER SETUP ===
    // Try to use pre-spawned FFmpeg pipe (from prepare_recording).
    // Falls back to spawning new one if not available.
    let mut webcam_pipe: Option<WebcamEncoderPipe> = if webcam_output_path.is_some() {
        use super::take_prepared_webcam_pipe;
        use super::webcam::WEBCAM_BUFFER;

        // Quick check if webcam is ready (should be, since we pre-warmed)
        if WEBCAM_BUFFER.current_frame_id() == 0 {
            let deadline = Instant::now() + Duration::from_millis(100);
            while Instant::now() < deadline && WEBCAM_BUFFER.current_frame_id() == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        // Try to use pre-spawned pipe first (instant!)
        if let Some(pipe) = take_prepared_webcam_pipe() {
            Some(pipe)
        } else if let Some(ref webcam_path) = webcam_output_path {
            // Fallback: spawn new FFmpeg (slower)
            log::debug!("[WEBCAM] No prepared pipe, spawning FFmpeg now");
            match WebcamEncoderPipe::new(webcam_path.clone()) {
                Ok(pipe) => Some(pipe),
                Err(e) => {
                    log::warn!("Webcam encoder failed: {}", e);
                    stop_capture_service();
                    None
                },
            }
        } else {
            None
        }
    } else {
        None
    };

    // === MULTI-TRACK AUDIO RECORDING ===
    // Record system audio and microphone to separate WAV files for later mixing.
    // This enables independent volume control in the video editor.
    // Use shared flags so pause/resume affects multi-track audio too.
    let mut multitrack_audio =
        MultiTrackAudioRecorder::with_flags(Arc::clone(&should_stop), Arc::clone(&is_paused));
    // Audio files go inside the project folder
    let (system_audio_path, mic_audio_path) = {
        let system_path = if settings.audio.capture_system_audio {
            Some(output_path.join("system.wav"))
        } else {
            None
        };

        let mic_path = if settings.audio.microphone_device_index.is_some() {
            Some(output_path.join("mic.wav"))
        } else {
            None
        };

        (system_path, mic_path)
    };

    // Start multi-track audio recording
    if system_audio_path.is_some() || mic_audio_path.is_some() {
        if let Err(e) = multitrack_audio.start(system_audio_path.clone(), mic_audio_path.clone()) {
            log::warn!("Failed to start multi-track audio: {}", e);
        }
    }

    // === CURSOR EVENT CAPTURE ===
    // Record cursor positions and clicks for auto-zoom in video editor.
    // Only used in editor flow (not quick capture) since cursor is baked into video for quick capture.
    let mut cursor_event_capture = CursorEventCapture::new();
    let cursor_data_path = if !settings.quick_capture {
        Some(output_path.join("cursor.json"))
    } else {
        None
    };

    // Get region for cursor capture (if region mode)
    let cursor_region = match &settings.mode {
        RecordingMode::Region {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Only start cursor capture for editor flow
    if !settings.quick_capture {
        if let Err(e) = cursor_event_capture.start(cursor_region) {
            log::warn!("Failed to start cursor event capture: {}", e);
        }
    }

    // Pre-allocate frame buffers to avoid per-frame allocations
    let mut buffer_pool = FrameBufferPool::new(width, height);

    // Recording loop variables
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let mut frame_count: u64 = 0;
    let mut paused = false;
    let mut pause_time = Duration::ZERO;
    let mut pause_start: Option<Instant> = None;

    // === START RECORDING ===
    // Recording state was already emitted before thread started (optimistic UI)
    log::debug!(
        "[RECORDING] Capture loop starting: {}x{} @ {}fps, webcam={}",
        width,
        height,
        settings.fps,
        webcam_pipe.is_some()
    );
    let start_time = Instant::now();
    let mut last_frame_time = start_time;

    // If we captured a first frame for dimension detection, use it as the first recorded frame
    let mut pending_first_frame: Option<Vec<u8>> = first_wgc_frame.map(|(_, _, f)| f.data);

    loop {
        // Check for commands
        match command_rx.try_recv() {
            Ok(RecorderCommand::Stop) => {
                should_stop.store(true, Ordering::SeqCst);
                break;
            },
            Ok(RecorderCommand::Cancel) => {
                should_stop.store(true, Ordering::SeqCst);
                progress.mark_cancelled();
                break;
            },
            Ok(RecorderCommand::Pause) => {
                if !paused {
                    paused = true;
                    pause_start = Some(Instant::now());
                    progress.set_paused(true);
                    is_paused.store(true, Ordering::SeqCst);
                }
            },
            Ok(RecorderCommand::Resume) => {
                if paused {
                    if let Some(ps) = pause_start.take() {
                        pause_time += ps.elapsed();
                    }
                    paused = false;
                    progress.set_paused(false);
                    is_paused.store(false, Ordering::SeqCst);
                }
            },
            Err(TryRecvError::Empty) => {},
            Err(TryRecvError::Disconnected) => {
                should_stop.store(true, Ordering::SeqCst);
                break;
            },
        }

        // Skip frame capture while paused
        if paused {
            match command_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(RecorderCommand::Resume) => {
                    if let Some(ps) = pause_start.take() {
                        pause_time += ps.elapsed();
                    }
                    paused = false;
                    progress.set_paused(false);
                    is_paused.store(false, Ordering::SeqCst);
                },
                Ok(RecorderCommand::Stop) => {
                    should_stop.store(true, Ordering::SeqCst);
                    break;
                },
                Ok(RecorderCommand::Cancel) => {
                    should_stop.store(true, Ordering::SeqCst);
                    progress.mark_cancelled();
                    break;
                },
                Ok(RecorderCommand::Pause) => {}, // Already paused, ignore
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}, // Normal timeout, continue loop
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    should_stop.store(true, Ordering::SeqCst);
                    break;
                },
            }
            continue;
        }

        // Check max duration
        let actual_elapsed = start_time.elapsed() - pause_time;
        if let Some(max_dur) = max_duration {
            if actual_elapsed >= max_dur {
                should_stop.store(true, Ordering::SeqCst);
                break;
            }
        }

        // Frame rate limiting - sleep for remaining time instead of busy-waiting
        let elapsed_since_frame = last_frame_time.elapsed();
        if elapsed_since_frame < frame_duration {
            let remaining = frame_duration - elapsed_since_frame;
            // Sleep for most of the remaining time, leaving a small margin for timing accuracy
            if remaining > Duration::from_micros(500) {
                std::thread::sleep(remaining - Duration::from_micros(500));
            }
            continue;
        }

        // Acquire next frame from capture backend (DXGI or WGC) into buffer pool
        let frame_acquired = match &mut capture {
            CaptureBackend::Dxgi(dxgi) => {
                match dxgi.acquire_next_frame(100) {
                    Ok(mut frame) => {
                        // Get frame buffer (with optional crop)
                        let buffer_result = if let Some((x, y, w, h)) = crop_region {
                            let start_x = x.max(0) as u32;
                            let start_y = y.max(0) as u32;
                            let end_x = start_x + w;
                            let end_y = start_y + h;
                            frame.buffer_crop(start_x, start_y, end_x, end_y)
                        } else {
                            frame.buffer()
                        };

                        match buffer_result {
                            Ok(buffer) => {
                                // Use a temporary Vec for DXGI extraction (as_nopadding_buffer has specific requirements)
                                // Then copy to the pooled frame_buffer for compositing
                                let mut raw_data = Vec::new();
                                let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);
                                let len = pixel_data.len().min(buffer_pool.frame_size);
                                buffer_pool.frame_buffer[..len].copy_from_slice(&pixel_data[..len]);
                                true
                            },
                            Err(e) => {
                                let err_str = format!("{:?}", e);
                                if err_str.contains("0x887A0005")
                                    || err_str.contains("DEVICE_REMOVED")
                                    || err_str.contains("suspended")
                                {
                                    // GPU device lost - switch to WGC
                                    match switch_to_wgc(monitor_index, settings.include_cursor) {
                                        Ok(new_backend) => {
                                            capture = new_backend;
                                            continue;
                                        },
                                        Err(e) => {
                                            return Err(format!(
                                                "DXGI failed and WGC fallback also failed: {}",
                                                e
                                            ));
                                        },
                                    }
                                } else {
                                    false
                                }
                            },
                        }
                    },
                    Err(windows_capture::dxgi_duplication_api::Error::Timeout) => false,
                    Err(windows_capture::dxgi_duplication_api::Error::AccessLost) => {
                        match switch_to_wgc(monitor_index, settings.include_cursor) {
                            Ok(new_backend) => {
                                capture = new_backend;
                                continue;
                            },
                            Err(e) => {
                                return Err(format!(
                                    "DXGI access lost and WGC fallback failed: {}",
                                    e
                                ));
                            },
                        }
                    },
                    Err(e) => {
                        let err_str = format!("{:?}", e);
                        if err_str.contains("0x887A0005") || err_str.contains("DEVICE_REMOVED") {
                            match switch_to_wgc(monitor_index, settings.include_cursor) {
                                Ok(new_backend) => {
                                    capture = new_backend;
                                    continue;
                                },
                                Err(e) => {
                                    return Err(format!(
                                        "DXGI error and WGC fallback failed: {}",
                                        e
                                    ));
                                },
                            }
                        } else {
                            std::thread::sleep(Duration::from_millis(50));
                            false
                        }
                    },
                }
            },
            CaptureBackend::Wgc(wgc) => {
                // WGC frame acquisition - use pending first frame if available, else get new one
                let frame_data = if let Some(data) = pending_first_frame.take() {
                    Some(data)
                } else {
                    wgc.get_frame(100).map(|f| f.data)
                };

                match frame_data {
                    Some(data) => {
                        let len = data.len().min(buffer_pool.frame_size);
                        buffer_pool.frame_buffer[..len].copy_from_slice(&data[..len]);
                        true
                    },
                    None => false, // Timeout or no frame
                }
            },
        };

        // Skip if no frame was acquired
        if !frame_acquired {
            continue;
        }

        last_frame_time = Instant::now();

        // NOTE: Cursor is NO LONGER composited onto frames!
        // Cursor events and images are captured separately (CursorEventCapture)
        // and rendered by the video editor/exporter for flexibility.
        // This allows: cursor type switching, motion blur, physics smoothing, etc.

        // NOTE: Webcam is recorded to a separate file (not composited onto screen)
        // This allows toggling webcam visibility in the video editor

        // Flip vertically using pooled buffer (both DXGI and WGC return top-down, encoder expects bottom-up)
        let flipped_data = buffer_pool.flip_vertical(width, height);

        // Get video timestamp
        let video_timestamp = (actual_elapsed.as_micros() * 10) as i64;

        // Send video frame to encoder
        let _ = encoder.send_frame_buffer(flipped_data, video_timestamp);

        // Audio is NOT sent to encoder - see comment at audio_settings creation.
        // MultiTrackAudioRecorder handles WAV capture, FFmpeg muxes post-recording.

        // === WEBCAM FRAME (synchronized with screen frame) ===
        // Write webcam frame for each screen frame - ensures 1:1 correspondence
        if let Some(ref mut pipe) = webcam_pipe {
            pipe.write_frame();
        }

        frame_count += 1;
        progress.increment_frame();

        // Emit progress periodically
        if frame_count % 30 == 0 {
            emit_state_change(
                app,
                &RecordingState::Recording {
                    started_at: started_at.to_string(),
                    elapsed_secs: actual_elapsed.as_secs_f64(),
                    frame_count,
                },
            );
        }
    }

    // Calculate recording stats
    let total_elapsed = start_time.elapsed();
    let recording_duration = total_elapsed - pause_time;
    let webcam_frames = webcam_pipe
        .as_ref()
        .map(|p| p.frames_written())
        .unwrap_or(0);
    log::debug!(
        "[RECORDING] Complete: {:.2}s, {} frames ({:.1} fps), webcam: {} frames",
        recording_duration.as_secs_f64(),
        frame_count,
        frame_count as f64 / recording_duration.as_secs_f64(),
        webcam_frames
    );

    // Check if recording was cancelled
    let was_cancelled = progress.was_cancelled();

    // Finish webcam encoder BEFORE stopping capture service
    // Pass the actual recording duration so webcam syncs perfectly with screen
    if let Some(pipe) = webcam_pipe {
        if was_cancelled {
            pipe.cancel();
            if let Some(ref path) = webcam_output_path {
                let _ = std::fs::remove_file(path);
            }
        } else if let Err(e) = pipe.finish_with_duration(recording_duration.as_secs_f64()) {
            log::warn!("Webcam encoding failed: {}", e);
        }
    }

    // Stop capture services
    stop_capture_service();
    let _ = multitrack_audio.stop();
    let cursor_recording = cursor_event_capture.stop();

    // If cancelled, skip main encoder
    if was_cancelled {
        drop(encoder);
        return Ok(recording_duration.as_secs_f64());
    }

    // Save cursor data (editor flow only)
    if !settings.quick_capture {
        if let Some(ref path) = cursor_data_path {
            if !cursor_recording.events.is_empty() {
                let _ = save_cursor_recording(&cursor_recording, path);
            }
        }
    }

    // Finish main video encoder (video-only, no audio)
    encoder
        .finish()
        .map_err(|e| format!("Failed to finish encoding: {:?}", e))?;

    // Mux audio with video using FFmpeg (bypasses windows-capture audio jitter)
    if let Err(e) = mux_audio_to_video(
        &screen_video_path,
        system_audio_path.as_ref(),
        mic_audio_path.as_ref(),
    ) {
        log::warn!("Audio muxing failed: {}", e);
    }

    // NOTE: Webcam sync is now handled in finish_with_duration() above.
    // The webcam encoder remuxes with correct FPS to match screen duration.

    // Create project.json with video project metadata (editor flow only)
    if !settings.quick_capture {
        create_video_project_file(
            output_path,
            width,
            height,
            recording_duration.as_millis() as u64,
            settings.fps,
            webcam_output_path.is_some(),
            cursor_data_path
                .as_ref()
                .map(|_| !cursor_recording.events.is_empty())
                .unwrap_or(false),
        )?;
    }

    Ok(recording_duration.as_secs_f64())
}

/// Sync webcam video duration to match screen video duration.
/// Uses FFmpeg to stretch or pad the webcam video.
fn sync_webcam_to_screen_duration(
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

    let output = std::process::Command::new(&ffmpeg_path)
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
fn get_video_duration(ffprobe_path: &PathBuf, video_path: &PathBuf) -> Result<f64, String> {
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

/// Run GIF capture using WGC (Windows Graphics Capture).
/// Fast async capture at 30+ FPS for smooth GIFs.
/// Run GIF capture using WGC.
/// Returns the actual recording duration in seconds.
fn run_gif_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
    started_at: &str,
) -> Result<f64, String> {
    log::debug!("[GIF] Starting capture, mode={:?}", settings.mode);

    // Check if this is Window mode (native window capture via WGC)
    let window_id = is_window_mode(&settings.mode);

    // Get crop region if in region mode (not used for Window mode)
    let crop_region = match &settings.mode {
        RecordingMode::Region {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Determine monitor index and offset for Region mode
    // We need the monitor offset to convert screen-space crop coords to monitor-local coords
    let (monitor_index, monitor_offset) = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => (*monitor_index, (0, 0)),
        RecordingMode::Region { x, y, .. } => {
            // Find monitor that contains this region's top-left corner
            if let Ok(monitors) = xcap::Monitor::all() {
                let mut found_idx = 0;
                let mut offset = (0i32, 0i32);
                for (idx, m) in monitors.iter().enumerate() {
                    let mx = m.x().unwrap_or(0);
                    let my = m.y().unwrap_or(0);
                    let mw = m.width().unwrap_or(0) as i32;
                    let mh = m.height().unwrap_or(0) as i32;
                    if *x >= mx && *x < mx + mw && *y >= my && *y < my + mh {
                        found_idx = idx;
                        offset = (mx, my);
                        break;
                    }
                }
                (found_idx, offset)
            } else {
                (0, (0, 0))
            }
        },
        _ => (0, (0, 0)),
    };

    // Start WGC capture based on mode
    // For window capture, wait for first frame to ensure capture is ready
    let (wgc, first_frame_dims) = if let Some(wid) = window_id {
        log::debug!("[GIF] Using window capture for hwnd={}", wid);
        let wgc = WgcVideoCapture::new_window(wid, settings.include_cursor)
            .map_err(|e| format!("Failed to start WGC window capture: {}", e))?;

        // Wait for first frame to get actual dimensions (important for DPI scaling)
        let first_frame = wgc.wait_for_first_frame(1000);
        if first_frame.is_none() {
            log::warn!("[GIF] Timeout waiting for first frame from window capture");
        }
        let dims = first_frame.as_ref().map(|(w, h, _)| (*w, *h));
        (wgc, dims)
    } else {
        // Monitor/Region mode: use monitor capture with correct monitor
        log::debug!("[GIF] Using monitor capture, index={}", monitor_index);
        let wgc = WgcVideoCapture::new(monitor_index, settings.include_cursor)
            .map_err(|e| format!("Failed to start WGC capture: {}", e))?;
        (wgc, None)
    };

    // Get capture dimensions - prefer first frame dims for window capture (DPI accuracy)
    let (capture_width, capture_height) =
        first_frame_dims.unwrap_or_else(|| (wgc.width(), wgc.height()));
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else {
        (capture_width, capture_height)
    };

    let max_duration = settings
        .max_duration_secs
        .map(|s| Duration::from_secs(s as u64));
    let max_frames = settings.fps as usize * settings.max_duration_secs.unwrap_or(30) as usize;

    // Create GIF recorder
    let recorder = Arc::new(Mutex::new(GifRecorder::new(
        width,
        height,
        settings.fps,
        settings.gif_quality_preset,
        max_frames,
    )));

    // Recording loop - consume frames from WGC as they arrive
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let frame_timeout_ms = (frame_duration.as_millis() as u64).max(50);

    // Recording state was already emitted before thread started (optimistic UI)
    let start_time = Instant::now();
    let mut last_frame_time = start_time;

    loop {
        // Check for commands
        match command_rx.try_recv() {
            Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                if matches!(command_rx.try_recv(), Ok(RecorderCommand::Cancel)) {
                    progress.mark_cancelled();
                }
                break;
            },
            _ => {},
        }

        // Check max duration
        let elapsed = start_time.elapsed();
        if let Some(max_dur) = max_duration {
            if elapsed >= max_dur {
                break;
            }
        }

        // Wait until it's time for the next frame
        let now = Instant::now();
        let time_since_last = now.duration_since(last_frame_time);
        if time_since_last < frame_duration {
            let sleep_time = frame_duration - time_since_last;
            std::thread::sleep(sleep_time);
        }

        // Drain channel to get the most recent frame (skip stale frames)
        let mut frame = match wgc.get_frame(frame_timeout_ms) {
            Some(f) => f,
            None => continue,
        };

        // Keep draining to get the freshest frame
        while let Some(newer_frame) = wgc.try_get_frame() {
            frame = newer_frame;
        }

        last_frame_time = Instant::now();

        // WGC returns BGRA - keep it as BGRA, FFmpeg will handle it
        let bgra_data = frame.data;

        // Crop if needed - convert screen-space coords to monitor-local coords
        let final_data = if let Some((screen_x, screen_y, w, h)) = crop_region {
            // Subtract monitor offset to get monitor-local coordinates
            let local_x = (screen_x - monitor_offset.0).max(0) as u32;
            let local_y = (screen_y - monitor_offset.1).max(0) as u32;
            let mut cropped = Vec::with_capacity((w * h * 4) as usize);

            // Skip if crop region is outside frame bounds
            if local_x < frame.width && local_y < frame.height {
                let available_width = frame.width.saturating_sub(local_x);
                let crop_w = w.min(available_width);

                for row in local_y..(local_y + h).min(frame.height) {
                    let start = ((row * frame.width + local_x) * 4) as usize;
                    let end = ((row * frame.width + local_x + crop_w) * 4) as usize;
                    if start < bgra_data.len() && end <= bgra_data.len() {
                        cropped.extend_from_slice(&bgra_data[start..end]);
                    }
                }
            }
            cropped
        } else {
            bgra_data
        };

        // Add frame with actual elapsed timestamp
        let timestamp = elapsed.as_secs_f64();
        if let Ok(mut rec) = recorder.lock() {
            rec.add_frame(final_data, width, height, timestamp);
        }

        progress.increment_frame();

        let frame_count = progress.get_frame_count();
        if frame_count % 30 == 0 {
            emit_state_change(
                app,
                &RecordingState::Recording {
                    started_at: started_at.to_string(),
                    elapsed_secs: elapsed.as_secs_f64(),
                    frame_count,
                },
            );
        }
    }

    // Stop WGC capture
    wgc.stop();

    // Capture duration before any post-processing
    let recording_duration = start_time.elapsed().as_secs_f64();

    // Check if cancelled
    if progress.was_cancelled() {
        return Ok(recording_duration); // Return duration even if cancelled
    }

    // Encode GIF
    emit_state_change(app, &RecordingState::Processing { progress: 0.0 });

    let total_duration = start_time.elapsed();
    let recorder_guard = recorder.lock().map_err(|_| "Failed to lock recorder")?;
    let frame_count = recorder_guard.frame_count();

    log::debug!(
        "[GIF] Capture complete: {} frames in {:.2}s ({:.1} fps)",
        frame_count,
        total_duration.as_secs_f64(),
        frame_count as f64 / total_duration.as_secs_f64()
    );

    if frame_count == 0 {
        return Err("No frames captured".to_string());
    }

    let app_clone = app.clone();
    recorder_guard
        .encode_to_file(output_path, move |encoding_progress| {
            emit_state_change(
                &app_clone,
                &RecordingState::Processing {
                    progress: encoding_progress,
                },
            );
        })
        .map_err(|e| format!("Failed to encode GIF: {}", e))?;

    Ok(recording_duration)
}

/// Stop the current recording.
///
/// This sends the stop command and returns immediately.
/// The UI immediately transitions to "Processing" state (optimistic update).
/// The actual completion is signaled via the 'recording-state-changed' event
/// when the state becomes Completed or Error.
pub async fn stop_recording(app: AppHandle) -> Result<(), String> {
    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !controller.is_active() {
        return Err("No recording in progress".to_string());
    }

    controller.send_command(RecorderCommand::Stop)?;

    // Immediately emit Processing state so UI feels responsive
    // Timer stops, user sees "Saving..." or similar
    emit_state_change(&app, &RecordingState::Processing { progress: 0.0 });

    Ok(())
}

/// Cancel the current recording.
pub async fn cancel_recording(_app: AppHandle) -> Result<(), String> {
    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !controller.is_active() {
        return Err("No recording in progress".to_string());
    }

    controller.send_command(RecorderCommand::Cancel)?;
    Ok(())
}

/// Pause the current recording.
pub async fn pause_recording(app: AppHandle) -> Result<(), String> {
    let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !matches!(controller.state, RecordingState::Recording { .. }) {
        return Err("No active recording to pause".to_string());
    }

    if let Some(ref settings) = controller.settings {
        if settings.format == RecordingFormat::Gif {
            return Err("GIF recording cannot be paused".to_string());
        }
    }

    controller.send_command(RecorderCommand::Pause)?;
    controller.set_paused(true);
    emit_state_change(&app, &controller.state);

    Ok(())
}

/// Resume a paused recording.
pub async fn resume_recording(app: AppHandle) -> Result<(), String> {
    let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !matches!(controller.state, RecordingState::Paused { .. }) {
        return Err("No paused recording to resume".to_string());
    }

    controller.send_command(RecorderCommand::Resume)?;
    controller.set_paused(false);
    emit_state_change(&app, &controller.state);

    Ok(())
}

// ============================================================================
// Video Project Creation
// ============================================================================

/// Create a project.json file in the video project folder.
///
/// This creates the VideoProject metadata file that allows the video editor
/// to load and edit the recording with all its associated files.
fn create_video_project_file(
    project_folder: &PathBuf,
    width: u32,
    height: u32,
    duration_ms: u64,
    fps: u32,
    has_webcam: bool,
    has_cursor_data: bool,
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

    // Save project.json to the folder
    let project_file = project_folder.join("project.json");
    project.save(&project_file)?;

    log::info!("[PROJECT] Created project.json in {:?}", project_folder);

    Ok(())
}
