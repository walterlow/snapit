//! Video and GIF recording module.
//!
//! This module provides screen recording capabilities with the following features:
//! - MP4 video recording with H.264 encoding via Windows Media Foundation
//! - High-quality GIF recording with FFmpeg
//! - Region, window, monitor, and all-monitors capture modes
//! - Optional system audio and microphone capture
//! - Configurable FPS (10-60) and quality settings
//!
//! Video Editor features:
//! - Cursor event capture for auto-zoom
//! - Separate webcam recording for post-editing
//! - Video project management with zoom/cursor/webcam configuration
//!
//! ## Architecture
//!
//! ```text
//! mod.rs (public API, commands)
//!   |
//!   +-- types.rs (RecordingFormat, RecordingSettings, etc.)
//!   +-- recorder.rs (core recording logic)
//!   +-- state.rs (RecordingController state machine)
//!   +-- webcam/ (webcam capture and encoding)
//!   +-- cursor/ (cursor event capture)
//!   +-- audio*.rs (audio capture modules)
//!   +-- video_project.rs (project management)
//!   +-- video_export.rs (export pipeline)
//!   +-- gpu_editor.rs (GPU-accelerated editing)
//! ```

pub mod audio;
pub mod audio_monitor;
pub mod audio_multitrack;
pub mod audio_sync;
pub mod audio_wasapi;
pub mod cursor;
pub mod desktop_icons;
pub mod ffmpeg_gif_encoder;
pub mod gif_encoder;
pub mod gpu_editor;
pub mod master_clock;
pub mod recorder;
pub mod state;
pub mod types;
pub mod video_export;
pub mod video_project;
pub mod webcam;
pub mod wgc_capture;

use lazy_static::lazy_static;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager};

// ============================================================================
// Re-exports
// ============================================================================

// Types (from types.rs)
pub use types::{
    AudioInputDevice, RecordingFormat, RecordingMode, RecordingSettings, RecordingState,
    RecordingStatus, StartRecordingResult,
};
// StopRecordingResult is available via types:: but not re-exported (unused)

// Recording state
pub use ffmpeg_gif_encoder::GifQualityPreset;
pub use state::RECORDING_CONTROLLER;

// Webcam config - re-export only what's actually used
pub use crate::config::webcam::{get_webcam_settings, WebcamSize, WEBCAM_CONFIG};

// Video editor types
pub use cursor::CursorRecording;
pub use video_export::ExportResult;
pub use video_project::{
    apply_auto_zoom_to_project, clear_frame_cache, get_video_frame_cached,
    load_video_project_from_file, AudioWaveform, AutoZoomConfig, VideoProject,
};

// GPU-accelerated editor
pub use gpu_editor::EditorState;

// Webcam device listing
pub use webcam::{get_webcam_devices, WebcamDevice};

/// Get available webcam devices.
#[command]
pub fn list_webcam_devices() -> Result<Vec<WebcamDevice>, String> {
    get_webcam_devices()
}

// ============================================================================
// Capture Pre-warming
// ============================================================================

use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;

/// Pre-spawned webcam encoder pipe, ready to receive frames.
/// Created during prewarm, used when recording starts.
static PREPARED_WEBCAM_PIPE: OnceLock<StdMutex<Option<webcam::WebcamEncoderPipe>>> =
    OnceLock::new();

/// Pre-generated output path for the next recording.
static PREPARED_OUTPUT_PATH: OnceLock<StdMutex<Option<std::path::PathBuf>>> = OnceLock::new();

fn get_prepared_webcam_pipe() -> &'static StdMutex<Option<webcam::WebcamEncoderPipe>> {
    PREPARED_WEBCAM_PIPE.get_or_init(|| StdMutex::new(None))
}

fn get_prepared_output_path() -> &'static StdMutex<Option<std::path::PathBuf>> {
    PREPARED_OUTPUT_PATH.get_or_init(|| StdMutex::new(None))
}

/// Take the pre-spawned webcam pipe if available.
pub fn take_prepared_webcam_pipe() -> Option<webcam::WebcamEncoderPipe> {
    get_prepared_webcam_pipe().lock().ok()?.take()
}

/// Take the pre-generated output path if available.
pub fn take_prepared_output_path() -> Option<std::path::PathBuf> {
    get_prepared_output_path().lock().ok()?.take()
}

