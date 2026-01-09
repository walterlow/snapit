//! Cursor position types for coordinate normalization.
//!
//! Mirrors Cap's cursor-capture crate position handling:
//! - RawCursorPosition: Physical screen coordinates
//! - CursorCropBounds: Capture region for normalization
//! - NormalizedCursorPosition: 0-1 coordinates within crop region

use device_query::{DeviceQuery, DeviceState};

/// Physical bounds on screen (used on Windows).
#[derive(Clone, Copy, Debug)]
pub struct PhysicalBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PhysicalBounds {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn position(&self) -> (f64, f64) {
        (self.x, self.y)
    }

    pub fn size(&self) -> (f64, f64) {
        (self.width, self.height)
    }
}

/// Raw cursor position in physical screen coordinates.
/// On Windows, this is in physical (pixel) coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawCursorPosition {
    x: i32,
    y: i32,
}

impl RawCursorPosition {
    /// Get current cursor position using device_query.
    /// This is more reliable than Windows GetCursorInfo for position tracking.
    pub fn get() -> Self {
        let device_state = DeviceState::new();
        let position = device_state.get_mouse().coords;
        Self {
            x: position.0,
            y: position.1,
        }
    }

    /// Create from explicit coordinates.
    pub fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    /// Get X coordinate.
    pub fn x(&self) -> i32 {
        self.x
    }

    /// Get Y coordinate.
    pub fn y(&self) -> i32 {
        self.y
    }

    /// Convert to position relative to a display's bounds.
    pub fn relative_to_display(
        &self,
        display_bounds: PhysicalBounds,
    ) -> Option<RelativeCursorPosition> {
        RelativeCursorPosition::from_raw(*self, display_bounds)
    }
}

/// Cursor position relative to a display's origin.
/// Uses top-left as origin (0, 0).
#[derive(Clone, Copy)]
pub struct RelativeCursorPosition {
    x: i32,
    y: i32,
    display_bounds: PhysicalBounds,
}

impl RelativeCursorPosition {
    /// Create from raw position and display bounds.
    pub fn from_raw(raw: RawCursorPosition, display_bounds: PhysicalBounds) -> Option<Self> {
        Some(Self {
            x: raw.x - display_bounds.x as i32,
            y: raw.y - display_bounds.y as i32,
            display_bounds,
        })
    }

    /// Get the display bounds this position is relative to.
    pub fn display_bounds(&self) -> &PhysicalBounds {
        &self.display_bounds
    }

    /// Normalize to 0-1 coordinates within the display.
    pub fn normalize(&self) -> Option<NormalizedCursorPosition> {
        let (width, height) = self.display_bounds.size();

        Some(NormalizedCursorPosition {
            x: self.x as f64 / width,
            y: self.y as f64 / height,
            crop: CursorCropBounds {
                x: 0.0,
                y: 0.0,
                width,
                height,
            },
        })
    }
}

impl std::fmt::Debug for RelativeCursorPosition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelativeCursorPosition")
            .field("x", &self.x)
            .field("y", &self.y)
            .finish()
    }
}

/// Crop bounds for cursor coordinate normalization.
/// Uses physical coordinates on Windows.
///
/// This type is intentionally opaque to enforce correct usage -
/// the logical/physical coordinate invariants must be maintained.
#[derive(Clone, Copy, Debug)]
pub struct CursorCropBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CursorCropBounds {
    /// Create from physical bounds (Windows).
    pub fn new_windows(bounds: PhysicalBounds) -> Self {
        Self {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        }
    }

    /// Create from explicit values.
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Get X offset of crop region.
    pub fn x(&self) -> f64 {
        self.x
    }

    /// Get Y offset of crop region.
    pub fn y(&self) -> f64 {
        self.y
    }

    /// Get width of crop region.
    pub fn width(&self) -> f64 {
        self.width
    }

    /// Get height of crop region.
    pub fn height(&self) -> f64 {
        self.height
    }
}

/// Normalized cursor position (0-1 within crop region).
pub struct NormalizedCursorPosition {
    x: f64,
    y: f64,
    crop: CursorCropBounds,
}

impl NormalizedCursorPosition {
    /// Get normalized X coordinate (0-1).
    pub fn x(&self) -> f64 {
        self.x
    }

    /// Get normalized Y coordinate (0-1).
    pub fn y(&self) -> f64 {
        self.y
    }

    /// Get the crop bounds this position is normalized within.
    pub fn crop(&self) -> CursorCropBounds {
        self.crop
    }

    /// Re-normalize to a different crop region.
    ///
    /// This converts the position back to absolute pixels using the current
    /// crop bounds, then normalizes to the new crop bounds.
    pub fn with_crop(&self, crop: CursorCropBounds) -> Self {
        // Convert back to absolute pixel coordinates
        let raw_px = (
            self.x * self.crop.width + self.crop.x,
            self.y * self.crop.height + self.crop.y,
        );

        // Normalize to new crop region
        Self {
            x: (raw_px.0 - crop.x) / crop.width,
            y: (raw_px.1 - crop.y) / crop.height,
            crop,
        }
    }
}

impl std::fmt::Debug for NormalizedCursorPosition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NormalizedCursorPosition")
            .field("x", &self.x)
            .field("y", &self.y)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cursor_crop_bounds() {
        let bounds = CursorCropBounds::new(100.0, 50.0, 800.0, 600.0);
        assert_eq!(bounds.x(), 100.0);
        assert_eq!(bounds.y(), 50.0);
        assert_eq!(bounds.width(), 800.0);
        assert_eq!(bounds.height(), 600.0);
    }

    #[test]
    fn test_with_crop_identity() {
        let crop = CursorCropBounds::new(0.0, 0.0, 1920.0, 1080.0);
        let pos = NormalizedCursorPosition {
            x: 0.5,
            y: 0.5,
            crop,
        };

        // Re-normalizing to the same crop should give same result
        let new_pos = pos.with_crop(crop);
        assert!((new_pos.x() - 0.5).abs() < 1e-10);
        assert!((new_pos.y() - 0.5).abs() < 1e-10);
    }

    #[test]
    fn test_with_crop_subset() {
        // Original: full screen 1920x1080, cursor at center (0.5, 0.5)
        let full_crop = CursorCropBounds::new(0.0, 0.0, 1920.0, 1080.0);
        let pos = NormalizedCursorPosition {
            x: 0.5, // 960px
            y: 0.5, // 540px
            crop: full_crop,
        };

        // New crop: center 960x540 region
        let center_crop = CursorCropBounds::new(480.0, 270.0, 960.0, 540.0);
        let new_pos = pos.with_crop(center_crop);

        // 960px is at center of new crop (480 + 480 = 960), so x should be 0.5
        assert!((new_pos.x() - 0.5).abs() < 1e-10);
        assert!((new_pos.y() - 0.5).abs() < 1e-10);
    }
}
