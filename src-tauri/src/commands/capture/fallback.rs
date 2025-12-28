//! Screen capture using xcap library.
//!
//! Simple, reliable screenshot capture for monitors, windows, and regions.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use xcap::{Monitor, Window};

use super::types::{CaptureError, CaptureResult, MonitorInfo, RegionSelection, ScreenRegionSelection, WindowInfo};

// ============================================================================
// Monitor Functions
// ============================================================================

/// Get all available monitors.
pub fn get_monitors() -> Result<Vec<MonitorInfo>, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to enumerate monitors: {}", e)))?;

    let mut infos = Vec::new();
    for (idx, m) in monitors.iter().enumerate() {
        infos.push(MonitorInfo {
            id: idx as u32,
            name: m.name().unwrap_or_default(),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            width: m.width().unwrap_or(1920),
            height: m.height().unwrap_or(1080),
            is_primary: m.is_primary().unwrap_or(false),
            scale_factor: m.scale_factor().unwrap_or(1.0),
        });
    }

    Ok(infos)
}

/// Capture the primary monitor (fullscreen).
pub fn capture_fullscreen() -> Result<CaptureResult, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    let primary = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or(CaptureError::MonitorNotFound)?;

    let image = primary
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture: {}", e)))?;

    encode_image_to_result(image, false)
}

/// Capture the primary monitor and return raw RGBA data.
pub fn capture_fullscreen_raw() -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    let primary = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or(CaptureError::MonitorNotFound)?;

    let image = primary
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture: {}", e)))?;

    let width = image.width();
    let height = image.height();
    let rgba_data = image.into_raw();

    Ok((rgba_data, width, height))
}

// ============================================================================
// Window Functions
// ============================================================================

/// Get all visible windows.
pub fn get_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let windows = Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to enumerate windows: {}", e)))?;

    let mut infos = Vec::new();
    for w in windows.iter() {
        let is_min = w.is_minimized().unwrap_or(true);
        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);

        if is_min || width == 0 || height == 0 {
            continue;
        }

        infos.push(WindowInfo {
            id: w.id().unwrap_or(0),
            title: w.title().unwrap_or_default(),
            app_name: w.app_name().unwrap_or_default(),
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            width,
            height,
            is_minimized: is_min,
        });
    }

    Ok(infos)
}

/// Capture a specific window by ID.
/// Uses screen region capture (BitBlt) instead of PrintWindow to avoid DWM artifacts.
pub fn capture_window(window_id: u32) -> Result<CaptureResult, CaptureError> {
    let (rgba_data, width, height) = capture_window_raw(window_id)?;

    // Convert to image and encode
    let image = image::RgbaImage::from_raw(width, height, rgba_data)
        .ok_or_else(|| CaptureError::CaptureFailed("Failed to create image from raw data".into()))?;

    encode_image_to_result(image, false)
}

/// Capture a specific window and return raw RGBA data.
/// Uses screen region capture (BitBlt) instead of PrintWindow to avoid DWM artifacts.
#[cfg(target_os = "windows")]
pub fn capture_window_raw(window_id: u32) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let hwnd = HWND(window_id as isize as *mut std::ffi::c_void);

    // Get both regular and DWM bounds for comparison
    let mut window_rect = RECT::default();
    let mut dwm_rect = RECT::default();

    unsafe {
        let _ = GetWindowRect(hwnd, &mut window_rect);
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut dwm_rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
    }

    println!("[CAPTURE] Window rect: {:?}", window_rect);
    println!("[CAPTURE] DWM rect: {:?}", dwm_rect);

    // Use DWM bounds (excludes shadow)
    let x = dwm_rect.left;
    let y = dwm_rect.top;
    let width = (dwm_rect.right - dwm_rect.left) as u32;
    let height = (dwm_rect.bottom - dwm_rect.top) as u32;

    println!("[CAPTURE] Capturing region: x={}, y={}, w={}, h={}", x, y, width, height);

    if width == 0 || height == 0 {
        return Err(CaptureError::CaptureFailed("Window has zero dimensions".into()));
    }

    // Use screen region capture instead of PrintWindow (avoids DWM artifacts)
    capture_screen_region_raw(super::types::ScreenRegionSelection {
        x,
        y,
        width,
        height,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn capture_window_raw(window_id: u32) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let windows = Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get windows: {}", e)))?;

    let window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or(CaptureError::WindowNotFound)?;

    let image = window
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture window: {}", e)))?;

    let width = image.width();
    let height = image.height();
    let rgba_data = image.into_raw();

    Ok((rgba_data, width, height))
}

// ============================================================================
// Region Capture
// ============================================================================

/// Capture a specific region from the screen.
pub fn capture_region(selection: RegionSelection) -> Result<CaptureResult, CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    // Find the monitor for this region
    let monitor = monitors
        .get(selection.monitor_id as usize)
        .ok_or(CaptureError::MonitorNotFound)?;

    // Calculate region relative to monitor
    let mon_x = monitor.x().unwrap_or(0);
    let mon_y = monitor.y().unwrap_or(0);
    let rel_x = (selection.x - mon_x).max(0) as u32;
    let rel_y = (selection.y - mon_y).max(0) as u32;

    // Capture the region directly using xcap
    let image = monitor
        .capture_region(rel_x, rel_y, selection.width, selection.height)
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture region: {}", e)))?;

    encode_image_to_result(image, false)
}