/// Pre-warm capture resources when toolbar is shown.
/// This initializes webcam and screen capture so recording starts instantly.
#[command]
pub fn prewarm_capture() -> Result<(), String> {
    log::info!("[PREWARM] Pre-warming capture resources...");

    // Pre-warm webcam if enabled
    let webcam_config = WEBCAM_CONFIG.read();
    let webcam_enabled = webcam_config.enabled;
    let device_index = webcam_config.device_index;
    drop(webcam_config); // Release lock before potentially slow operations

    if webcam_enabled {
        if !webcam::is_capture_running() {
            log::info!(
                "[PREWARM] Starting webcam capture (device {})",
                device_index
            );
            if let Err(e) = webcam::start_capture_service(device_index) {
                log::warn!("[PREWARM] Webcam pre-warm failed: {}", e);
            }
        } else {
            log::info!("[PREWARM] Webcam already running");
        }
    }

    // Pre-warm screen capture (DXGI) - load DLLs in background
    log::info!("[PREWARM] Touching DXGI...");
    std::thread::spawn(|| {
        use windows_capture::monitor::Monitor;
        let _ = Monitor::enumerate(); // Loads DirectX DLLs
    });

    log::info!("[PREWARM] Pre-warm complete");
    Ok(())
}

/// Prepare recording resources when selection is confirmed.
/// This spawns FFmpeg for webcam so recording starts instantly.
/// Called from frontend when user finishes drawing selection (before clicking Record).
/// Runs heavy work in background thread to avoid blocking UI.
///
/// NOTE: This function is idempotent - if called multiple times (e.g., due to React
/// double-render or StrictMode), it cancels any previous preparation before starting new.
#[command]
pub fn prepare_recording(format: RecordingFormat) -> Result<(), String> {
    log::info!("[PREPARE] Preparing recording resources (background)...");

    // IMPORTANT: Cancel any existing prepared resources FIRST to avoid race conditions.
    // If prepare_recording is called twice quickly (React double-render), we need to
    // ensure the webcam pipe matches the output path that will actually be used.
    if let Ok(mut prepared) = get_prepared_webcam_pipe().lock() {
        if let Some(old_pipe) = prepared.take() {
            log::info!("[PREPARE] Cancelling previous webcam pipe to avoid path mismatch");
            old_pipe.cancel();
        }
    }
    if let Ok(mut prepared) = get_prepared_output_path().lock() {
        if let Some(old_path) = prepared.take() {
            // Don't delete the folder - a background FFmpeg might still be starting up.
            // Just clear the reference; orphaned empty folders are harmless.
            log::info!(
                "[PREPARE] Cleared previous output path reference: {:?}",
                old_path
            );
        }
    }

    // Generate output path now (before record click) - this is fast
    let settings = RecordingSettings {
        format,
        ..Default::default()
    };
    let output_path = generate_output_path(&settings)?;
    log::info!("[PREPARE] Output path: {:?}", output_path);

    // Store for later use
    if let Ok(mut prepared) = get_prepared_output_path().lock() {
        *prepared = Some(output_path.clone());
    }

    // Check webcam settings (fast)
    let webcam_enabled = WEBCAM_CONFIG.read().enabled;

    if webcam_enabled && format == RecordingFormat::Mp4 {
        // For MP4, output_path is a folder - webcam goes inside as webcam.mp4
        let webcam_path = output_path.join("webcam.mp4");
        let expected_output_path = output_path.clone();

        // Spawn FFmpeg in background thread - this is the slow part
        std::thread::spawn(move || {
            log::info!("[PREPARE] Spawning FFmpeg for webcam: {:?}", webcam_path);

            match webcam::WebcamEncoderPipe::new(webcam_path) {
                Ok(pipe) => {
                    // IMPORTANT: Before storing, verify this pipe's output path is still the current one.
                    // If prepare_recording was called again while we were spawning, our path is stale.
                    let should_store = if let Ok(current_path) = get_prepared_output_path().lock() {
                        current_path.as_ref() == Some(&expected_output_path)
                    } else {
                        false
                    };

                    if should_store {
                        if let Ok(mut prepared) = get_prepared_webcam_pipe().lock() {
                            // Double-check no other pipe was stored while we were checking
                            if let Some(existing) = prepared.take() {
                                log::info!("[PREPARE] Cancelling superseded pipe");
                                existing.cancel();
                            }
                            *prepared = Some(pipe);
                        }
                        log::info!("[PREPARE] FFmpeg spawned and ready");
                    } else {
                        log::info!(
                            "[PREPARE] Discarding stale webcam pipe (path changed): {:?}",
                            expected_output_path
                        );
                        pipe.cancel();
                    }
                },
                Err(e) => {
                    log::warn!("[PREPARE] Failed to spawn FFmpeg: {}", e);
                },
            }
        });
    }

    log::info!("[PREPARE] Recording preparation initiated");
    Ok(())
}

