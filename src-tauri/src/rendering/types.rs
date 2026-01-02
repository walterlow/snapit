//! Core types for GPU-accelerated video rendering.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A decoded video frame ready for GPU upload.
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    /// Frame number (0-indexed).
    pub frame_number: u32,
    /// Timestamp in milliseconds.
    pub timestamp_ms: u64,
    /// RGBA pixel data (width * height * 4 bytes).
    pub data: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
}

impl DecodedFrame {
    pub fn new(
        frame_number: u32,
        timestamp_ms: u64,
        data: Vec<u8>,
        width: u32,
        height: u32,
    ) -> Self {
        Self {
            frame_number,
            timestamp_ms,
            data,
            width,
            height,
        }
    }

    /// Create an empty black frame.
    pub fn empty(width: u32, height: u32) -> Self {
        let data = vec![0u8; (width * height * 4) as usize];
        Self {
            frame_number: 0,
            timestamp_ms: 0,
            data,
            width,
            height,
        }
    }
}

/// Options for rendering a single frame.
#[derive(Debug, Clone)]
pub struct RenderOptions {
    /// Output width.
    pub output_width: u32,
    /// Output height.
    pub output_height: u32,
    /// Current zoom state.
    pub zoom: ZoomState,
    /// Webcam overlay options (if enabled).
    pub webcam: Option<WebcamOverlay>,
    /// Cursor rendering options (if enabled).
    pub cursor: Option<CursorOverlay>,
    /// Background padding/styling.
    pub background: BackgroundStyle,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            output_width: 1920,
            output_height: 1080,
            zoom: ZoomState::default(),
            webcam: None,
            cursor: None,
            background: BackgroundStyle::default(),
        }
    }
}

/// Current zoom state for a frame.
#[derive(Debug, Clone, Copy, Default)]
pub struct ZoomState {
    /// Zoom scale (1.0 = no zoom).
    pub scale: f32,
    /// Zoom center X (0.0-1.0, normalized).
    pub center_x: f32,
    /// Zoom center Y (0.0-1.0, normalized).
    pub center_y: f32,
}

impl ZoomState {
    pub fn identity() -> Self {
        Self {
            scale: 1.0,
            center_x: 0.5,
            center_y: 0.5,
        }
    }

    pub fn is_zoomed(&self) -> bool {
        self.scale > 1.001
    }
}

/// Webcam overlay configuration for rendering.
#[derive(Debug, Clone)]
pub struct WebcamOverlay {
    /// Webcam frame data.
    pub frame: DecodedFrame,
    /// Position X (0.0-1.0, normalized).
    pub x: f32,
    /// Position Y (0.0-1.0, normalized).
    pub y: f32,
    /// Size as fraction of output width.
    pub size: f32,
    /// Shape of overlay.
    pub shape: WebcamShape,
    /// Whether to mirror horizontally.
    pub mirror: bool,
    /// Shadow strength (0.0 = no shadow, 1.0 = full shadow).
    pub shadow: f32,
    /// Shadow size as fraction of webcam size (0.0-1.0).
    pub shadow_size: f32,
    /// Shadow opacity (0.0-1.0).
    pub shadow_opacity: f32,
    /// Shadow blur amount (0.0-1.0).
    pub shadow_blur: f32,
}

/// Shape of webcam overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebcamShape {
    /// Perfect circle.
    Circle,
    /// iOS-style squircle (superellipse with power 4).
    Squircle,
    /// Rectangle with no rounding.
    Rectangle,
    /// Rectangle with rounded corners.
    RoundedRect { radius: u32 },
}

/// Cursor overlay for rendering.
#[derive(Debug, Clone)]
pub struct CursorOverlay {
    /// Cursor position X in video coordinates.
    pub x: f32,
    /// Cursor position Y in video coordinates.
    pub y: f32,
    /// Cursor scale factor.
    pub scale: f32,
    /// Cursor image data (RGBA).
    pub image: Option<Vec<u8>>,
    /// Cursor image dimensions.
    pub image_width: u32,
    pub image_height: u32,
    /// Click highlight (if active).
    pub click_highlight: Option<ClickHighlight>,
}

