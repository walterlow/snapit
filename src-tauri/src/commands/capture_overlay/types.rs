//! Type definitions for the capture overlay system.
//!
//! This module contains all types, enums, constants, and geometry primitives
//! used throughout the capture overlay system.

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    IDC_ARROW, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE,
};

// ============================================================================
// Constants
// ============================================================================

/// Window class name for Win32 registration
pub const OVERLAY_CLASS_NAME: &str = "SnapItCaptureOverlay";

/// Minimum drag distance before entering region selection mode
pub const DRAG_THRESHOLD: i32 = 5;

/// Size of resize handles in pixels
pub const HANDLE_SIZE: i32 = 10;

/// Half the handle size (used for hit-testing)
pub const HANDLE_HALF: i32 = HANDLE_SIZE / 2;

/// Minimum selection size in pixels
pub const MIN_SELECTION_SIZE: i32 = 20;

/// Gap radius around cursor center for crosshair
pub const CROSSHAIR_GAP: f32 = 10.0;

/// Extended window style for DirectComposition (no redirection bitmap)
pub const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000;

// ============================================================================
// Geometry Types
// ============================================================================

/// A rectangle with integer coordinates.
///
/// Uses left/top/right/bottom format where right and bottom are exclusive.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    /// Create a new rectangle from left, top, right, bottom coordinates
    pub fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    /// Create a rectangle from x, y, width, height
    pub fn from_xywh(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            left: x,
            top: y,
            right: x + width as i32,
            bottom: y + height as i32,
        }
    }

    /// Get the width of the rectangle
    pub fn width(&self) -> u32 {
        (self.right - self.left).max(0) as u32
    }

    /// Get the height of the rectangle
    pub fn height(&self) -> u32 {
        (self.bottom - self.top).max(0) as u32
    }

    /// Get the center point of the rectangle
    pub fn center(&self) -> (i32, i32) {
        ((self.left + self.right) / 2, (self.top + self.bottom) / 2)
    }

    /// Check if a point is inside the rectangle (exclusive of right/bottom edges)
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }

    /// Check if a point is strictly inside the rectangle (not on edges)
    pub fn contains_strict(&self, x: i32, y: i32) -> bool {
        x > self.left && x < self.right && y > self.top && y < self.bottom
    }

    /// Normalize so left < right and top < bottom
    pub fn normalize(&self) -> Self {
        Self {
            left: self.left.min(self.right),
            top: self.top.min(self.bottom),
            right: self.left.max(self.right),
            bottom: self.top.max(self.bottom),
        }
    }

    /// Ensure minimum size, expanding right/bottom if needed
    pub fn ensure_min_size(&self, min: i32) -> Self {
        let mut r = *self;
        if r.right - r.left < min {
            r.right = r.left + min;
        }
        if r.bottom - r.top < min {
            r.bottom = r.top + min;
        }
        r
    }

    /// Offset the rectangle by dx, dy
    pub fn offset(&self, dx: i32, dy: i32) -> Self {
        Self {
            left: self.left + dx,
            top: self.top + dy,
            right: self.right + dx,
            bottom: self.bottom + dy,
        }
    }

    /// Convert to D2D_RECT_F for Direct2D rendering
    pub fn to_d2d_rect(&self) -> windows::Win32::Graphics::Direct2D::Common::D2D_RECT_F {
        windows::Win32::Graphics::Direct2D::Common::D2D_RECT_F {
            left: self.left as f32,
            top: self.top as f32,
            right: self.right as f32,
            bottom: self.bottom as f32,
        }
    }
}

/// A point with integer coordinates
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

// ============================================================================
// Capture Types
// ============================================================================

/// The type of capture being performed
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureType {
    #[default]
    Screenshot,
    Video,
    Gif,
}

impl CaptureType {
    /// Parse capture type from string
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "video" => Self::Video,
            "gif" => Self::Gif,
            _ => Self::Screenshot,
        }
    }

    /// Check if this capture type involves recording
    pub fn is_recording(&self) -> bool {
        matches!(self, Self::Video | Self::Gif)
    }
}

// ============================================================================
// Result Types (sent to frontend/Tauri)
// ============================================================================

/// Action taken after overlay selection
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlayAction {
    #[default]
    Cancelled,
    StartRecording,
    CaptureScreenshot,
}

/// Result from overlay selection
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayResult {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub action: OverlayAction,
}

impl OverlayResult {
    /// Create a new result from bounds and action
    pub fn new(bounds: Rect, action: OverlayAction) -> Self {
        Self {
            x: bounds.left,
            y: bounds.top,
            width: bounds.width(),
            height: bounds.height(),
            action,
        }
    }

    /// Create a cancelled result
    pub fn cancelled() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            action: OverlayAction::Cancelled,
        }
    }
}

/// Event payload for toolbar positioning and dimension updates
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionEvent {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl From<Rect> for SelectionEvent {
    fn from(r: Rect) -> Self {
        Self {
            x: r.left,
            y: r.top,
            width: r.width(),
            height: r.height(),
        }
    }
}

// ============================================================================
// Input Types
// ============================================================================

/// Resize handle position on the selection rectangle
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HandlePosition {
    #[default]
    None,
    TopLeft,
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
    /// Interior of the selection (for moving)
    Interior,
}

impl HandlePosition {
    /// Get the Win32 cursor ID for this handle position
    pub fn cursor_id(&self) -> PCWSTR {
        match self {
            Self::TopLeft | Self::BottomRight => IDC_SIZENWSE,
            Self::TopRight | Self::BottomLeft => IDC_SIZENESW,
            Self::Top | Self::Bottom => IDC_SIZENS,
            Self::Left | Self::Right => IDC_SIZEWE,
            Self::Interior => IDC_SIZEALL,
            Self::None => IDC_ARROW,
        }
    }

    /// Check if this is a valid handle (not None)
    pub fn is_active(&self) -> bool {
        !matches!(self, Self::None)
    }
}

/// Detected window under cursor
#[derive(Debug, Clone, Default)]
pub struct DetectedWindow {
    pub hwnd: HWND,
    pub bounds: Rect,
}

impl DetectedWindow {
    pub fn new(hwnd: HWND, bounds: Rect) -> Self {
        Self { hwnd, bounds }
    }
}

// ============================================================================
// Command Types (React <-> Rust communication)
// ============================================================================

/// Commands sent from React toolbar to overlay
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OverlayCommand {
    None = 0,
    ConfirmRecording = 1,
    ConfirmScreenshot = 2,
    Reselect = 3,
    Cancel = 4,
}

impl From<u8> for OverlayCommand {
    fn from(value: u8) -> Self {
        match value {
            1 => Self::ConfirmRecording,
            2 => Self::ConfirmScreenshot,
            3 => Self::Reselect,
            4 => Self::Cancel,
            _ => Self::None,
        }
    }
}

impl OverlayCommand {
    /// Convert to OverlayAction if this is a confirm command
    pub fn to_action(&self) -> Option<OverlayAction> {
        match self {
            Self::ConfirmRecording => Some(OverlayAction::StartRecording),
            Self::ConfirmScreenshot => Some(OverlayAction::CaptureScreenshot),
            _ => None,
        }
    }
}
