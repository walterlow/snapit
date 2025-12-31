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
pub mod video_export;
pub mod video_project;
pub mod webcam;
pub mod wgc_capture;

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter, Manager};
use ts_rs::TS;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};

use crate::error::{LockResultExt, SnapItError};

pub use ffmpeg_gif_encoder::GifQualityPreset;
pub use state::RECORDING_CONTROLLER;

// Video editor types
pub use cursor::{
    CursorEvent, CursorEventCapture, CursorEventType, CursorRecording,
    load_cursor_recording, save_cursor_recording,
};
pub use video_project::{
    AudioTrackSettings, AutoZoomConfig, ClickHighlightConfig, ClickHighlightStyle, CursorConfig,
    EasingFunction, ExportConfig, ExportFormat, ExportResolution, TimelineState, VideoProject,
    VideoSources, VisibilitySegment, WebcamBorder, WebcamConfig,
    WebcamOverlayPosition, WebcamOverlayShape, ZoomConfig, ZoomMode, ZoomRegion,
    ZoomTransition, apply_auto_zoom_to_project, load_video_project_from_file, 
    get_video_frame_cached, clear_frame_cache,
};
pub use audio_multitrack::MultiTrackAudioRecorder;
pub use audio_monitor::AudioLevels;
pub use video_export::{ExportProgress, ExportResult, ExportStage, VideoExporter};

// GPU-accelerated editor
pub use gpu_editor::EditorState;

// Global recording settings (set from frontend before starting recording)
static COUNTDOWN_SECS: AtomicU32 = AtomicU32::new(3);
static SYSTEM_AUDIO_ENABLED: AtomicBool = AtomicBool::new(true);
static FPS: AtomicU32 = AtomicU32::new(30);
static QUALITY: AtomicU32 = AtomicU32::new(80);
static GIF_QUALITY_PRESET: AtomicU8 = AtomicU8::new(1); // 0=Fast, 1=Balanced, 2=High
static INCLUDE_CURSOR: AtomicBool = AtomicBool::new(true);
static MAX_DURATION_SECS: AtomicU32 = AtomicU32::new(0); // 0 = unlimited
static MICROPHONE_DEVICE_INDEX: AtomicU32 = AtomicU32::new(u32::MAX); // u32::MAX = no microphone

/// Reset all recording settings to their default values.
/// Useful when starting a fresh recording session or after errors.
pub fn reset_recording_settings() {
    COUNTDOWN_SECS.store(3, Ordering::SeqCst);
    SYSTEM_AUDIO_ENABLED.store(true, Ordering::SeqCst);
    FPS.store(30, Ordering::SeqCst);
    QUALITY.store(80, Ordering::SeqCst);
    GIF_QUALITY_PRESET.store(1, Ordering::SeqCst); // Balanced
    INCLUDE_CURSOR.store(true, Ordering::SeqCst);
    MAX_DURATION_SECS.store(0, Ordering::SeqCst); // unlimited
    MICROPHONE_DEVICE_INDEX.store(u32::MAX, Ordering::SeqCst); // no microphone
    log::debug!("[SETTINGS] Recording settings reset to defaults");
}

/// Reset all recording settings to defaults (Tauri command).
#[command]
pub fn reset_recording_settings_cmd() {
    reset_recording_settings();
}

/// Get the current countdown setting
pub fn get_countdown_secs() -> u32 {
    COUNTDOWN_SECS.load(Ordering::SeqCst)
}

/// Set the countdown preference (called from frontend before starting recording)
#[command]
pub fn set_recording_countdown(secs: u32) {
    COUNTDOWN_SECS.store(secs, Ordering::SeqCst);
}

/// Get the current system audio setting
pub fn get_system_audio_enabled() -> bool {
    SYSTEM_AUDIO_ENABLED.load(Ordering::SeqCst)
}

/// Set the system audio preference (called from frontend before starting recording)
#[command]
pub fn set_recording_system_audio(enabled: bool) {
    SYSTEM_AUDIO_ENABLED.store(enabled, Ordering::SeqCst);
}

