//! Webcam configuration.
//!
//! Provides centralized, thread-safe access to webcam settings.
//! Re-exports types from the webcam module for convenience.

use lazy_static::lazy_static;
use parking_lot::RwLock;

// Re-export webcam types for convenience
pub use crate::commands::video_recording::webcam::{
    WebcamPosition, WebcamResolution, WebcamSettings, WebcamShape, WebcamSize,
};

use crate::error::SnapItResult;

/// Type alias for webcam config (same as WebcamSettings).
pub type WebcamConfig = WebcamSettings;

lazy_static! {
    /// Global webcam configuration.
    ///
    /// Thread-safe access via `parking_lot::RwLock` (non-poisoning, fast).
    pub static ref WEBCAM_CONFIG: RwLock<WebcamConfig> = RwLock::new(WebcamConfig::default());
}

// ============================================================================
// Convenience Functions
// ============================================================================

/// Get the current webcam settings.
/// Returns Result for backward compatibility with existing code.
pub fn get_webcam_settings() -> SnapItResult<WebcamConfig> {
    Ok(WEBCAM_CONFIG.read().clone())
}

/// Check if webcam capture is enabled.
/// Returns Result for backward compatibility with existing code.
pub fn is_webcam_enabled() -> SnapItResult<bool> {
    Ok(WEBCAM_CONFIG.read().enabled)
}

/// Get webcam size in pixels based on frame dimensions.
pub fn get_webcam_size_pixels(frame_width: u32) -> u32 {
    let size = WEBCAM_CONFIG.read().size;
    (frame_width as f32 * size.as_fraction()) as u32
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get the current webcam settings.
#[tauri::command]
pub fn get_webcam_settings_cmd() -> SnapItResult<WebcamConfig> {
    let settings = WEBCAM_CONFIG.read().clone();
    log::debug!(
        "[CONFIG] get_webcam_settings_cmd returning enabled={}",
        settings.enabled
    );
    Ok(settings)
}

/// Update webcam configuration (batch update).
#[tauri::command]
pub fn set_webcam_config(config: WebcamConfig) {
    log::debug!("[CONFIG] Webcam config updated: {:?}", config);
    *WEBCAM_CONFIG.write() = config;
}

/// Set webcam enabled state.
#[tauri::command]
pub fn set_webcam_enabled(enabled: bool) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_enabled({})", enabled);
    WEBCAM_CONFIG.write().enabled = enabled;
    Ok(())
}

/// Set webcam device index.
#[tauri::command]
pub fn set_webcam_device(device_index: usize) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_device({})", device_index);
    WEBCAM_CONFIG.write().device_index = device_index;
    Ok(())
}

/// Set webcam position.
#[tauri::command]
pub fn set_webcam_position(position: WebcamPosition) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_position({:?})", position);
    WEBCAM_CONFIG.write().position = position;
    Ok(())
}

/// Set webcam size.
#[tauri::command]
pub fn set_webcam_size(size: WebcamSize) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_size({:?})", size);
    WEBCAM_CONFIG.write().size = size;
    Ok(())
}

/// Set webcam shape.
#[tauri::command]
pub fn set_webcam_shape(shape: WebcamShape) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_shape({:?})", shape);
    WEBCAM_CONFIG.write().shape = shape;
    Ok(())
}

/// Set webcam mirror mode.
#[tauri::command]
pub fn set_webcam_mirror(mirror: bool) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_mirror({})", mirror);
    WEBCAM_CONFIG.write().mirror = mirror;
    Ok(())
}

/// Set webcam capture resolution.
/// If the camera feed is running, it will be restarted to apply the new resolution.
#[tauri::command]
pub fn set_webcam_resolution(resolution: WebcamResolution) -> SnapItResult<()> {
    log::debug!("[CONFIG] set_webcam_resolution({:?})", resolution);
    let device_index = WEBCAM_CONFIG.read().device_index;
    WEBCAM_CONFIG.write().resolution = resolution;

    // Restart feed if running to apply new resolution
    use crate::commands::video_recording::webcam::restart_global_feed;
    match restart_global_feed(device_index) {
        Ok(Some(_)) => log::info!(
            "[CONFIG] Feed restarted for new resolution {:?}",
            resolution
        ),
        Ok(None) => log::debug!("[CONFIG] Feed not running, resolution will apply on next start"),
        Err(e) => log::warn!(
            "[CONFIG] Failed to restart feed for resolution change: {}",
            e
        ),
    }

    Ok(())
}

/// Get the current webcam resolution setting.
#[tauri::command]
pub fn get_webcam_resolution() -> WebcamResolution {
    WEBCAM_CONFIG.read().resolution
}
