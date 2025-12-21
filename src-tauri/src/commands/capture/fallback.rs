//! Fallback capture implementation using xcap.
//!
//! Provides compatibility when Windows Graphics Capture or DXGI is unavailable.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use xcap::{Monitor, Window};

use super::types::{CaptureError, CaptureResult, MonitorInfo, RegionSelection, WindowInfo};

/// Apply rounded corners with anti-aliased transparency.
fn apply_rounded_corners(image: &mut RgbaImage, radius: u32) {
    let width = image.width();
    let height = image.height();
    let radius = radius.min(width / 2).min(height / 2);

    if radius == 0 {
        return;
    }

    let radius_f = radius as f64;

    for y in 0..radius {
        for x in 0..radius {
            let corners = [
                (x, y),
                (width - 1 - x, y),
                (x, height - 1 - y),
                (width - 1 - x, height - 1 - y),
            ];

            let dx = radius_f - x as f64 - 0.5;
            let dy = radius_f - y as f64 - 0.5;
            let dist = (dx * dx + dy * dy).sqrt();

            let alpha = if dist > radius_f {
                0u8
            } else if dist > radius_f - 1.5 {
                ((radius_f - dist) / 1.5 * 255.0) as u8
            } else {
                255u8
            };

            for (cx, cy) in corners {
                let pixel = image.get_pixel_mut(cx, cy);
                let current_alpha = pixel[3] as u16;
                pixel[3] = ((current_alpha * alpha as u16) / 255) as u8;
            }
        }
    }
}

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

/// Capture a window by its ID using xcap.
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

    let mut image = target_window
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture window: {}", e)))?;

    // Apply rounded corners
    apply_rounded_corners(&mut image, 8);

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
        has_transparency: false, // xcap doesn't preserve transparency well
    })
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

    let monitor_x = monitor.x().unwrap_or(0);
    let monitor_y = monitor.y().unwrap_or(0);
    let rel_x = (selection.x - monitor_x).max(0) as u32;
    let rel_y = (selection.y - monitor_y).max(0) as u32;

    let max_width = dynamic_image.width().saturating_sub(rel_x);
    let max_height = dynamic_image.height().saturating_sub(rel_y);
    let crop_width = selection.width.min(max_width);
    let crop_height = selection.height.min(max_height);

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