/// Capture a region and return raw RGBA data.
pub fn capture_region_raw(selection: RegionSelection) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    // Find the monitor for this region
    let monitor = monitors
        .get(selection.monitor_id as usize)
        .ok_or(CaptureError::MonitorNotFound)?;

    // Calculate region relative to monitor
    let mon_x = monitor.x().unwrap_or(0);
    let mon_y = monitor.y().unwrap_or(0);
    let rel_x = (selection.x - mon_x).max(0) as u32;
    let rel_y = (selection.y - mon_y).max(0) as u32;

    // Capture the region directly using xcap
    let image = monitor
        .capture_region(rel_x, rel_y, selection.width, selection.height)
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture region: {}", e)))?;

    let width = image.width();
    let height = image.height();
    let rgba_data = image.into_raw();

    Ok((rgba_data, width, height))
}

/// Capture a region using absolute screen coordinates (can span multiple monitors).
pub fn capture_screen_region_raw(selection: ScreenRegionSelection) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    if monitors.is_empty() {
        return Err(CaptureError::MonitorNotFound);
    }

    let sel_x = selection.x;
    let sel_y = selection.y;
    let sel_w = selection.width as i32;
    let sel_h = selection.height as i32;
    let sel_right = sel_x + sel_w;
    let sel_bottom = sel_y + sel_h;

    // Find monitors that overlap with the selection
    let mut overlapping: Vec<(usize, &Monitor)> = Vec::new();
    for (idx, mon) in monitors.iter().enumerate() {
        let mon_x = mon.x().unwrap_or(0);
        let mon_y = mon.y().unwrap_or(0);
        let mon_w = mon.width().unwrap_or(0) as i32;
        let mon_h = mon.height().unwrap_or(0) as i32;
        let mon_right = mon_x + mon_w;
        let mon_bottom = mon_y + mon_h;

        // Check for overlap
        if sel_x < mon_right && sel_right > mon_x && sel_y < mon_bottom && sel_bottom > mon_y {
            overlapping.push((idx, mon));
        }
    }

    if overlapping.is_empty() {
        return Err(CaptureError::InvalidRegion);
    }

    // If only one monitor overlaps, use simple region capture
    if overlapping.len() == 1 {
        let (_idx, mon) = overlapping[0];
        let mon_x = mon.x().unwrap_or(0);
        let mon_y = mon.y().unwrap_or(0);
        let mon_scale = mon.scale_factor().unwrap_or(1.0);
        let rel_x = (sel_x - mon_x).max(0) as u32;
        let rel_y = (sel_y - mon_y).max(0) as u32;

        println!("[CAPTURE] Selection: x={}, y={}, w={}, h={}", sel_x, sel_y, selection.width, selection.height);
        println!("[CAPTURE] Monitor: x={}, y={}, scale={}", mon_x, mon_y, mon_scale);
        println!("[CAPTURE] Relative: x={}, y={}", rel_x, rel_y);

        let image = mon
            .capture_region(rel_x, rel_y, selection.width, selection.height)
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture region: {}", e)))?;

        let width = image.width();
        let height = image.height();
        let rgba_data = image.into_raw();

        return Ok((rgba_data, width, height));
    }

    // Multi-monitor: create output buffer and composite captures
    let out_w = selection.width as usize;
    let out_h = selection.height as usize;
    let mut output = vec![0u8; out_w * out_h * 4];

    for (_idx, mon) in overlapping {
        let mon_x = mon.x().unwrap_or(0);
        let mon_y = mon.y().unwrap_or(0);
        let mon_w = mon.width().unwrap_or(0) as i32;
        let mon_h = mon.height().unwrap_or(0) as i32;

        // Calculate intersection
        let inter_left = sel_x.max(mon_x);
        let inter_top = sel_y.max(mon_y);
        let inter_right = sel_right.min(mon_x + mon_w);
        let inter_bottom = sel_bottom.min(mon_y + mon_h);

        if inter_right <= inter_left || inter_bottom <= inter_top {
            continue;
        }

        let cap_x = (inter_left - mon_x) as u32;
        let cap_y = (inter_top - mon_y) as u32;
        let cap_w = (inter_right - inter_left) as u32;
        let cap_h = (inter_bottom - inter_top) as u32;

        let captured = mon
            .capture_region(cap_x, cap_y, cap_w, cap_h)
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture region: {}", e)))?;

        let cap_data = captured.as_raw();
        let actual_cap_w = captured.width() as usize;
        let actual_cap_h = captured.height() as usize;

        // Copy to output buffer
        // Use actual captured dimensions to avoid stride mismatch (rainbow artifacts)
        let dst_x = (inter_left - sel_x) as usize;
        let dst_y = (inter_top - sel_y) as usize;

        // Use the smaller of expected vs actual dimensions to avoid out-of-bounds
        let copy_w = (cap_w as usize).min(actual_cap_w).min(out_w.saturating_sub(dst_x));
        let copy_h = (cap_h as usize).min(actual_cap_h).min(out_h.saturating_sub(dst_y));

        for row in 0..copy_h {
            let src_offset = row * actual_cap_w * 4;  // Use actual stride
            let dst_offset = ((dst_y + row) * out_w + dst_x) * 4;
            let row_bytes = copy_w * 4;

            if src_offset + row_bytes <= cap_data.len() && dst_offset + row_bytes <= output.len() {
                output[dst_offset..dst_offset + row_bytes]
                    .copy_from_slice(&cap_data[src_offset..src_offset + row_bytes]);
            }
        }
    }

    Ok((output, selection.width, selection.height))
}

// ============================================================================
// Helpers
// ============================================================================

/// Encode an RGBA image to base64 PNG for the frontend.
fn encode_image_to_result(image: RgbaImage, has_transparency: bool) -> Result<CaptureResult, CaptureError> {
    let width = image.width();
    let height = image.height();

    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| CaptureError::EncodingFailed(e.to_string()))?;

    let base64_data = STANDARD.encode(buffer.into_inner());

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency,
    })
}
