//! Storage module for capture projects, thumbnails, and media files.
//!
//! ## Architecture
//!
//! ```text
//! mod.rs (public API + shared helpers)
//!   |
//!   +-- types.rs (type definitions)
//!   +-- ffmpeg.rs (FFmpeg utilities, thumbnail generation)
//!   +-- operations.rs (Tauri command handlers)
//!   +-- tests.rs (unit tests)
//! ```

pub mod ffmpeg;
pub mod operations;
#[cfg(test)]
mod tests;
pub mod types;

// Re-export FFmpeg utilities (widely used by video_recording, rendering modules)
pub use ffmpeg::{find_ffmpeg, find_ffprobe};

// Types are available via `storage::types::*` for external use

use rand::Rng;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// ============================================================================
// Shared Helper Functions
// ============================================================================

/// Get the user's configured save directory from settings, falling back to Pictures/SnapIt
pub(crate) fn get_captures_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = get_app_data_dir(app)?;
    let settings_path = app_data_dir.join("settings.json");

    // Try to read settings file
    if let Ok(content) = fs::read_to_string(&settings_path) {
        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
            // Get the "general" object and then "defaultSaveDir"
            if let Some(general) = settings.get("general") {
                if let Some(default_dir) = general.get("defaultSaveDir") {
                    if let Some(dir_str) = default_dir.as_str() {
                        let path = PathBuf::from(dir_str);
                        // Ensure directory exists
                        if !path.exists() {
                            fs::create_dir_all(&path)
                                .map_err(|e| format!("Failed to create save directory: {}", e))?;
                        }
                        return Ok(path);
                    }
                }
            }
        }
    }

    // Fallback to Pictures/SnapIt
    let pictures_dir = app
        .path()
        .picture_dir()
        .map_err(|e| format!("Failed to get pictures directory: {}", e))?;
    let snapit_path = pictures_dir.join("SnapIt");

    if !snapit_path.exists() {
        fs::create_dir_all(&snapit_path)
            .map_err(|e| format!("Failed to create SnapIt directory: {}", e))?;
    }

    Ok(snapit_path)
}

/// Get the app data directory.
pub(crate) fn get_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

/// Ensure all storage directories exist.
pub(crate) fn ensure_directories(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = get_app_data_dir(app)?;

    let dirs = ["captures", "projects", "thumbnails"];
    for dir in dirs {
        let path = base_dir.join(dir);
        if !path.exists() {
            fs::create_dir_all(&path)
                .map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
        }
    }

    Ok(base_dir)
}

/// Generate a unique ID for a capture.
pub(crate) fn generate_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0))
        .as_millis();
    let random: u32 = rand::thread_rng().gen();
    format!("{:x}{:06x}", timestamp, random & 0xFFFFFF)
}

/// Calculate the total size of a directory recursively.
pub(crate) fn calculate_dir_size(path: &PathBuf) -> u64 {
    let mut size: u64 = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(metadata) = fs::metadata(&path) {
                    size += metadata.len();
                }
            } else if path.is_dir() {
                size += calculate_dir_size(&path);
            }
        }
    }
    size
}
