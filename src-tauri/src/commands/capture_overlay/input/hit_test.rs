//! Hit-testing for resize handles.
//!
//! Determines which resize handle (if any) is at a given point relative to
//! a selection rectangle.

use crate::commands::capture_overlay::types::{HandlePosition, Rect, HANDLE_HALF};

/// Determine which resize handle (if any) is at the given point.
///
/// Checks in order of priority:
/// 1. Corners (TopLeft, TopRight, BottomLeft, BottomRight)
/// 2. Edge midpoints (Top, Bottom, Left, Right)
/// 3. Interior (for moving the entire selection)
/// 4. None (outside the selection)
///
/// # Arguments
/// * `x` - X coordinate to test
/// * `y` - Y coordinate to test
/// * `bounds` - The selection rectangle
///
/// # Returns
/// The handle position at the given point
pub fn hit_test_handle(x: i32, y: i32, bounds: Rect) -> HandlePosition {
    let (cx, cy) = bounds.center();
    let Rect {
        left,
        top,
        right,
        bottom,
    } = bounds;

    // Check corners first (highest priority)
    if is_near(x, left, HANDLE_HALF) && is_near(y, top, HANDLE_HALF) {
        return HandlePosition::TopLeft;
    }
    if is_near(x, right, HANDLE_HALF) && is_near(y, top, HANDLE_HALF) {
        return HandlePosition::TopRight;
    }
    if is_near(x, left, HANDLE_HALF) && is_near(y, bottom, HANDLE_HALF) {
        return HandlePosition::BottomLeft;
    }
    if is_near(x, right, HANDLE_HALF) && is_near(y, bottom, HANDLE_HALF) {
        return HandlePosition::BottomRight;
    }

    // Check edge midpoints
    if is_near(x, cx, HANDLE_HALF) && is_near(y, top, HANDLE_HALF) {
        return HandlePosition::Top;
    }
    if is_near(x, cx, HANDLE_HALF) && is_near(y, bottom, HANDLE_HALF) {
        return HandlePosition::Bottom;
    }
    if is_near(x, left, HANDLE_HALF) && is_near(y, cy, HANDLE_HALF) {
        return HandlePosition::Left;
    }
    if is_near(x, right, HANDLE_HALF) && is_near(y, cy, HANDLE_HALF) {
        return HandlePosition::Right;
    }

    // Check interior (for moving)
    if bounds.contains_strict(x, y) {
        return HandlePosition::Interior;
    }

    HandlePosition::None
}

/// Check if two values are within a threshold of each other
#[inline]
fn is_near(a: i32, b: i32, threshold: i32) -> bool {
    (a - b).abs() <= threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_corner_handles() {
        let bounds = Rect::new(100, 100, 200, 200);

        assert_eq!(hit_test_handle(100, 100, bounds), HandlePosition::TopLeft);
        assert_eq!(hit_test_handle(200, 100, bounds), HandlePosition::TopRight);
        assert_eq!(
            hit_test_handle(100, 200, bounds),
            HandlePosition::BottomLeft
        );
        assert_eq!(
            hit_test_handle(200, 200, bounds),
            HandlePosition::BottomRight
        );
    }

    #[test]
    fn test_corner_handles_with_tolerance() {
        let bounds = Rect::new(100, 100, 200, 200);

        // Within HANDLE_HALF of corners
        assert_eq!(hit_test_handle(103, 102, bounds), HandlePosition::TopLeft);
        assert_eq!(hit_test_handle(198, 103, bounds), HandlePosition::TopRight);
    }

    #[test]
    fn test_edge_handles() {
        let bounds = Rect::new(100, 100, 200, 200);
        let cx = 150; // center x
        let cy = 150; // center y

        assert_eq!(hit_test_handle(cx, 100, bounds), HandlePosition::Top);
        assert_eq!(hit_test_handle(cx, 200, bounds), HandlePosition::Bottom);
        assert_eq!(hit_test_handle(100, cy, bounds), HandlePosition::Left);
        assert_eq!(hit_test_handle(200, cy, bounds), HandlePosition::Right);
    }

    #[test]
    fn test_interior() {
        let bounds = Rect::new(100, 100, 200, 200);

        // Center of selection
        assert_eq!(hit_test_handle(150, 150, bounds), HandlePosition::Interior);

        // Near center but not on edges
        assert_eq!(hit_test_handle(120, 130, bounds), HandlePosition::Interior);
    }

    #[test]
    fn test_outside() {
        let bounds = Rect::new(100, 100, 200, 200);

        // Completely outside
        assert_eq!(hit_test_handle(50, 50, bounds), HandlePosition::None);
        assert_eq!(hit_test_handle(250, 250, bounds), HandlePosition::None);

        // On edge but not near a handle point
        assert_eq!(hit_test_handle(100, 130, bounds), HandlePosition::None);
    }

    #[test]
    fn test_small_rectangle() {
        // Very small rectangle where handles might overlap
        let bounds = Rect::new(100, 100, 120, 120);

        // Should still detect corners
        assert_eq!(hit_test_handle(100, 100, bounds), HandlePosition::TopLeft);
        assert_eq!(hit_test_handle(120, 120, bounds), HandlePosition::BottomRight);
    }
}