/// Get the current FPS setting
pub fn get_fps() -> u32 {
    FPS.load(Ordering::SeqCst)
}

/// Set the FPS (called from frontend before starting recording)
#[command]
pub fn set_recording_fps(fps: u32) {
    // Clamp to valid range (10-60)
    FPS.store(fps.clamp(10, 60), Ordering::SeqCst);
}

/// Get the current quality setting
pub fn get_quality() -> u32 {
    QUALITY.load(Ordering::SeqCst)
}

/// Set the quality (called from frontend before starting recording)
#[command]
pub fn set_recording_quality(quality: u32) {
    // Clamp to valid range (1-100)
    QUALITY.store(quality.clamp(1, 100), Ordering::SeqCst);
}

/// Get the current GIF quality preset
pub fn get_gif_quality_preset() -> GifQualityPreset {
    match GIF_QUALITY_PRESET.load(Ordering::SeqCst) {
        0 => GifQualityPreset::Fast,
        2 => GifQualityPreset::High,
        _ => GifQualityPreset::Balanced,
    }
}

/// Set the GIF quality preset (called from frontend before starting GIF recording)
#[command]
pub fn set_gif_quality_preset(preset: GifQualityPreset) {
    let value = match preset {
        GifQualityPreset::Fast => 0,
        GifQualityPreset::Balanced => 1,
        GifQualityPreset::High => 2,
    };
    GIF_QUALITY_PRESET.store(value, Ordering::SeqCst);
}

/// Get the current include_cursor setting
pub fn get_include_cursor() -> bool {
    INCLUDE_CURSOR.load(Ordering::SeqCst)
}

/// Set whether to include cursor (called from frontend before starting recording)
#[command]
pub fn set_recording_include_cursor(include: bool) {
    log::debug!("[SETTINGS] set_recording_include_cursor({})", include);
    INCLUDE_CURSOR.store(include, Ordering::SeqCst);
}

/// Get the current max duration setting (0 = unlimited)
pub fn get_max_duration_secs() -> Option<u32> {
    let val = MAX_DURATION_SECS.load(Ordering::SeqCst);
    if val == 0 { None } else { Some(val) }
}

/// Set the max duration (called from frontend before starting recording)
#[command]
pub fn set_recording_max_duration(secs: u32) {
    MAX_DURATION_SECS.store(secs, Ordering::SeqCst);
}

/// Get the current microphone device index (None = no microphone)
pub fn get_microphone_device_index() -> Option<usize> {
    let val = MICROPHONE_DEVICE_INDEX.load(Ordering::SeqCst);
    if val == u32::MAX { None } else { Some(val as usize) }
}

/// Set the microphone device index (called from frontend before starting recording)
/// Pass None or a value >= u32::MAX to disable microphone capture.
#[command]
pub fn set_recording_microphone_device(index: Option<u32>) {
    let store_val = index.unwrap_or(u32::MAX);
    log::debug!("[SETTINGS] set_recording_microphone_device({:?}) -> storing {}", index, store_val);
    MICROPHONE_DEVICE_INDEX.store(store_val, Ordering::SeqCst);
}

/// Set whether to hide desktop icons during recording
#[command]
pub fn set_hide_desktop_icons(enabled: bool) {
    log::debug!("[SETTINGS] set_hide_desktop_icons({})", enabled);
    desktop_icons::set_hide_desktop_icons_enabled(enabled);
}

// ============================================================================
// Webcam Settings (Global Atomics)
// ============================================================================

use std::sync::Mutex;
use lazy_static::lazy_static;

pub use webcam::{
    WebcamDevice, WebcamFrame, WebcamPosition, WebcamSettings, WebcamShape,
    WebcamSize, composite_webcam, compute_webcam_rect, get_webcam_devices,
};

