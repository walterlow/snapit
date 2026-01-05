//! Recording configuration.
//!
//! Consolidates all recording settings into a single typed struct with
//! thread-safe access via RwLock. Replaces 10+ scattered atomic variables.

use lazy_static::lazy_static;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::commands::video_recording::GifQualityPreset;

/// Centralized recording configuration.
///
/// All recording settings in one place, updated atomically via RwLock.
/// Frontend can batch-update all settings in a single IPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    /// Countdown duration before recording starts (0-10 seconds).
    pub countdown_secs: u32,

    /// Whether to capture system audio (what's playing on the computer).
    pub system_audio_enabled: bool,

    /// Frames per second (10-60).
    pub fps: u32,

    /// Quality setting (1-100). Affects video bitrate.
    pub quality: u32,

    /// GIF encoding preset (Fast/Balanced/High).
    pub gif_quality_preset: GifQualityPreset,

    /// Whether to include the cursor in the recording.
    /// When false (editor flow), cursor is captured separately for flexibility.
    pub include_cursor: bool,

    /// Maximum recording duration in seconds. None = unlimited.
    pub max_duration_secs: Option<u32>,

    /// Selected microphone device index. None = no microphone.
    pub microphone_device_index: Option<usize>,

    /// Quick capture mode - saves directly to file, skips video editor.
    pub quick_capture: bool,

    /// Whether to hide desktop icons during recording.
    pub hide_desktop_icons: bool,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            countdown_secs: 3,
            system_audio_enabled: true,
            fps: 30,
            quality: 80,
            gif_quality_preset: GifQualityPreset::default(),
            include_cursor: false, // Cursor captured separately for editor flexibility
            max_duration_secs: None,
            microphone_device_index: None,
            quick_capture: false,
            hide_desktop_icons: false,
        }
    }
}

impl RecordingConfig {
    /// Validate and clamp settings to acceptable ranges.
    pub fn validate(&mut self) {
        self.countdown_secs = self.countdown_secs.clamp(0, 10);
        self.fps = self.fps.clamp(10, 60);
        self.quality = self.quality.clamp(1, 100);
    }

