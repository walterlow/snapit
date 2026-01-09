//! Window management commands for SnapIt.
//!
//! ## Architecture
//!
//! ```text
//! window/
//!   mod.rs      - Shared helpers (DWM, physical coords), re-exports
//!   capture.rs  - Capture flow, overlay commands
//!   toolbar.rs  - Capture toolbar and startup toolbar
//!   recording.rs - Recording border and countdown windows
//! ```

pub mod capture;
pub mod recording;
pub mod toolbar;

// Re-export commonly used functions for internal use (used by app/tray.rs)
pub use capture::{open_editor_fast, trigger_capture};
pub use toolbar::show_startup_toolbar;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

// ============================================================================
// Constants
// ============================================================================

/// Recording border window label (legacy, kept for compatibility)
pub(crate) const RECORDING_BORDER_LABEL: &str = "recording-border";

/// Capture toolbar window label
pub(crate) const CAPTURE_TOOLBAR_LABEL: &str = "capture-toolbar";

/// Countdown window label
pub(crate) const COUNTDOWN_WINDOW_LABEL: &str = "countdown";

/// Track if main window was visible before capture started
pub(crate) static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

// ============================================================================
// Physical Coordinate Helpers
// ============================================================================
// Windows APIs return physical (pixel) coordinates. Tauri's builder methods
// use logical coordinates which don't match on scaled displays.
// These helpers ensure windows are positioned/sized using physical coordinates.

/// Position a window using physical (pixel) coordinates.
/// Use this when you have screen coordinates from Windows APIs.
pub(crate) fn set_physical_position(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
) -> Result<(), String> {
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| format!("Failed to set position: {}", e))
}

/// Resize a window using physical (pixel) dimensions.
/// Use this when you have dimensions from Windows APIs.
pub(crate) fn set_physical_size(
    window: &tauri::WebviewWindow,
    width: u32,
    height: u32,
) -> Result<(), String> {
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }))
        .map_err(|e| format!("Failed to set size: {}", e))
}

/// Position and resize a window using physical (pixel) coordinates.
/// Convenience wrapper for set_physical_position + set_physical_size.
pub(crate) fn set_physical_bounds(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    set_physical_position(window, x, y)?;
    set_physical_size(window, width, height)
}

// ============================================================================
// DWM Helpers (Windows-specific)
// ============================================================================

/// Apply DWM blur-behind transparency to a window.
/// This uses a tiny off-screen blur region trick (from PowerToys) to get
/// DWM-composited transparency without WS_EX_LAYERED, avoiding hardware video blackout.
#[cfg(target_os = "windows")]
pub fn apply_dwm_transparency(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND,
    };
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, HRGN};
    use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
    use windows::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN;

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        // Create a tiny region way off-screen (PowerToys trick)
        // This enables DWM blur/transparency without actually blurring anything visible
        let pos = -GetSystemMetrics(SM_CXVIRTUALSCREEN) - 8;
        let hrgn: HRGN = CreateRectRgn(pos, 0, pos + 1, 1);

        if hrgn.is_invalid() {
            return Err("Failed to create region".to_string());
        }

        let blur_behind = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
            fEnable: true.into(),
            hRgnBlur: hrgn,
            fTransitionOnMaximized: false.into(),
        };

        let result = DwmEnableBlurBehindWindow(HWND(hwnd.0), &blur_behind);

        // Clean up the region
        let _ = DeleteObject(hrgn);

        result.map_err(|e| format!("Failed to enable blur behind: {:?}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_dwm_transparency(_window: &tauri::WebviewWindow) -> Result<(), String> {
    // DWM is Windows-only, use regular transparency on other platforms
    Ok(())
}

/// Apply Windows 11 native rounded corners to a window.
/// This makes the OS clip the window to a rounded rectangle, eliminating
/// the rectangular background issue with WebView2 transparent windows.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub(crate) fn apply_rounded_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE};

    // DWMWCP_ROUND = 2 (standard rounded corners)
    // DWMWCP_ROUNDSMALL = 3 (smaller rounded corners)
    const DWMWCP_ROUND: i32 = 2;

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        let preference = DWMWCP_ROUND;
        DwmSetWindowAttribute(
            HWND(hwnd.0),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
        .map_err(|e| format!("Failed to set rounded corners: {:?}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_rounded_corners(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Apply a circular window region to make the window actually circular.
/// This is needed for wgpu transparency to work on Windows - the window shape
/// is clipped at the OS level so alpha blending isn't needed.
#[cfg(target_os = "windows")]
pub fn apply_circular_region(window: &tauri::WebviewWindow, diameter: i32) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{CreateEllipticRgn, SetWindowRgn};

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        // Create elliptic (circular) region
        let hrgn = CreateEllipticRgn(0, 0, diameter, diameter);
        if hrgn.is_invalid() {
            return Err("Failed to create elliptic region".to_string());
        }

        // Apply region to window - Windows takes ownership of the region
        let result = SetWindowRgn(HWND(hwnd.0), hrgn, true);
        if result == 0 {
            return Err("Failed to set window region".to_string());
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_circular_region(_window: &tauri::WebviewWindow, _diameter: i32) -> Result<(), String> {
    Ok(())
}

/// Apply a rounded rectangle window region.
/// Used for rectangle webcam shape with rounded corners.
#[cfg(target_os = "windows")]
pub fn apply_rounded_region(
    window: &tauri::WebviewWindow,
    width: i32,
    height: i32,
    corner_radius: i32,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        // Create rounded rectangle region
        let hrgn = CreateRoundRectRgn(0, 0, width, height, corner_radius, corner_radius);
        if hrgn.is_invalid() {
            return Err("Failed to create rounded rectangle region".to_string());
        }

        // Apply region to window - Windows takes ownership of the region
        let result = SetWindowRgn(HWND(hwnd.0), hrgn, true);
        if result == 0 {
            return Err("Failed to set window region".to_string());
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_rounded_region(
    _window: &tauri::WebviewWindow,
    _width: i32,
    _height: i32,
    _corner_radius: i32,
) -> Result<(), String> {
    Ok(())
}

/// Clear window region (restore to rectangular shape).
/// Used when switching from circle to rectangle shape.
#[cfg(target_os = "windows")]
pub fn clear_window_region(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{SetWindowRgn, HRGN};

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        // Pass NULL region to restore default rectangular shape
        let result = SetWindowRgn(HWND(hwnd.0), HRGN::default(), true);
        if result == 0 {
            return Err("Failed to clear window region".to_string());
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn clear_window_region(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Exclude a window from screen capture using Windows API.
/// This prevents the window from appearing in screenshots and screen recordings.
#[cfg(target_os = "windows")]
pub(crate) fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE)
            .map_err(|e| format!("Failed to set display affinity: {:?}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn exclude_window_from_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    // Not supported on non-Windows platforms
    Ok(())
}

// ============================================================================
// Internal Helpers
// ============================================================================

/// Close recording border window (not toolbar - it persists)
pub(crate) fn close_recording_border_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        let _ = window.close();
    }
}

/// Close all capture-related windows including toolbar
#[allow(dead_code)]
pub(crate) fn close_all_capture_windows(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        let _ = window.close();
    }
    close_recording_border_window(app);
}

/// Restore main window if it was visible before capture started
pub(crate) fn restore_main_if_visible(app: &tauri::AppHandle) {
    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("library") {
            let _ = main_window.show();
        }
    }
}