lazy_static! {
    /// Global webcam settings (protected by mutex since it's a struct).
    static ref WEBCAM_SETTINGS: Mutex<WebcamSettings> = Mutex::new(WebcamSettings::default());
}

/// Get the current webcam settings (internal use).
pub fn get_webcam_settings() -> Result<WebcamSettings, SnapItError> {
    Ok(WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.clone())
}

/// Get the current webcam settings (Tauri command).
#[command]
pub fn get_webcam_settings_cmd() -> Result<WebcamSettings, SnapItError> {
    let settings = WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.clone();
    log::debug!("[WEBCAM] get_webcam_settings_cmd returning enabled={}", settings.enabled);
    Ok(settings)
}

/// Check if webcam capture is enabled.
pub fn is_webcam_enabled() -> Result<bool, SnapItError> {
    Ok(WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.enabled)
}

/// Set webcam enabled state.
#[command]
pub fn set_webcam_enabled(enabled: bool) -> Result<(), SnapItError> {
    log::debug!("[SETTINGS] set_webcam_enabled({})", enabled);
    WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.enabled = enabled;
    Ok(())
}

/// Set webcam device index.
#[command]
pub fn set_webcam_device(device_index: usize) -> Result<(), SnapItError> {
    log::debug!("[SETTINGS] set_webcam_device({})", device_index);
    WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.device_index = device_index;
    Ok(())
}

/// Set webcam position.
#[command]
pub fn set_webcam_position(position: WebcamPosition) -> Result<(), SnapItError> {
    log::debug!("[SETTINGS] set_webcam_position({:?})", position);
    WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.position = position;
    Ok(())
}

/// Set webcam size.
#[command]
pub fn set_webcam_size(size: WebcamSize) -> Result<(), SnapItError> {
    log::debug!("[SETTINGS] set_webcam_size({:?})", size);
    WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.size = size;
    Ok(())
}

/// Set webcam shape.
#[command]
pub fn set_webcam_shape(shape: WebcamShape) -> Result<(), SnapItError> {
    log::debug!("[SETTINGS] set_webcam_shape({:?})", shape);
    WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.shape = shape;
    Ok(())
}

/// Set webcam mirror mode.
#[command]
pub fn set_webcam_mirror(mirror: bool) -> Result<(), SnapItError> {
    log::debug!("[SETTINGS] set_webcam_mirror({})", mirror);
    WEBCAM_SETTINGS.lock().map_lock_err("WEBCAM_SETTINGS")?.mirror = mirror;
    Ok(())
}

/// Get available webcam devices.
#[command]
pub fn list_webcam_devices() -> Result<Vec<WebcamDevice>, String> {
    get_webcam_devices()
}