/// Stop pre-warmed resources (called when toolbar closes without recording).
#[command]
pub fn stop_prewarm() {
    log::info!("[PREWARM] Stopping pre-warmed resources");

    // Cancel any prepared webcam pipe
    if let Ok(mut prepared) = get_prepared_webcam_pipe().lock() {
        if let Some(pipe) = prepared.take() {
            pipe.cancel();
            log::info!("[PREWARM] Cancelled prepared webcam pipe");
        }
    }

    // Clear prepared output path
    if let Ok(mut prepared) = get_prepared_output_path().lock() {
        *prepared = None;
    }
}

// ============================================================================
// Native Webcam Preview Commands
// ============================================================================

/// Start native webcam capture service for preview.
/// Call this before showing the preview window.
#[command]
pub fn start_webcam_preview(device_index: usize) -> Result<(), String> {
    log::debug!(
        "[WEBCAM] start_webcam_preview(device_index={})",
        device_index
    );
    webcam::start_capture_service(device_index)
}

/// Stop native webcam capture service.
/// Call this when closing the preview window.
#[command]
pub fn stop_webcam_preview() {
    log::debug!("[WEBCAM] stop_webcam_preview()");
    webcam::stop_capture_service();
}

/// Get the latest webcam preview frame as base64 JPEG.
/// Returns None if no frame available yet.
#[command]
pub fn get_webcam_preview_frame(quality: Option<u8>) -> Option<String> {
    let q = quality.unwrap_or(80);
    let result = webcam::get_preview_frame_jpeg(q);
    if result.is_none() {
        // Log occasionally to debug
        static CALL_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let count = CALL_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if count % 30 == 0 {
            eprintln!(
                "[WEBCAM] get_webcam_preview_frame: no frame available (call #{})",
                count
            );
        }
    }
    result
}

/// Get webcam preview frame dimensions.
/// Returns None if camera not yet capturing.
#[command]
pub fn get_webcam_preview_dimensions() -> Option<(u32, u32)> {
    webcam::get_preview_dimensions()
}

/// Check if native webcam capture is running.
#[command]
pub fn is_webcam_preview_running() -> bool {
    webcam::is_preview_running()
}

/// Get available audio input devices (microphones).
/// Uses wasapi to get full friendly names (e.g., "Headset (WH-1000XM3 Hands-Free AG Audio)")
#[command]
pub fn list_audio_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    use wasapi::{initialize_mta, DeviceEnumerator, Direction};

    // Initialize COM for this thread
    let _ = initialize_mta();

    let enumerator = DeviceEnumerator::new()
        .map_err(|e| format!("Failed to create device enumerator: {:?}", e))?;

    // Get default device ID for comparison
    let default_id = enumerator
        .get_default_device(&Direction::Capture)
        .ok()
        .and_then(|d| d.get_id().ok());

    // Get all capture (input) devices
    let collection = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|e| format!("Failed to get device collection: {:?}", e))?;

    let mut result = Vec::new();
    for (index, device_result) in collection.into_iter().enumerate() {
        if let Ok(device) = device_result {
            let device_id = device.get_id().ok();
            let is_default = device_id.is_some() && device_id == default_id;

            // get_friendlyname() returns full name like "Headset (WH-1000XM3 Hands-Free AG Audio)"
            let name = device
                .get_friendlyname()
                .unwrap_or_else(|_| "Unknown Device".to_string());

            log::debug!(
                "[AUDIO] Device {}: name='{}', is_default={}",
                index,
                name,
                is_default
            );

            result.push(AudioInputDevice {
                index,
                name,
                is_default,
            });
        }
    }

    log::debug!("[AUDIO] Found {} input devices", result.len());
    Ok(result)
}

/// Close the webcam preview window.
#[command]
pub async fn close_webcam_preview(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("webcam-preview") {
        window.destroy().map_err(|e| e.to_string())?;
        log::debug!("[WEBCAM] Preview window closed");
    }
    Ok(())
}

/// Bring the webcam preview window to the front (above other topmost windows).
#[command]
pub async fn bring_webcam_preview_to_front(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE,
            SWP_NOSIZE, SWP_SHOWWINDOW,
        };

        if let Some(window) = app.get_webview_window("webcam-preview") {
            if let Ok(hwnd) = window.hwnd() {
                unsafe {
                    let hwnd = HWND(hwnd.0);
                    // First, set it as topmost
                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                    );
                    // Then bring to top of z-order
                    let _ = BringWindowToTop(hwnd);
                    // And set as foreground window
                    let _ = SetForegroundWindow(hwnd);
                }
            }
        }
    }
    Ok(())
}

