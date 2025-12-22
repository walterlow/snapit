//! Fallback capture implementation using xcap.
//!
//! Provides compatibility when Windows Graphics Capture or DXGI is unavailable.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use xcap::{Monitor, Window};

use super::types::{CaptureError, CaptureResult, MonitorInfo, RegionSelection, WindowInfo};

/// Check if a window is likely visible and capturable.
fn is_window_visible(w: &Window) -> bool {
    if w.is_minimized().unwrap_or(true) {
        return false;
    }

    let title = w.title().unwrap_or_default();
    let app_name = w.app_name().unwrap_or_default();
    let width = w.width().unwrap_or(0);
    let height = w.height().unwrap_or(0);
    let wx = w.x().unwrap_or(0);
    let wy = w.y().unwrap_or(0);

    if title.is_empty() || width < 50 || height < 50 {
        return false;
    }

    // Get total screen bounds
    let monitors = Monitor::all().unwrap_or_default();
    let mut min_x = 0i32;
    let mut min_y = 0i32;
    let mut max_x = 3840i32;
    let mut max_y = 2160i32;

    for monitor in &monitors {
        let mx = monitor.x().unwrap_or(0);
        let my = monitor.y().unwrap_or(0);
        let mw = monitor.width().unwrap_or(1920) as i32;
        let mh = monitor.height().unwrap_or(1080) as i32;
        min_x = min_x.min(mx);
        min_y = min_y.min(my);
        max_x = max_x.max(mx + mw);
        max_y = max_y.max(my + mh);
    }

    let ww = width as i32;
    let wh = height as i32;
    if wx + ww < min_x || wx > max_x || wy + wh < min_y || wy > max_y {
        return false;
    }

    // Filter known system windows
    let app_lower = app_name.to_lowercase();
    let title_lower = title.to_lowercase();

    if app_lower.contains("applicationframehost") && title_lower.is_empty() {
        return false;
    }

    if app_lower == "explorer.exe" || app_lower == "explorer" {
        if title_lower == "program manager" || title_lower.is_empty() || title_lower == "start" {
            return false;
        }
    }

    if app_lower.contains("textinputhost")
        || app_lower.contains("searchhost")
        || app_lower.contains("searchui")
        || app_lower.contains("shellexperiencehost")
        || app_lower.contains("lockapp")
        || app_lower.contains("widgets")
    {
        return false;
    }

    true
}

/// Get all available monitors.
pub fn get_monitors() -> Result<Vec<MonitorInfo>, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    let monitor_list: Vec<MonitorInfo> = monitors
        .iter()
        .enumerate()
        .map(|(idx, monitor)| MonitorInfo {
            id: idx as u32,
            name: monitor
                .name()
                .unwrap_or_else(|_| format!("Monitor {}", idx)),
            x: monitor.x().unwrap_or(0),
            y: monitor.y().unwrap_or(0),
            width: monitor.width().unwrap_or(1920),
            height: monitor.height().unwrap_or(1080),
            is_primary: monitor.is_primary().unwrap_or(false),
            scale_factor: monitor.scale_factor().unwrap_or(1.0),
        })
        .collect();

    Ok(monitor_list)
}

/// Get all capturable windows.
pub fn get_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let windows = Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get windows: {}", e)))?;

    let window_list: Vec<WindowInfo> = windows
        .iter()
        .filter(|w| is_window_visible(w))
        .map(|w| WindowInfo {
            id: w.id().unwrap_or(0),
            title: w.title().unwrap_or_default(),
            app_name: w.app_name().unwrap_or_default(),
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            width: w.width().unwrap_or(0),
            height: w.height().unwrap_or(0),
            is_minimized: w.is_minimized().unwrap_or(false),
        })
        .collect();

    Ok(window_list)
}

/// Check if image is mostly transparent or black (failed capture).
fn is_capture_invalid(image: &RgbaImage) -> bool {
    let total_pixels = (image.width() * image.height()) as usize;
    if total_pixels == 0 {
        return true;
    }
    
    let mut transparent_or_black = 0usize;
    for pixel in image.pixels() {
        // Check if pixel is fully transparent OR fully black
        if pixel[3] == 0 || (pixel[0] == 0 && pixel[1] == 0 && pixel[2] == 0 && pixel[3] == 255) {
            transparent_or_black += 1;
        }
    }
    
    let bad_ratio = transparent_or_black as f64 / total_pixels as f64;
    bad_ratio > 0.8
}

