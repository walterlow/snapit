//! Shared types for the capture module.

use serde::{Deserialize, Serialize};

/// Result of a screen/window capture operation.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureResult {
    /// Base64-encoded PNG image data.
    pub image_data: String,
    /// Width of the captured image in pixels.
    pub width: u32,
    /// Height of the captured image in pixels.
    pub height: u32,
    /// Indicates if the capture has meaningful transparency (alpha channel).
    #[serde(default)]
    pub has_transparency: bool,
}

/// Information about a display monitor.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub scale_factor: f32,
}

/// Information about a capturable window.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_minimized: bool,
}

/// Region selection for capturing a specific area.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegionSelection {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub monitor_id: u32,
}

/// Errors that can occur during capture operations.
#[derive(Debug)]
pub enum CaptureError {
    /// The requested window was not found.
    WindowNotFound,
    /// The requested monitor was not found.
    MonitorNotFound,
    /// The window is minimized and cannot be captured.
    WindowMinimized,
    /// Protected content (DRM) cannot be captured.
    ProtectedContent,
    /// The capture API is not available on this system.
    ApiUnavailable(String),
    /// The capture operation failed.
    CaptureFailed(String),
    /// Image encoding failed.
    EncodingFailed(String),
    /// Invalid region specified.
    InvalidRegion,
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::WindowNotFound => write!(f, "Window not found"),
            CaptureError::MonitorNotFound => write!(f, "Monitor not found"),
            CaptureError::WindowMinimized => write!(f, "Cannot capture minimized window"),
            CaptureError::ProtectedContent => write!(f, "Protected content cannot be captured"),
            CaptureError::ApiUnavailable(msg) => write!(f, "Capture API not available: {}", msg),
            CaptureError::CaptureFailed(msg) => write!(f, "Capture failed: {}", msg),
            CaptureError::EncodingFailed(msg) => write!(f, "Image encoding failed: {}", msg),
            CaptureError::InvalidRegion => write!(f, "Invalid region specified"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl From<CaptureError> for String {
    fn from(err: CaptureError) -> String {
        err.to_string()
    }
}
