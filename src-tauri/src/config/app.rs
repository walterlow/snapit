//! Application-level configuration.
//!
//! Contains user preferences that affect app-wide behavior:
//! - Window management (close to tray, start minimized)
//! - Notification settings
//! - Default behaviors
//!
//! Uses `parking_lot::RwLock` for thread-safe access matching
//! the pattern in `recording.rs` and `webcam.rs`.

use lazy_static::lazy_static;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

lazy_static! {
    /// Global app configuration.
    pub static ref APP_CONFIG: RwLock<AppConfig> = RwLock::new(AppConfig::default());
}

/// Application-wide user preferences.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AppConfig {
    /// Minimize to system tray instead of closing when clicking X.
    pub close_to_tray: bool,
    // Future fields:
    // pub start_minimized: bool,
    // pub show_notifications: bool,
    // pub default_save_location: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            close_to_tray: true,
        }
    }
}

// ============================================================================
// Getters (for internal Rust use)
// ============================================================================

/// Check if close-to-tray is enabled.
pub fn is_close_to_tray() -> bool {
    APP_CONFIG.read().close_to_tray
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Set close-to-tray behavior.
#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    log::debug!("[APP_CONFIG] set_close_to_tray({})", enabled);
    APP_CONFIG.write().close_to_tray = enabled;
}

/// Get the current app configuration.
#[tauri::command]
pub fn get_app_config() -> AppConfig {
    APP_CONFIG.read().clone()
}

/// Set the entire app configuration at once (for frontend sync).
#[tauri::command]
pub fn set_app_config(config: AppConfig) {
    log::debug!("[APP_CONFIG] set_app_config({:?})", config);
    *APP_CONFIG.write() = config;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert!(config.close_to_tray);
    }

    #[test]
    fn test_close_to_tray() {
        // Reset to default
        *APP_CONFIG.write() = AppConfig::default();

        assert!(is_close_to_tray());

        APP_CONFIG.write().close_to_tray = false;
        assert!(!is_close_to_tray());

        // Reset
        *APP_CONFIG.write() = AppConfig::default();
    }
}