/// Get visible window bounds using DWM (excludes invisible shadow, includes titlebar).
#[cfg(target_os = "windows")]
fn get_window_rect_win32(hwnd: u32) -> Option<(i32, i32, u32, u32)> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
    };
    
    unsafe {
        let hwnd = HWND(hwnd as *mut std::ffi::c_void);
        let mut rect = RECT::default();
        
        // DWMWA_EXTENDED_FRAME_BOUNDS gives the actual visible window bounds
        // (includes titlebar, excludes invisible drop shadow)
        let result = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        
        if result.is_ok() {
            let width = (rect.right - rect.left) as u32;
            let height = (rect.bottom - rect.top) as u32;
            Some((rect.left, rect.top, width, height))
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn get_window_rect_win32(_hwnd: u32) -> Option<(i32, i32, u32, u32)> {
    None
}

/// Capture a window by its ID using xcap.
/// Falls back to screen capture + crop for elevated windows.
pub fn capture_window(window_id: u32) -> Result<CaptureResult, CaptureError> {
    let windows =
        Window::all().map_err(|e| CaptureError::CaptureFailed(format!("Failed to get windows: {}", e)))?;

    let target_window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or(CaptureError::WindowNotFound)?;

    if target_window.is_minimized().unwrap_or(false) {
        return Err(CaptureError::WindowMinimized);
    }

    // Get window bounds using Windows API (includes titlebar)
    // Fall back to xcap bounds if API fails
    let (win_x, win_y, win_width, win_height) = get_window_rect_win32(window_id)
        .unwrap_or_else(|| {
            (
                target_window.x().unwrap_or(0),
                target_window.y().unwrap_or(0),
                target_window.width().unwrap_or(0),
                target_window.height().unwrap_or(0),
            )
        });

    // Try direct window capture first
    let image = match target_window.capture_image() {
        Ok(img) if !is_capture_invalid(&img) => img,
        _ => {
            // Fallback: capture screen and crop to window bounds
            // This works for elevated windows like Task Manager
            capture_screen_region(win_x, win_y, win_width, win_height)?
        }
    };

    // Note: Rounded corners are handled by the compositor/editor, not here
    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| CaptureError::EncodingFailed(e.to_string()))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width: dynamic_image.width(),
        height: dynamic_image.height(),
        has_transparency: false,
    })
}

/// Capture a screen region by coordinates (for elevated window fallback).
fn capture_screen_region(x: i32, y: i32, width: u32, height: u32) -> Result<RgbaImage, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    // Find which monitor contains the window
    let target_monitor = monitors
        .iter()
        .find(|m| {
            let mx = m.x().unwrap_or(0);
            let my = m.y().unwrap_or(0);
            let mw = m.width().unwrap_or(0) as i32;
            let mh = m.height().unwrap_or(0) as i32;
            x >= mx && x < mx + mw && y >= my && y < my + mh
        })
        .or_else(|| monitors.first())
        .ok_or(CaptureError::MonitorNotFound)?;

    let full_image = target_monitor
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture screen: {}", e)))?;

    // Get scale factor - input coordinates are in logical pixels,
    // but capture_image() returns physical pixels
    let scale_factor = target_monitor.scale_factor().unwrap_or(1.0) as f32;

    let monitor_x = target_monitor.x().unwrap_or(0);
    let monitor_y = target_monitor.y().unwrap_or(0);

    // Calculate relative position within monitor and scale to physical pixels
    // Use rounding (not truncation) to prevent pixel misalignment at fractional scale factors
    let rel_x = ((x - monitor_x).max(0) as f32 * scale_factor).round() as u32;
    let rel_y = ((y - monitor_y).max(0) as f32 * scale_factor).round() as u32;
    let scaled_width = (width as f32 * scale_factor).round() as u32;
    let scaled_height = (height as f32 * scale_factor).round() as u32;

    // Clamp dimensions to monitor bounds
    let max_width = full_image.width().saturating_sub(rel_x);
    let max_height = full_image.height().saturating_sub(rel_y);
    let crop_width = scaled_width.min(max_width);
    let crop_height = scaled_height.min(max_height);

    if crop_width == 0 || crop_height == 0 {
        return Err(CaptureError::InvalidRegion);
    }

    // Crop to window bounds
    let cropped = DynamicImage::ImageRgba8(full_image)
        .crop_imm(rel_x, rel_y, crop_width, crop_height)
        .to_rgba8();

    Ok(cropped)
}

/// Capture a specific region from the screen.
pub fn capture_region(selection: RegionSelection) -> Result<CaptureResult, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    let monitor = monitors
        .get(selection.monitor_id as usize)
        .ok_or(CaptureError::MonitorNotFound)?;

    let full_image = monitor
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture screen: {}", e)))?;

    let dynamic_image = DynamicImage::ImageRgba8(full_image);

    // Get scale factor - selection coordinates are in logical pixels,
    // but capture_image() returns physical pixels
    let scale_factor = monitor.scale_factor().unwrap_or(1.0) as f32;

    let monitor_x = monitor.x().unwrap_or(0);
    let monitor_y = monitor.y().unwrap_or(0);

    // Scale coordinates from logical to physical pixels
    // Use rounding (not truncation) to prevent pixel misalignment at fractional scale factors
    let rel_x = ((selection.x - monitor_x).max(0) as f32 * scale_factor).round() as u32;
    let rel_y = ((selection.y - monitor_y).max(0) as f32 * scale_factor).round() as u32;
    let scaled_width = (selection.width as f32 * scale_factor).round() as u32;
    let scaled_height = (selection.height as f32 * scale_factor).round() as u32;

    let max_width = dynamic_image.width().saturating_sub(rel_x);
    let max_height = dynamic_image.height().saturating_sub(rel_y);
    let crop_width = scaled_width.min(max_width);
    let crop_height = scaled_height.min(max_height);

    if crop_width == 0 || crop_height == 0 {
        return Err(CaptureError::InvalidRegion);
    }

    let cropped = dynamic_image.crop_imm(rel_x, rel_y, crop_width, crop_height);

    let mut buffer = Cursor::new(Vec::new());
    cropped
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| CaptureError::EncodingFailed(e.to_string()))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width: cropped.width(),
        height: cropped.height(),
        has_transparency: false,
    })
}

/// Capture fullscreen (primary monitor).
pub fn capture_fullscreen() -> Result<CaptureResult, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or(CaptureError::MonitorNotFound)?;

    let image = monitor
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture screen: {}", e)))?;

    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| CaptureError::EncodingFailed(e.to_string()))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width: dynamic_image.width(),
        height: dynamic_image.height(),
        has_transparency: false,
    })
}
