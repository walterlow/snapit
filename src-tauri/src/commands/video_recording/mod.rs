//! Video and GIF recording module.
//!
//! This module provides screen recording capabilities with the following features:
//! - MP4 video recording with H.264 encoding via Windows Media Foundation
//! - High-quality GIF recording with gifski
//! - Region, window, monitor, and all-monitors capture modes
//! - Optional system audio and microphone capture
//! - Configurable FPS (10-60) and quality settings

pub mod audio;
pub mod audio_sync;
pub mod audio_wasapi;
pub mod gif_encoder;
pub mod recorder;
pub mod state;

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter};
use ts_rs::TS;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

pub use state::RECORDING_CONTROLLER;

// Global countdown preference (0 = no countdown, 3 = 3 second countdown, etc.)
static COUNTDOWN_SECS: AtomicU32 = AtomicU32::new(3);

// Global system audio preference (true = capture system audio, false = no system audio)
static SYSTEM_AUDIO_ENABLED: AtomicBool = AtomicBool::new(true);

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

/// Audio capture settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioSettings {
    /// Capture system audio (what's playing on the computer).
    pub capture_system_audio: bool,
    /// Capture microphone input.
    pub capture_microphone: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            capture_system_audio: true,
            capture_microphone: false,
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
    /// Quality setting (1-100). Affects video bitrate or GIF quality.
    pub quality: u32,
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
            self.audio.capture_microphone = false;
            
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