/// Move the webcam preview window to an anchored position relative to selection bounds.
///
/// # Arguments
/// * `app` - Tauri app handle
/// * `anchor` - Anchor position (topLeft, topRight, bottomLeft, bottomRight)
/// * `sel_x` - Selection X coordinate (screen coordinates)
/// * `sel_y` - Selection Y coordinate (screen coordinates)
/// * `sel_width` - Selection width
/// * `sel_height` - Selection height
#[command]
pub async fn move_webcam_to_anchor(
    app: tauri::AppHandle,
    anchor: String,
    sel_x: i32,
    sel_y: i32,
    sel_width: i32,
    sel_height: i32,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("webcam-preview") {
        // Get webcam size from settings
        let webcam_size = match WEBCAM_CONFIG.read().size {
            WebcamSize::Small => 120,
            WebcamSize::Medium => 160,
            WebcamSize::Large => 200,
        };

        let padding = 16; // Padding from selection edge

        // Calculate position based on anchor
        let (x, y) = match anchor.as_str() {
            "topLeft" => (sel_x + padding, sel_y + padding),
            "topRight" => (sel_x + sel_width - webcam_size - padding, sel_y + padding),
            "bottomLeft" => (sel_x + padding, sel_y + sel_height - webcam_size - padding),
            "bottomRight" | _ => (
                sel_x + sel_width - webcam_size - padding,
                sel_y + sel_height - webcam_size - padding,
            ),
        };

        log::debug!("[WEBCAM] Moving to anchor {} at ({}, {})", anchor, x, y);

        // Move the window
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
            .map_err(|e| e.to_string())?;

        // Bring to front after moving
        bring_webcam_preview_to_front(app).await?;
    }

    Ok(())
}

/// Clamp the webcam preview position to stay within selection bounds after drag.
#[command]
pub async fn clamp_webcam_to_selection(
    app: tauri::AppHandle,
    sel_x: i32,
    sel_y: i32,
    sel_width: i32,
    sel_height: i32,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("webcam-preview") {
        // Get webcam size from settings
        let webcam_size = match WEBCAM_CONFIG.read().size {
            WebcamSize::Small => 120,
            WebcamSize::Medium => 160,
            WebcamSize::Large => 200,
        };

        let padding = 16;

        // Get current window position
        let current_pos = window.outer_position().map_err(|e| e.to_string())?;
        let x = current_pos.x;
        let y = current_pos.y;

        // Calculate bounds
        let min_x = sel_x + padding;
        let max_x = sel_x + sel_width - webcam_size - padding;
        let min_y = sel_y + padding;
        let max_y = sel_y + sel_height - webcam_size - padding;

        // Clamp position
        let clamped_x = x.clamp(min_x, max_x);
        let clamped_y = y.clamp(min_y, max_y);

        // Only move if position changed
        if clamped_x != x || clamped_y != y {
            log::debug!(
                "[WEBCAM] Clamping from ({}, {}) to ({}, {})",
                x,
                y,
                clamped_x,
                clamped_y
            );
            window
                .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                    x: clamped_x,
                    y: clamped_y,
                }))
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// ============================================================================
// Webcam Preview Service (Native capture via nokhwa)
// ============================================================================
// Preview is now handled natively via WebcamCaptureService with shared WEBCAM_BUFFER.
// The browser polls for JPEG frames via get_webcam_preview_frame command.
// NOTE: start_webcam_preview, stop_webcam_preview, is_webcam_preview_running,
//       get_webcam_preview_frame, get_webcam_preview_dimensions are defined above
//       in the "Native Webcam Preview Commands" section.

/// Exclude the webcam preview window from screen capture.
/// Uses Windows SetWindowDisplayAffinity API to make the window invisible to capture.
#[command]
pub async fn exclude_webcam_from_capture(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        };

        if let Some(window) = app.get_webview_window("webcam-preview") {
            let hwnd = window
                .hwnd()
                .map_err(|e| format!("Failed to get HWND: {}", e))?;
            unsafe {
                SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE)
                    .map_err(|e| format!("Failed to exclude from capture: {:?}", e))?;
            }
            log::debug!("[WEBCAM] Preview window excluded from screen capture");
        }
    }
    Ok(())
}

// ============================================================================
// Native/MF Webcam Preview (REMOVED - browser handles preview now)
// ============================================================================
// These commands are kept as no-ops for backwards compatibility with frontend cleanup calls.

/// Start native webcam preview.
/// DEPRECATED: Browser handles preview. This is a no-op.
#[command]
#[cfg(target_os = "windows")]
pub async fn start_native_webcam_preview(_app: tauri::AppHandle) -> Result<(), String> {
    log::debug!("[WEBCAM] start_native_webcam_preview called (no-op, browser handles preview)");
    Ok(())
}