    /// Reset all settings to defaults.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

lazy_static! {
    /// Global recording configuration.
    ///
    /// Thread-safe access via `parking_lot::RwLock` (non-poisoning, fast).
    ///
    /// # Example
    /// ```ignore
    /// // Read current config
    /// let config = RECORDING_CONFIG.read().clone();
    ///
    /// // Update config atomically
    /// {
    ///     let mut config = RECORDING_CONFIG.write();
    ///     config.fps = 60;
    ///     config.quality = 90;
    /// }
    /// ```
    pub static ref RECORDING_CONFIG: RwLock<RecordingConfig> = RwLock::new(RecordingConfig::default());
}

// ============================================================================
// Convenience Getters (for backward compatibility with existing code)
// ============================================================================

/// Get the current countdown setting.
pub fn get_countdown_secs() -> u32 {
    RECORDING_CONFIG.read().countdown_secs
}

/// Get the current system audio setting.
pub fn get_system_audio_enabled() -> bool {
    RECORDING_CONFIG.read().system_audio_enabled
}

/// Get the current FPS setting.
pub fn get_fps() -> u32 {
    RECORDING_CONFIG.read().fps
}

/// Get the current quality setting.
pub fn get_quality() -> u32 {
    RECORDING_CONFIG.read().quality
}

/// Get the current GIF quality preset.
pub fn get_gif_quality_preset() -> GifQualityPreset {
    RECORDING_CONFIG.read().gif_quality_preset
}

/// Get the current include_cursor setting.
pub fn get_include_cursor() -> bool {
    RECORDING_CONFIG.read().include_cursor
}

/// Get the current max duration setting (None = unlimited).
pub fn get_max_duration_secs() -> Option<u32> {
    RECORDING_CONFIG.read().max_duration_secs
}

/// Get the current microphone device index (None = no microphone).
pub fn get_microphone_device_index() -> Option<usize> {
    RECORDING_CONFIG.read().microphone_device_index
}

/// Get the current quick capture setting.
pub fn get_quick_capture() -> bool {
    RECORDING_CONFIG.read().quick_capture
}

/// Get whether to hide desktop icons.
pub fn get_hide_desktop_icons() -> bool {
    RECORDING_CONFIG.read().hide_desktop_icons
}

/// Reset all recording settings to defaults.
pub fn reset_recording_config() {
    let mut config = RECORDING_CONFIG.write();
    config.reset();
    log::debug!("[CONFIG] Recording settings reset to defaults");
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Update recording configuration (batch update).
///
/// This allows the frontend to update all settings in a single IPC call.
#[tauri::command]
pub fn set_recording_config(config: RecordingConfig) {
    let mut current = RECORDING_CONFIG.write();
    *current = config;
    current.validate();
    log::debug!("[CONFIG] Recording config updated: {:?}", *current);
}

/// Get the current recording configuration.
#[tauri::command]
pub fn get_recording_config() -> RecordingConfig {
    RECORDING_CONFIG.read().clone()
}

/// Reset recording configuration to defaults.
#[tauri::command]
pub fn reset_recording_config_cmd() {
    reset_recording_config();
}

// ============================================================================
// Individual Setters (backward compatibility - prefer batch update)
// ============================================================================

/// Set the countdown preference.
#[tauri::command]
pub fn set_recording_countdown(secs: u32) {
    RECORDING_CONFIG.write().countdown_secs = secs.clamp(0, 10);
}

/// Set the system audio preference.
#[tauri::command]
pub fn set_recording_system_audio(enabled: bool) {
    RECORDING_CONFIG.write().system_audio_enabled = enabled;
}

/// Set the FPS.
#[tauri::command]
pub fn set_recording_fps(fps: u32) {
    RECORDING_CONFIG.write().fps = fps.clamp(10, 60);
}

/// Set the quality.
#[tauri::command]
pub fn set_recording_quality(quality: u32) {
    RECORDING_CONFIG.write().quality = quality.clamp(1, 100);
}

/// Set the GIF quality preset.
#[tauri::command]
pub fn set_gif_quality_preset(preset: GifQualityPreset) {
    RECORDING_CONFIG.write().gif_quality_preset = preset;
}

/// Set whether to include cursor.
#[tauri::command]
pub fn set_recording_include_cursor(include: bool) {
    log::debug!("[CONFIG] set_recording_include_cursor({})", include);
    RECORDING_CONFIG.write().include_cursor = include;
}

/// Set whether to use quick capture mode.
#[tauri::command]
pub fn set_recording_quick_capture(quick: bool) {
    log::debug!("[CONFIG] set_recording_quick_capture({})", quick);
    RECORDING_CONFIG.write().quick_capture = quick;
}

/// Set the max duration.
#[tauri::command]
pub fn set_recording_max_duration(secs: u32) {
    RECORDING_CONFIG.write().max_duration_secs = if secs == 0 { None } else { Some(secs) };
}

/// Set the microphone device index.
#[tauri::command]
pub fn set_recording_microphone_device(index: Option<u32>) {
    let device_index = index.map(|i| i as usize);
    log::debug!(
        "[CONFIG] set_recording_microphone_device({:?})",
        device_index
    );
    RECORDING_CONFIG.write().microphone_device_index = device_index;
}

/// Set whether to hide desktop icons during recording.
#[tauri::command]
pub fn set_hide_desktop_icons(enabled: bool) {
    log::debug!("[CONFIG] set_hide_desktop_icons({})", enabled);
    RECORDING_CONFIG.write().hide_desktop_icons = enabled;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = RecordingConfig::default();
        assert_eq!(config.countdown_secs, 3);
        assert_eq!(config.fps, 30);
        assert_eq!(config.quality, 80);
        assert!(config.system_audio_enabled);
        assert!(!config.include_cursor);
        assert!(!config.quick_capture);
    }

    #[test]
    fn test_config_validation() {
        let mut config = RecordingConfig {
            fps: 100,           // Over max
            quality: 0,         // Under min
            countdown_secs: 20, // Over max
            ..Default::default()
        };
        config.validate();

        assert_eq!(config.fps, 60);
        assert_eq!(config.quality, 1);
        assert_eq!(config.countdown_secs, 10);
    }
}
