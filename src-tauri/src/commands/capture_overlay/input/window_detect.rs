//! Window detection under cursor.
//!
//! Enumerates windows in z-order to find valid capture targets at a given
//! screen position. Filters out system windows, tool windows, and other
//! windows that shouldn't be captured.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::{
    GetDesktopWindow, GetTopWindow, GetWindow, GetWindowLongW, GetWindowRect, IsWindowVisible,
    GWL_EXSTYLE, GWL_STYLE, GW_HWNDNEXT, WS_CHILD, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use crate::commands::capture_overlay::types::{DetectedWindow, Rect, WS_EX_NOREDIRECTIONBITMAP};

/// Get the topmost valid window at a screen point.
///
/// Iterates through windows in z-order (front to back) and returns the first
/// valid window that contains the given point.
///
/// # Arguments
/// * `screen_x` - X coordinate in screen space
/// * `screen_y` - Y coordinate in screen space
/// * `exclude` - Window handle to exclude (typically the overlay itself)
///
/// # Returns
/// The detected window if found, or None
pub fn get_window_at_point(screen_x: i32, screen_y: i32, exclude: HWND) -> Option<DetectedWindow> {
    unsafe {
        let desktop = GetDesktopWindow();
        let mut hwnd = GetTopWindow(desktop).ok()?;

        loop {
            if hwnd.0.is_null() {
                break;
            }

            // Check if point is inside this window
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok()
                && screen_x >= rect.left
                && screen_x < rect.right
                && screen_y >= rect.top
                && screen_y < rect.bottom
            {
                if let Some(detected) = validate_window(hwnd, exclude) {
                    return Some(detected);
                }
            }

            // Next window in z-order
            hwnd = match GetWindow(hwnd, GW_HWNDNEXT) {
                Ok(next) if !next.0.is_null() => next,
                _ => break,
            };
        }

        None
    }
}

/// Validate that a window is suitable for capture.
///
/// Filters out:
/// - The overlay window itself
/// - Invisible windows
/// - Child windows
/// - Tool windows (unless they have WS_EX_APPWINDOW)
/// - DirectComposition windows (WS_EX_NOREDIRECTIONBITMAP)
/// - Very small windows (< 50x50)
fn validate_window(hwnd: HWND, exclude: HWND) -> Option<DetectedWindow> {
    unsafe {
        // Skip excluded window (our overlay)
        if hwnd == exclude {
            return None;
        }

        // Must be visible
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }

        // Get styles
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;

        // Skip child windows
        if (style & WS_CHILD.0) != 0 {
            return None;
        }

        // Skip tool windows (unless they have WS_EX_APPWINDOW)
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 && (ex_style & WS_EX_APPWINDOW.0) == 0 {
            return None;
        }

        // Skip DirectComposition windows (like our overlay)
        if (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0 {
            return None;
        }

        // Get actual visible bounds (without shadow) using DWM
        let bounds = get_window_bounds(hwnd)?;

        // Skip tiny windows
        if bounds.width() < 50 || bounds.height() < 50 {
            return None;
        }

        Some(DetectedWindow::new(hwnd, bounds))
    }
}

/// Get window bounds, preferring DWM extended frame bounds (excludes shadow).
///
/// DWM's DWMWA_EXTENDED_FRAME_BOUNDS gives us the actual visible window area
/// without the drop shadow. We subtract the visible border thickness to get
/// the content area.
fn get_window_bounds(hwnd: HWND) -> Option<Rect> {
    unsafe {
        let mut rect = RECT::default();

        // Try DWM first for accurate bounds without shadow
        let dwm_result = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );

        // Fall back to GetWindowRect if DWM fails
        if dwm_result.is_err() && GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }

        // Subtract visible border to get content area
        let border = crate::commands::win_utils::get_visible_border_thickness(hwnd);
        rect.left += border;
        rect.right -= border;
        rect.bottom -= border;
        // No top inset - title bar doesn't have the same border issue

        Some(Rect::new(rect.left, rect.top, rect.right, rect.bottom))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_null_hwnd() {
        // Should handle null handles gracefully
        let result = get_window_at_point(0, 0, HWND::default());
        // Result depends on what's at 0,0 on the test machine
        // Just verify it doesn't crash
        let _ = result;
    }

    #[test]
    fn test_exclude_self() {
        // When excluding a specific window, it shouldn't be returned
        // This is hard to test without creating actual windows
    }
}