/// Stop native webcam preview.
/// DEPRECATED: Browser handles preview. This is a no-op for cleanup compatibility.
#[command]
#[cfg(target_os = "windows")]
pub fn stop_native_webcam_preview() {
    log::debug!("[WEBCAM] stop_native_webcam_preview called (no-op)");
}

/// Check if native webcam preview is running.
/// DEPRECATED: Always returns false, browser handles preview.
#[command]
#[cfg(target_os = "windows")]
pub fn is_native_webcam_preview_running() -> bool {
    false
}

/// Start MF-based webcam preview.
/// DEPRECATED: Browser handles preview. This is a no-op.
#[command]
#[cfg(target_os = "windows")]
pub async fn start_mf_webcam_preview(_app: tauri::AppHandle) -> Result<(), String> {
    log::debug!("[WEBCAM] start_mf_webcam_preview called (no-op, browser handles preview)");
    Ok(())
}

/// Stop MF webcam preview.
/// DEPRECATED: Browser handles preview. This is a no-op for cleanup compatibility.
#[command]
#[cfg(target_os = "windows")]
pub fn stop_mf_webcam_preview() {
    log::debug!("[WEBCAM] stop_mf_webcam_preview called (no-op)");
}

/// Check if MF webcam preview is running.
/// DEPRECATED: Always returns false, browser handles preview.
#[command]
#[cfg(target_os = "windows")]
pub fn is_mf_webcam_preview_running() -> bool {
    false
}

// ============================================================================
// Browser-based Webcam Recording (MediaRecorder chunks from frontend)
// ============================================================================

use std::fs::{File, OpenOptions};
use std::io::Write;

lazy_static! {
    /// Active webcam recording file handle.
    static ref WEBCAM_RECORDING_FILE: Mutex<Option<File>> = Mutex::new(None);
}

/// Start webcam recording - creates the output file.
/// Called from frontend when screen recording starts.
#[command]
pub fn webcam_recording_start(output_path: String) -> Result<(), String> {
    let mut guard = WEBCAM_RECORDING_FILE
        .lock()
        .map_err(|e| format!("Failed to lock webcam recording state: {}", e))?;

    // Close any existing file
    if guard.is_some() {
        log::warn!("[WEBCAM-REC] Previous recording not properly closed, closing now");
        *guard = None;
    }

    // Create new file
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&output_path)
        .map_err(|e| format!("Failed to create webcam recording file: {}", e))?;

    *guard = Some(file);
    log::info!("[WEBCAM-REC] Started recording to: {}", output_path);
    Ok(())
}

/// Write a chunk of webcam video data.
/// Called from frontend's MediaRecorder ondataavailable.
#[command]
pub fn webcam_recording_chunk(chunk: Vec<u8>) -> Result<(), String> {
    let mut guard = WEBCAM_RECORDING_FILE
        .lock()
        .map_err(|e| format!("Failed to lock webcam recording state: {}", e))?;

    if let Some(ref mut file) = *guard {
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write webcam chunk: {}", e))?;
        log::trace!("[WEBCAM-REC] Wrote {} bytes", chunk.len());
        Ok(())
    } else {
        Err("Webcam recording not started".to_string())
    }
}

/// Stop webcam recording - closes the file.
/// Called from frontend when screen recording stops.
#[command]
pub fn webcam_recording_stop() -> Result<(), String> {
    let mut guard = WEBCAM_RECORDING_FILE
        .lock()
        .map_err(|e| format!("Failed to lock webcam recording state: {}", e))?;

    if let Some(file) = guard.take() {
        // File is closed when dropped
        drop(file);
        log::info!("[WEBCAM-REC] Recording stopped and file closed");
        Ok(())
    } else {
        log::warn!("[WEBCAM-REC] Stop called but no recording active");
        Ok(())
    }
}

// ============================================================================
// Recording Commands
// ============================================================================

/// Start a new recording session.
#[command]
pub async fn start_recording(
    app: AppHandle,
    settings: RecordingSettings,
) -> Result<StartRecordingResult, String> {
    let mut settings = settings;
    settings.validate();

    // Check if already recording
    {
        let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
        if controller.is_active() {
            return Err("A recording is already in progress".to_string());
        }
    }

    // Use prepared output path if available (from prepare_recording), else generate new one
    // NOTE: For quick capture, always regenerate path since prepare_recording doesn't know about quick_capture
    let output_path = if settings.quick_capture {
        // Quick capture: always generate fresh path (flat file, not folder)
        let _ = take_prepared_output_path(); // Discard any prepared path
        generate_output_path(&settings).unwrap_or_else(|_| {
            std::env::temp_dir().join(format!(
                "recording_{}.mp4",
                chrono::Local::now().format("%Y%m%d_%H%M%S")
            ))
        })
    } else {
        // Editor flow: use prepared path if available
        take_prepared_output_path().unwrap_or_else(|| {
            generate_output_path(&settings).unwrap_or_else(|_| {
                // Fallback to temp dir if generation fails - respect format
                let ext = match settings.format {
                    RecordingFormat::Gif => "gif",
                    RecordingFormat::Mp4 => "mp4",
                };
                std::env::temp_dir().join(format!(
                    "recording_{}.{}",
                    chrono::Local::now().format("%Y%m%d_%H%M%S"),
                    ext
                ))
            })
        })
    };

    log::info!("[RECORDING] Using output path: {:?}", output_path);

    // Start recording via controller
    recorder::start_recording(app, settings.clone(), output_path).await?;

    Ok(StartRecordingResult {
        success: true,
        message: "Recording started".to_string(),
    })
}