/// Get available audio input devices (microphones).
/// Uses wasapi to get full friendly names (e.g., "Headset (WH-1000XM3 Hands-Free AG Audio)")
#[command]
pub fn list_audio_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    use wasapi::{DeviceEnumerator, Direction, initialize_mta};
    
    // Initialize COM for this thread
    initialize_mta().ok();
    
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
            let name = device.get_friendlyname().unwrap_or_else(|_| "Unknown Device".to_string());
            
            log::debug!("[AUDIO] Device {}: name='{}', is_default={}", index, name, is_default);
            
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
            SetWindowPos, BringWindowToTop, SetForegroundWindow,
            HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
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
        let webcam_size = {
            let settings = WEBCAM_SETTINGS.lock()
                .map_err(|_| "Failed to lock webcam settings".to_string())?;
            match settings.size {
                WebcamSize::Small => 120,
                WebcamSize::Medium => 160,
                WebcamSize::Large => 200,
            }
        };

        let padding = 16; // Padding from selection edge

        // Calculate position based on anchor
        let (x, y) = match anchor.as_str() {
            "topLeft" => (sel_x + padding, sel_y + padding),
            "topRight" => (sel_x + sel_width - webcam_size - padding, sel_y + padding),
            "bottomLeft" => (sel_x + padding, sel_y + sel_height - webcam_size - padding),
            "bottomRight" | _ => (sel_x + sel_width - webcam_size - padding, sel_y + sel_height - webcam_size - padding),
        };

        log::debug!("[WEBCAM] Moving to anchor {} at ({}, {})", anchor, x, y);

        // Move the window
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
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
        let webcam_size = {
            let settings = WEBCAM_SETTINGS.lock()
                .map_err(|_| "Failed to lock webcam settings".to_string())?;
            match settings.size {
                WebcamSize::Small => 120,
                WebcamSize::Medium => 160,
                WebcamSize::Large => 200,
            }
        };

        let padding = 16;

        // Get current window position
        let current_pos = window.outer_position().map_err(|e| e.to_string())?;
        let mut x = current_pos.x;
        let mut y = current_pos.y;

        // Calculate bounds
        let min_x = sel_x + padding;
        let max_x = sel_x + sel_width - webcam_size - padding;
        let min_y = sel_y + padding;
        let max_y = sel_y + sel_height - webcam_size - padding;

        // Clamp position
        let clamped_x = x.max(min_x).min(max_x);
        let clamped_y = y.max(min_y).min(max_y);

        // Only move if position changed
        if clamped_x != x || clamped_y != y {
            log::debug!("[WEBCAM] Clamping from ({}, {}) to ({}, {})", x, y, clamped_x, clamped_y);
            window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: clamped_x,
                y: clamped_y
            })).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// ============================================================================
// Webcam Preview Service (DEPRECATED - browser handles preview now)
// ============================================================================
// Preview is now handled by browser getUserMedia in WebcamPreviewWindow.tsx
// These commands are kept as no-ops for backwards compatibility with frontend cleanup calls.

/// Start the webcam preview service.
/// DEPRECATED: Browser now handles preview via getUserMedia. This is a no-op.
#[command]
pub async fn start_webcam_preview(_app: tauri::AppHandle) -> Result<(), String> {
    // No-op: browser getUserMedia handles preview now
    log::debug!("[WEBCAM] start_webcam_preview called (no-op, browser handles preview)");
    Ok(())
}

/// Stop the webcam preview service.
/// DEPRECATED: Browser handles preview. This is a no-op for cleanup compatibility.
#[command]
pub fn stop_webcam_preview() {
    // No-op: browser handles preview
    log::debug!("[WEBCAM] stop_webcam_preview called (no-op)");
}

/// Check if the webcam preview service is running.
/// DEPRECATED: Always returns false, browser handles preview.
#[command]
pub fn is_webcam_preview_running() -> bool {
    false
}

/// Exclude the webcam preview window from screen capture.
/// Uses Windows SetWindowDisplayAffinity API to make the window invisible to capture.
#[command]
pub async fn exclude_webcam_from_capture(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};

        if let Some(window) = app.get_webview_window("webcam-preview") {
            let hwnd = window.hwnd().map_err(|e| format!("Failed to get HWND: {}", e))?;
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
    let mut guard = WEBCAM_RECORDING_FILE.lock()
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
    let mut guard = WEBCAM_RECORDING_FILE.lock()
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
    let mut guard = WEBCAM_RECORDING_FILE.lock()
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
// Types
// ============================================================================

/// Output format for recordings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum RecordingFormat {
    Mp4,
    Gif,
}

impl Default for RecordingFormat {
    fn default() -> Self {
        Self::Mp4
    }
}

/// What to capture.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum RecordingMode {
    /// Capture a specific screen region.
    Region {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
    /// Capture a specific window.
    Window {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    /// Capture a specific monitor.
    Monitor {
        #[serde(rename = "monitorIndex")]
        monitor_index: usize,
    },
    /// Capture all monitors combined.
    AllMonitors,
}

/// Information about an available audio input device.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioInputDevice {
    /// Device index for selection (matches wasapi enumeration order).
    #[ts(type = "number")]
    pub index: usize,
    /// Human-readable device name (full friendly name from Windows, e.g., "Headset (WH-1000XM3 Hands-Free AG Audio)").
    pub name: String,
    /// Whether this is the system default input device.
    pub is_default: bool,
}

