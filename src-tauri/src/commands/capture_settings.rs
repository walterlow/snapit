//! Capture settings types for ts-rs generation.
//!
//! These types define the settings for each capture mode (screenshot, video, GIF).
//! They are exported to TypeScript via ts-rs for use in the frontend settings store.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::video_recording::GifQualityPreset;

// ============================================================================
// Screenshot Settings
// ============================================================================

/// Image format options for screenshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ScreenshotFormat {
    Png,
    Jpg,
    Webp,
}

impl Default for ScreenshotFormat {
    fn default() -> Self {
        Self::Png
    }
}

/// Settings for screenshot captures.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ScreenshotSettings {
    /// Output format (PNG, JPG, or WebP).
    pub format: ScreenshotFormat,
    /// Quality for JPG format (10-100). Ignored for PNG/WebP.
    #[ts(type = "number")]
    pub jpg_quality: u32,
    /// Whether to include the cursor in the screenshot.
    pub include_cursor: bool,
}

impl Default for ScreenshotSettings {
    fn default() -> Self {
        Self {
            format: ScreenshotFormat::default(),
            jpg_quality: 85,
            include_cursor: true,
        }
    }
}

// ============================================================================
// Video Settings
// ============================================================================

/// Settings for video (MP4) recordings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct VideoSettings {
    /// Quality setting (1-100). Affects video bitrate.
    #[ts(type = "number")]
    pub quality: u32,
    /// Frames per second (10-60).
    #[ts(type = "number")]
    pub fps: u32,
    /// Maximum recording duration in seconds. Null = unlimited.
    #[ts(type = "number | null")]
    pub max_duration_secs: Option<u32>,
    /// Whether to include the cursor in the recording.
    pub include_cursor: bool,
    /// Capture system audio (what's playing on the computer).
    pub capture_system_audio: bool,
    /// Capture microphone input.
    pub capture_microphone: bool,
    /// Capture webcam overlay. (Placeholder - not yet implemented)
    pub capture_webcam: bool,
    /// Countdown duration before recording starts (0-10 seconds).
    #[ts(type = "number")]
    pub countdown_secs: u32,
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            quality: 80,
            fps: 30,
            max_duration_secs: None,
            include_cursor: true,
            capture_system_audio: true,
            capture_microphone: false,
            capture_webcam: false, // Placeholder - always false for now
            countdown_secs: 3,
        }
    }
}

// ============================================================================
// GIF Settings
// ============================================================================

/// Settings for GIF recordings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct GifSettings {
    /// Quality preset (fast/balanced/high).
    pub quality_preset: GifQualityPreset,
    /// Frames per second (10-30, capped for GIF).
    #[ts(type = "number")]
    pub fps: u32,
    /// Maximum recording duration in seconds (max 60 for GIF).
    #[ts(type = "number")]
    pub max_duration_secs: u32,
    /// Whether to include the cursor in the recording.
    pub include_cursor: bool,
    /// Countdown duration before recording starts (0-10 seconds).
    #[ts(type = "number")]
    pub countdown_secs: u32,
}

impl Default for GifSettings {
    fn default() -> Self {
        Self {
            quality_preset: GifQualityPreset::default(),
            fps: 15,
            max_duration_secs: 30,
            include_cursor: true,
            countdown_secs: 3,
        }
    }
}

// ============================================================================
// Combined Capture Settings
// ============================================================================

/// All capture settings grouped by mode.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CaptureSettings {
    /// Screenshot-specific settings.
    pub screenshot: ScreenshotSettings,
    /// Video (MP4) recording settings.
    pub video: VideoSettings,
    /// GIF recording settings.
    pub gif: GifSettings,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            screenshot: ScreenshotSettings::default(),
            video: VideoSettings::default(),
            gif: GifSettings::default(),
        }
    }
}

// ============================================================================
// Tests (triggers ts-rs export)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_types() {
        // This test triggers ts-rs to generate TypeScript types
        ScreenshotFormat::export_all().unwrap();
        ScreenshotSettings::export_all().unwrap();
        VideoSettings::export_all().unwrap();
        GifSettings::export_all().unwrap();
        CaptureSettings::export_all().unwrap();
    }
}