/// Stop the current recording and save the file.
/// Returns immediately after sending the stop command.
/// The actual completion is signaled via 'recording-state-changed' event.
#[command]
pub async fn stop_recording(app: AppHandle) -> Result<(), String> {
    recorder::stop_recording(app).await
}

/// Cancel the current recording without saving.
#[command]
pub async fn cancel_recording(app: AppHandle) -> Result<(), String> {
    recorder::cancel_recording(app).await
}

/// Pause the current recording (MP4 only).
#[command]
pub async fn pause_recording(app: AppHandle) -> Result<(), String> {
    recorder::pause_recording(app).await
}

/// Resume a paused recording.
#[command]
pub async fn resume_recording(app: AppHandle) -> Result<(), String> {
    recorder::resume_recording(app).await
}

/// Get the current recording status.
#[command]
pub async fn get_recording_status() -> Result<RecordingStatus, String> {
    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
    Ok(RecordingStatus {
        state: controller.state.clone(),
        settings: controller.settings.clone(),
    })
}

// ============================================================================
// Video Editor Commands
// ============================================================================

/// Load a video project from a screen recording file.
///
/// This command:
/// 1. Extracts video metadata (dimensions, duration, fps) using ffprobe
/// 2. Detects associated files (webcam: `_webcam.mp4`, cursor: `_cursor.json`)
/// 3. Creates a VideoProject with default configurations
///
/// # Arguments
/// * `video_path` - Path to the screen recording MP4 file
///
/// # Returns
/// A VideoProject ready for editing in the video editor UI.
#[command]
pub async fn load_video_project(video_path: String) -> Result<VideoProject, String> {
    let path = std::path::Path::new(&video_path);

    if !path.exists() {
        return Err(format!("Video file not found: {}", video_path));
    }

    load_video_project_from_file(path)
}

/// Save a video project to a JSON file.
///
/// For folder-based projects (screen_video is inside a folder):
///   Saves to `project.json` in the same folder, with relative paths.
///
/// For legacy flat file projects:
///   Saves alongside the video with `.snapit` extension.
#[command]
pub async fn save_video_project(mut project: VideoProject) -> Result<(), String> {
    let video_path = std::path::Path::new(&project.sources.screen_video);

    // Check if this is a folder-based project (video is inside a project folder)
    if let Some(parent) = video_path.parent() {
        // If the parent folder looks like a project folder (video is screen.mp4)
        if video_path.file_name().and_then(|n| n.to_str()) == Some("screen.mp4") {
            // Save to project.json in the folder, with relative paths
            let project_path = parent.join("project.json");

            // Convert absolute paths back to relative paths for storage
            let to_relative = |abs_path: &str| -> String {
                let path = std::path::Path::new(abs_path);
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(abs_path)
                    .to_string()
            };

            // Create a copy with relative paths for saving
            let mut save_project = project.clone();
            save_project.sources.screen_video = to_relative(&project.sources.screen_video);
            if let Some(ref p) = project.sources.webcam_video {
                save_project.sources.webcam_video = Some(to_relative(p));
            }
            if let Some(ref p) = project.sources.cursor_data {
                save_project.sources.cursor_data = Some(to_relative(p));
            }
            if let Some(ref p) = project.sources.audio_file {
                save_project.sources.audio_file = Some(to_relative(p));
            }
            if let Some(ref p) = project.sources.system_audio {
                save_project.sources.system_audio = Some(to_relative(p));
            }
            if let Some(ref p) = project.sources.microphone_audio {
                save_project.sources.microphone_audio = Some(to_relative(p));
            }
            if let Some(ref p) = project.sources.background_music {
                save_project.sources.background_music = Some(to_relative(p));
            }

            // Update timestamp
            save_project.updated_at = chrono::Utc::now().to_rfc3339();

            return save_project.save(&project_path);
        }
    }

    // Legacy: save alongside video with .snapit extension
    let project_path = video_path.with_extension("snapit");
    project.updated_at = chrono::Utc::now().to_rfc3339();
    project.save(&project_path)
}