/// Audio capture settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioSettings {
    /// Capture system audio (what's playing on the computer).
    pub capture_system_audio: bool,
    /// Selected microphone device index. None = no microphone.
    #[ts(type = "number | null")]
    pub microphone_device_index: Option<usize>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            capture_system_audio: true,
            microphone_device_index: None,
        }
    }
}

/// Settings for a recording session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct RecordingSettings {
    /// Output format (MP4 or GIF).
    pub format: RecordingFormat,
    /// What to capture.
    pub mode: RecordingMode,
    /// Frames per second (10-60).
    pub fps: u32,
    /// Maximum recording duration in seconds. None = unlimited.
    pub max_duration_secs: Option<u32>,
    /// Whether to include the cursor in the recording.
    pub include_cursor: bool,
    /// Audio capture settings.
    pub audio: AudioSettings,
    /// Quality setting (1-100). Affects video bitrate.
    pub quality: u32,
    /// GIF encoding preset (Fast/Balanced/High).
    pub gif_quality_preset: GifQualityPreset,
    /// Countdown duration before recording starts (0-10 seconds).
    pub countdown_secs: u32,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            format: RecordingFormat::Mp4,
            mode: RecordingMode::Monitor { monitor_index: 0 },
            fps: 30,
            max_duration_secs: None,
            include_cursor: true,
            audio: AudioSettings::default(),
            quality: 80,
            gif_quality_preset: GifQualityPreset::default(),
            countdown_secs: 3,
        }
    }
}

impl RecordingSettings {
    /// Validate and clamp settings to acceptable ranges.
    pub fn validate(&mut self) {
        // Clamp FPS to 10-60
        self.fps = self.fps.clamp(10, 60);
        
        // Clamp quality to 1-100
        self.quality = self.quality.clamp(1, 100);
        
        // Clamp countdown to 0-10
        self.countdown_secs = self.countdown_secs.clamp(0, 10);
        
        // GIF-specific limits
        if self.format == RecordingFormat::Gif {
            // Cap GIF FPS at 30 for reasonable file sizes
            self.fps = self.fps.min(30);
            
            // GIF doesn't support audio
            self.audio.capture_system_audio = false;
            self.audio.microphone_device_index = None;
            
            // Limit GIF duration to 60 seconds max
            if let Some(duration) = self.max_duration_secs {
                self.max_duration_secs = Some(duration.min(60));
            } else {
                self.max_duration_secs = Some(30); // Default 30s for GIF
            }
        }
    }
    
    /// Calculate video bitrate based on quality and resolution.
    pub fn calculate_bitrate(&self, width: u32, height: u32) -> u32 {
        let pixels = width * height;
        let base_bitrate = match pixels {
            0..=921600 => 5_000_000,      // Up to 720p: 5 Mbps base
            921601..=2073600 => 10_000_000, // Up to 1080p: 10 Mbps base
            2073601..=3686400 => 15_000_000, // Up to 1440p: 15 Mbps base
            _ => 25_000_000,               // 4K+: 25 Mbps base
        };
        
        // Scale by quality (50% at quality=1, 150% at quality=100)
        let quality_factor = 0.5 + (self.quality as f64 / 100.0);
        (base_bitrate as f64 * quality_factor) as u32
    }
}

