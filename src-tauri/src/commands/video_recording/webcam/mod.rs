//! Webcam capture and compositing for video recording.
//!
//! Provides Picture-in-Picture (PiP) webcam overlay functionality.
//! Uses nokhwa with Windows Media Foundation backend for webcam capture.

mod capture;
mod composite;
mod device;

pub use capture::WebcamCapture;
pub use composite::composite_webcam;
pub use device::{get_webcam_devices, WebcamDevice};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Webcam frame data ready for compositing.
#[derive(Clone)]
pub struct WebcamFrame {
    /// BGRA pixel data.
    pub bgra_data: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
}

impl Default for WebcamFrame {
    fn default() -> Self {
        Self {
            bgra_data: Vec::new(),
            width: 0,
            height: 0,
        }
    }
}

/// Position of the webcam overlay on the recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// Custom position (x, y from top-left of recording).
    Custom { x: i32, y: i32 },
}

impl Default for WebcamPosition {
    fn default() -> Self {
        Self::BottomRight
    }
}

/// Size of the webcam overlay.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamSize {
    /// ~10% of recording width.
    Small,
    /// ~15% of recording width.
    Medium,
    /// ~20% of recording width.
    Large,
}

impl Default for WebcamSize {
    fn default() -> Self {
        Self::Medium
    }
}

impl WebcamSize {
    /// Get the diameter/width as a fraction of the recording width.
    pub fn as_fraction(&self) -> f32 {
        match self {
            WebcamSize::Small => 0.10,
            WebcamSize::Medium => 0.15,
            WebcamSize::Large => 0.20,
        }
    }
}

/// Shape of the webcam overlay.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamShape {
    /// Circular overlay (common for PiP).
    Circle,
    /// Rectangular overlay with rounded corners.
    Rectangle,
}

impl Default for WebcamShape {
    fn default() -> Self {
        Self::Circle
    }
}

/// Settings for webcam overlay during recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebcamSettings {
    /// Enable webcam overlay.
    pub enabled: bool,
    /// Selected webcam device index.
    pub device_index: usize,
    /// Position of the webcam overlay.
    pub position: WebcamPosition,
    /// Size of the webcam overlay.
    pub size: WebcamSize,
    /// Shape of the webcam overlay (circle or rectangle).
    pub shape: WebcamShape,
    /// Whether to mirror the webcam horizontally (selfie mode).
    pub mirror: bool,
}

impl Default for WebcamSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            device_index: 0,
            position: WebcamPosition::default(),
            size: WebcamSize::default(),
            shape: WebcamShape::default(),
            mirror: true,
        }
    }
}

/// Compute the position and size of the webcam overlay on a frame.
pub fn compute_webcam_rect(
    frame_width: u32,
    frame_height: u32,
    settings: &WebcamSettings,
) -> (i32, i32, u32) {
    // Calculate diameter based on size setting and frame width
    let diameter = (frame_width as f32 * settings.size.as_fraction()) as u32;
    let margin = 20_i32; // Pixels from edge

    let (x, y) = match &settings.position {
        WebcamPosition::TopLeft => (margin, margin),
        WebcamPosition::TopRight => ((frame_width as i32) - (diameter as i32) - margin, margin),
        WebcamPosition::BottomLeft => (margin, (frame_height as i32) - (diameter as i32) - margin),
        WebcamPosition::BottomRight => (
            (frame_width as i32) - (diameter as i32) - margin,
            (frame_height as i32) - (diameter as i32) - margin,
        ),
        WebcamPosition::Custom { x, y } => (*x, *y),
    };

    (x, y, diameter)
}