/// Load cursor recording data from a JSON file.
///
/// This is used for auto-zoom cursor following and cursor interpolation.
#[command]
pub async fn load_cursor_recording_cmd(path: String) -> Result<CursorRecording, String> {
    let cursor_path = std::path::Path::new(&path);

    if !cursor_path.exists() {
        return Err(format!("Cursor data file not found: {}", path));
    }

    cursor::load_cursor_recording(cursor_path)
}

/// Extract a video frame at the specified timestamp.
///
/// Returns a base64-encoded JPEG image. Uses caching to improve scrubbing performance.
///
/// # Arguments
/// * `video_path` - Path to the video file
/// * `timestamp_ms` - Timestamp in milliseconds
/// * `max_width` - Optional max width for scaling down (default: 1280)
/// * `tolerance_ms` - Cache tolerance in ms (default: 100ms, returns cached frame if within tolerance)
#[command]
pub async fn extract_frame(
    video_path: String,
    timestamp_ms: u64,
    max_width: Option<u32>,
    tolerance_ms: Option<u64>,
) -> Result<String, String> {
    let path = std::path::Path::new(&video_path);

    if !path.exists() {
        return Err(format!("Video file not found: {}", video_path));
    }

    let max_w = max_width.unwrap_or(1280);
    let tolerance = tolerance_ms.unwrap_or(100);

    get_video_frame_cached(path, timestamp_ms, Some(max_w), tolerance)
}

/// Clear the frame cache for a video or all videos.
///
/// Call this when closing the video editor to free memory.
#[command]
pub fn clear_video_frame_cache(video_path: Option<String>) {
    let path = video_path.as_ref().map(|p| std::path::Path::new(p));
    clear_frame_cache(path);
}

/// Extract audio waveform data for visualization.
///
/// Uses FFmpeg to downsample audio into a format suitable for waveform rendering.
#[command]
pub async fn extract_audio_waveform(
    audio_path: String,
    samples_per_second: Option<u32>,
) -> Result<AudioWaveform, String> {
    let path = std::path::Path::new(&audio_path);

    if !path.exists() {
        return Err(format!("Audio file not found: {}", audio_path));
    }

    let sps = samples_per_second.unwrap_or(100);

    let ffmpeg_path =
        crate::commands::storage::find_ffmpeg().ok_or_else(|| "FFmpeg not found".to_string())?;

    // Get audio duration via ffprobe
    let ffprobe_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let ffprobe_path = ffmpeg_path.with_file_name(ffprobe_name);

    let probe_output = std::process::Command::new(&ffprobe_path)
        .args(["-v", "quiet", "-print_format", "json", "-show_format"])
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    let probe_json: serde_json::Value = serde_json::from_slice(&probe_output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let duration_secs = probe_json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let duration_ms = (duration_secs * 1000.0) as u64;

    if duration_ms == 0 {
        return Ok(AudioWaveform {
            samples: Vec::new(),
            duration_ms: 0,
            samples_per_second: sps,
        });
    }

    // Extract audio as raw PCM samples (mono, f32)
    let output = std::process::Command::new(&ffmpeg_path)
        .args([
            "-i",
            &audio_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &sps.to_string(),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-",
        ])
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", stderr));
    }

    // Parse raw f32 samples
    let bytes = output.stdout;
    let num_samples = bytes.len() / 4;
    let mut samples = Vec::with_capacity(num_samples);

    for chunk in bytes.chunks_exact(4) {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        samples.push(sample.abs().min(1.0));
    }

    log::info!(
        "[AUDIO_WAVEFORM] Extracted {} samples for {:.1}s audio",
        samples.len(),
        duration_secs
    );

    Ok(AudioWaveform {
        samples,
        duration_ms,
        samples_per_second: sps,
    })
}

/// Generate auto-zoom regions from cursor data.
///
/// Analyzes the cursor recording to find click events and creates zoom regions
/// that will zoom to each click location. This is the core of the "auto-zoom to clicks"
/// feature similar to ScreenStudio.
///
/// # Arguments
/// * `project` - The video project to generate zoom regions for
/// * `config` - Optional auto-zoom configuration. Uses defaults if not provided.
///
/// # Returns
/// Updated VideoProject with auto-generated zoom regions
#[command]
pub async fn generate_auto_zoom(
    project: VideoProject,
    config: Option<AutoZoomConfig>,
) -> Result<VideoProject, String> {
    let zoom_config = config.unwrap_or_default();

    log::info!(
        "[AUTO_ZOOM] Generating auto-zoom for project '{}' with scale={}, hold={}ms",
        project.name,
        zoom_config.scale,
        zoom_config.hold_duration_ms
    );

    apply_auto_zoom_to_project(project, &zoom_config)
}