/// Current state of a recording session.
/// 
/// NOTE: ts-rs generates TypeScript types from Rust - single source of truth.
/// The serde attributes ensure JSON serialization matches the generated TS types.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum RecordingState {
    /// No recording in progress.
    Idle,
    /// Countdown before recording starts.
    Countdown {
        #[serde(rename = "secondsRemaining")]
        seconds_remaining: u32,
    },
    /// Currently recording.
    Recording {
        #[serde(rename = "startedAt")]
        started_at: String,
        #[serde(rename = "elapsedSecs")]
        elapsed_secs: f64,
        #[serde(rename = "frameCount")]
        #[ts(type = "number")]
        frame_count: u64,
    },
    /// Paused (MP4 only).
    Paused {
        #[serde(rename = "elapsedSecs")]
        elapsed_secs: f64,
        #[serde(rename = "frameCount")]
        #[ts(type = "number")]
        frame_count: u64,
    },
    /// Processing/encoding (mainly for GIF).
    Processing {
        progress: f32,
    },
    /// Recording completed successfully.
    Completed {
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(rename = "durationSecs")]
        duration_secs: f64,
        #[serde(rename = "fileSizeBytes")]
        #[ts(type = "number")]
        file_size_bytes: u64,
    },
    /// Recording failed.
    Error {
        message: String,
    },
}

impl Default for RecordingState {
    fn default() -> Self {
        Self::Idle
    }
}

/// Full status of the recording system.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct RecordingStatus {
    pub state: RecordingState,
    pub settings: Option<RecordingSettings>,
}

/// Result of starting a recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct StartRecordingResult {
    pub success: bool,
    pub message: String,
}

/// Result of stopping a recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
#[allow(dead_code)]
pub struct StopRecordingResult {
    pub output_path: String,
    pub duration_secs: f64,
    #[ts(type = "number")]
    pub file_size_bytes: u64,
    pub format: RecordingFormat,
}

// ============================================================================
// Tauri Commands
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
    
    // Generate output path
    let output_path = generate_output_path(&settings)?;
    
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
/// The project file is saved alongside the source video with `.snapit` extension.
#[command]
pub async fn save_video_project(project: VideoProject) -> Result<(), String> {
    let video_path = std::path::Path::new(&project.sources.screen_video);
    let project_path = video_path.with_extension("snapit");
    
    project.save(&project_path)
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
        "[EXPORT] Starting export of '{}' to '{}'",
        project.name,
        output_path
    );
    
    let path = std::path::PathBuf::from(&output_path);
    
    // Ensure output directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }
    
    let exporter = VideoExporter::new(project, path)?;
    
    // Run export in a blocking task to not block the async runtime
    let result = tokio::task::spawn_blocking(move || {
        exporter.export(&app)
    })
    .await
    .map_err(|e| format!("Export task failed: {}", e))??;
    
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
pub fn generate_output_path(settings: &RecordingSettings) -> Result<PathBuf, String> {
    // Get the default save directory from settings
    let save_dir = crate::commands::settings::get_default_save_dir_sync()
        .unwrap_or_else(|_| {
            dirs::video_dir()
                .or_else(dirs::download_dir)
                .unwrap_or_else(std::env::temp_dir)
        });
    
    // Ensure save directory exists
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create save directory: {}", e))?;
    
    // Generate filename with timestamp
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let extension = match settings.format {
        RecordingFormat::Mp4 => "mp4",
        RecordingFormat::Gif => "gif",
    };
    
    let filename = format!("recording_{}_{}.{}", timestamp, rand::random::<u16>(), extension);
    
    Ok(save_dir.join(filename))
}

/// Emit a recording state change event to the frontend.
pub fn emit_state_change(app: &AppHandle, state: &RecordingState) {
    // Debug: log the serialized JSON to verify field names
    if let Ok(json) = serde_json::to_string(state) {
        println!("[EMIT] recording-state-changed: {}", json);
    }
    let _ = app.emit("recording-state-changed", state);
}

/// Webcam error event payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamErrorEvent {
    pub message: String,
    pub is_fatal: bool,
}

/// Emit a webcam error event to the frontend.
pub fn emit_webcam_error(app: &AppHandle, message: &str, is_fatal: bool) {
    let event = WebcamErrorEvent {
        message: message.to_string(),
        is_fatal,
    };
    println!("[EMIT] webcam-error: {:?}", event);
    let _ = app.emit("webcam-error", event);
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
