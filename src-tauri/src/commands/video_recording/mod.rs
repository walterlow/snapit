//! Video and GIF recording module.
//!
//! This module provides screen recording capabilities with the following features:
//! - MP4 video recording with H.264 encoding via Windows Media Foundation
//! - High-quality GIF recording with FFmpeg
//! - Region, window, monitor, and all-monitors capture modes
//! - Optional system audio and microphone capture
//! - Configurable FPS (10-60) and quality settings

pub mod audio;
pub mod audio_sync;
pub mod audio_wasapi;
pub mod cursor;
pub mod ffmpeg_gif_encoder;
pub mod gif_encoder;
pub mod recorder;
pub mod state;
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

// ============================================================================
// Webcam Settings (Global Atomics)
// ============================================================================

use std::sync::Mutex;
use lazy_static::lazy_static;

pub use webcam::{
    WebcamCapture, WebcamDevice, WebcamFrame, WebcamPosition, WebcamSettings, WebcamShape,
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
#[command]
pub fn list_audio_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate audio input devices: {}", e))?;

    let mut result = Vec::new();
    for (index, device) in devices.enumerate() {
        if let Ok(name) = device.name() {
            result.push(AudioInputDevice {
                index,
                name: name.clone(),
                is_default: default_name.as_ref() == Some(&name),
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
// Webcam Preview Service (Single-source capture)
// ============================================================================

/// Start the webcam preview service (Rust-based capture that emits frames to frontend).
/// This replaces the browser's getUserMedia approach to avoid hardware conflicts.
#[command]
pub async fn start_webcam_preview(app: tauri::AppHandle) -> Result<(), String> {
    let settings = WEBCAM_SETTINGS.lock()
        .map_err(|_| "Failed to lock webcam settings".to_string())?
        .clone();
    webcam::start_preview_service(app, settings.device_index, settings.mirror)
}

/// Stop the webcam preview service.
#[command]
pub fn stop_webcam_preview() {
    webcam::stop_preview_service();
}

/// Check if the webcam preview service is running.
#[command]
pub fn is_webcam_preview_running() -> bool {
    webcam::is_preview_running()
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
    /// Device index for selection (matches cpal enumeration order).
    #[ts(type = "number")]
    pub index: usize,
    /// Human-readable device name.
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