/// Export a video project with zoom effects applied.
///
/// Takes a VideoProject and exports it to the specified format with all
/// configured zoom regions, applying smooth transitions.
///
/// Uses GPU-accelerated rendering for smooth zoom effects, then pipes
/// rendered frames to FFmpeg for encoding.
///
/// Progress is reported via `export-progress` events.
///
/// # Arguments
/// * `app` - Tauri app handle for progress events
/// * `project` - The video project to export
/// * `output_path` - Path where the exported video will be saved
///
/// # Returns
/// ExportResult with output file information
#[command]
pub async fn export_video(
    app: AppHandle,
    project: VideoProject,
    output_path: String,
) -> Result<ExportResult, String> {
    log::info!(
        "[EXPORT] Starting GPU-accelerated export of '{}' to '{}'",
        project.name,
        output_path
    );

    let path = std::path::PathBuf::from(&output_path);

    // Ensure output directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    // Use GPU-accelerated export pipeline (streaming decoders - 1 FFmpeg process each)
    let result = crate::rendering::export_video_gpu(app.clone(), project, output_path).await?;

    log::info!(
        "[EXPORT] Export complete: {} bytes, {:.1}s",
        result.file_size_bytes,
        result.duration_secs
    );

    Ok(result)
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Generate a unique output path for the recording.
///
/// For video (MP4), returns a folder path that will contain:
///   - screen.mp4 (main recording)
///   - webcam.mp4 (optional)
///   - cursor.json (optional)
///   - system.wav, mic.wav (optional, deleted after muxing)
///   - project.json (video project metadata)
///
/// For GIF or quick capture MP4, returns a file path directly (no folder structure needed).
/// For editor MP4 (quick_capture = false), returns a folder path containing:
///   - screen.mp4 (main recording)
///   - webcam.mp4 (optional)
///   - cursor.json (optional)
///   - project.json (video project metadata)
pub fn generate_output_path(settings: &RecordingSettings) -> Result<PathBuf, String> {
    // Get the default save directory from settings
    let save_dir = crate::commands::settings::get_default_save_dir_sync().unwrap_or_else(|_| {
        dirs::video_dir()
            .or_else(dirs::download_dir)
            .unwrap_or_else(std::env::temp_dir)
    });

    // Ensure save directory exists
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create save directory: {}", e))?;

    // Generate name with timestamp
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");

    match settings.format {
        RecordingFormat::Mp4 => {
            if settings.quick_capture {
                // Quick capture: flat file, skip editor
                let filename = format!("recording_{}_{}.mp4", timestamp, rand::random::<u16>());
                Ok(save_dir.join(filename))
            } else {
                // Editor flow: create a project folder
                let folder_name = format!("recording_{}_{}", timestamp, rand::random::<u16>());
                let folder_path = save_dir.join(&folder_name);
                std::fs::create_dir_all(&folder_path)
                    .map_err(|e| format!("Failed to create recording folder: {}", e))?;
                Ok(folder_path)
            }
        },
        RecordingFormat::Gif => {
            // For GIF, use flat file (no complex artifacts)
            let filename = format!("recording_{}_{}.gif", timestamp, rand::random::<u16>());
            Ok(save_dir.join(filename))
        },
    }
}

/// Emit a recording state change event to the frontend.
pub fn emit_state_change(app: &AppHandle, state: &RecordingState) {
    // Debug: log the serialized JSON to verify field names
    if let Ok(json) = serde_json::to_string(state) {
        println!("[EMIT] recording-state-changed: {}", json);
    }
    let _ = app.emit("recording-state-changed", state);
}
// ============================================================================
// Audio Level Monitoring Commands
// ============================================================================

/// Start audio level monitoring.
///
/// Starts background threads that monitor audio input levels and emit
/// `audio-levels` events to the frontend at ~20Hz.
///
/// # Arguments
/// * `mic_device_index` - Optional microphone device index to monitor
/// * `monitor_system_audio` - Whether to monitor system audio (loopback)
#[command]
pub fn start_audio_monitoring(
    app: AppHandle,
    mic_device_index: Option<usize>,
    monitor_system_audio: bool,
) -> Result<(), String> {
    audio_monitor::start_monitoring(app, mic_device_index, monitor_system_audio)
}

/// Stop audio level monitoring.
#[command]
pub fn stop_audio_monitoring() -> Result<(), String> {
    audio_monitor::stop_monitoring()
}

/// Check if audio monitoring is currently active.
#[command]
pub fn is_audio_monitoring() -> bool {
    audio_monitor::is_monitoring()
}