/// Click highlight animation state.
#[derive(Debug, Clone)]
pub struct ClickHighlight {
    /// Highlight center X.
    pub x: f32,
    /// Highlight center Y.
    pub y: f32,
    /// Animation progress (0.0-1.0).
    pub progress: f32,
    /// Highlight color (RGBA).
    pub color: [f32; 4],
    /// Maximum radius.
    pub radius: f32,
}

/// Background styling for video output.
#[derive(Debug, Clone)]
pub struct BackgroundStyle {
    /// Background type.
    pub background_type: BackgroundType,
    /// Padding around video (pixels).
    pub padding: u32,
    /// Border radius for video frame.
    pub border_radius: u32,
    /// Shadow blur radius.
    pub shadow_radius: f32,
    /// Shadow opacity (0.0-1.0).
    pub shadow_opacity: f32,
}

impl Default for BackgroundStyle {
    fn default() -> Self {
        Self {
            background_type: BackgroundType::None,
            padding: 0,
            border_radius: 0,
            shadow_radius: 0.0,
            shadow_opacity: 0.0,
        }
    }
}

/// Background type for video output.
#[derive(Debug, Clone)]
pub enum BackgroundType {
    /// No background (transparent or black).
    None,
    /// Solid color (RGBA).
    Solid([f32; 4]),
    /// Linear gradient.
    Gradient {
        start: [f32; 4],
        end: [f32; 4],
        angle: f32,
    },
    /// Wallpaper image.
    Wallpaper(Vec<u8>),
}

/// Uniforms passed to the compositor shader.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CompositorUniforms {
    /// Video dimensions (width, height, 0, 0).
    pub video_size: [f32; 4],
    /// Output dimensions (width, height, 0, 0).
    pub output_size: [f32; 4],
    /// Zoom parameters (scale, center_x, center_y, 0).
    pub zoom: [f32; 4],
    /// Time and flags (time_ms, flags, 0, 0).
    pub time_flags: [f32; 4],
}

impl CompositorUniforms {
    pub fn new(
        video_width: u32,
        video_height: u32,
        output_width: u32,
        output_height: u32,
        zoom: &ZoomState,
        time_ms: f32,
    ) -> Self {
        Self {
            video_size: [video_width as f32, video_height as f32, 0.0, 0.0],
            output_size: [output_width as f32, output_height as f32, 0.0, 0.0],
            zoom: [zoom.scale, zoom.center_x, zoom.center_y, 0.0],
            time_flags: [time_ms, 0.0, 0.0, 0.0],
        }
    }
}

/// Playback state for the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum PlaybackState {
    /// Not playing.
    Stopped,
    /// Currently playing.
    Playing,
    /// Paused mid-playback.
    Paused,
    /// Seeking to a position.
    Seeking,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self::Stopped
    }
}

/// Event emitted during playback.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct PlaybackEvent {
    /// Current frame number.
    pub frame: u32,
    /// Current timestamp in milliseconds.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    /// Playback state.
    pub state: PlaybackState,
}

/// Rendered frame ready for display.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct RenderedFrame {
    /// Frame number.
    pub frame: u32,
    /// Timestamp in milliseconds.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    /// RGBA pixel data as base64 (for WebGL upload).
    pub data_base64: String,
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
}

/// Result of creating an editor instance.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct EditorInstanceInfo {
    /// Instance ID for future commands.
    pub instance_id: String,
    /// Video width.
    pub width: u32,
    /// Video height.
    pub height: u32,
    /// Duration in milliseconds.
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// Frame rate.
    pub fps: u32,
    /// Total frame count.
    pub frame_count: u32,
    /// Whether webcam track exists.
    pub has_webcam: bool,
    /// Whether cursor data exists.
    pub has_cursor: bool,
}
