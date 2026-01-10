//! Screen capture using xcap library.
//!
//! Simple, reliable screenshot capture for monitors, windows, and regions.
//!
//! Note: For layered windows (WS_EX_LAYERED), we call DwmFlush() before capture
//! to ensure DWM completes compositing, avoiding artifacts with transparent windows.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use xcap::{Monitor, Window};

/// Flush DWM composition before capture.
/// This ensures layered windows (transparent windows) are properly composited
/// before BitBlt captures them, preventing flickering/black artifacts.
#[cfg(target_os = "windows")]
fn flush_dwm() {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    unsafe {
        let _ = DwmFlush();
    }
}

use super::types::{
    CaptureError, CaptureResult, MonitorInfo, RegionSelection, ScreenRegionSelection, WindowInfo,
};

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

/// Capture the primary monitor and return raw RGBA data.
pub fn capture_fullscreen_raw() -> Result<(Vec<u8>, u32, u32), CaptureError> {
    // Flush DWM before capture for proper layered window composition
    #[cfg(target_os = "windows")]
    flush_dwm();

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
        let app_name = w.app_name().unwrap_or_default();

        if is_min || width == 0 || height == 0 {
            continue;
        }

        // Skip Windows Explorer (taskbar, desktop, etc.)
        if app_name == "Windows Explorer" {
            continue;
        }

        infos.push(WindowInfo {
            id: w.id().unwrap_or(0),
            title: w.title().unwrap_or_default(),
            app_name,
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            width,
            height,
            is_minimized: is_min,
        });
    }

    Ok(infos)
}

/// Capture a specific window by HWND.
/// Uses screen region capture (BitBlt) instead of PrintWindow to avoid DWM artifacts.
pub fn capture_window(hwnd: isize) -> Result<CaptureResult, CaptureError> {
    let (rgba_data, width, height) = capture_window_raw(hwnd)?;

    // Convert to image and encode
    let image = image::RgbaImage::from_raw(width, height, rgba_data).ok_or_else(|| {
        CaptureError::CaptureFailed("Failed to create image from raw data".into())
    })?;

    encode_image_to_result(image, false)
}

/// Capture a window using full monitor capture + crop.
/// This properly captures WebView2/DWM-composited windows that PrintWindow misses.
/// Reuses capture_screen_region_raw which handles DXGI capture properly.
#[cfg(target_os = "windows")]
pub fn capture_window_xcap(hwnd_value: isize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};

    let hwnd = HWND(hwnd_value as *mut std::ffi::c_void);

    // Get window bounds using DWM (excludes shadow)
    let mut dwm_rect = RECT::default();
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut dwm_rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    };

    if result.is_err() {
        return Err(CaptureError::CaptureFailed(format!(
            "Failed to get window bounds: {:?}",
            result.err()
        )));
    }

    let x = dwm_rect.left;
    let y = dwm_rect.top;
    let width = (dwm_rect.right - dwm_rect.left) as u32;
    let height = (dwm_rect.bottom - dwm_rect.top) as u32;

    if width == 0 || height == 0 {
        return Err(CaptureError::CaptureFailed(
            "Window has zero dimensions".into(),
        ));
    }

    println!(
        "[CAPTURE] Window capture via screen region: hwnd={} (0x{:X}), bounds=({},{}) {}x{}",
        hwnd_value, hwnd_value, x, y, width, height
    );

    // Use the same capture path as Area mode (which works)
    capture_screen_region_raw(ScreenRegionSelection {
        x,
        y,
        width,
        height,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn capture_window_xcap(hwnd_value: isize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    // On non-Windows, just try to find by ID directly
    let windows = Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to enumerate windows: {}", e)))?;

    let target_id = hwnd_value as u32;
    let window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == target_id)
        .ok_or(CaptureError::WindowNotFound)?;

    let image = window
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("xcap capture failed: {}", e)))?;

    Ok((image.into_raw(), image.width(), image.height()))
}

/// Capture a specific window and return raw RGBA data.
/// Uses screen region capture (BitBlt) instead of PrintWindow to avoid DWM artifacts.
#[cfg(target_os = "windows")]
pub fn capture_window_raw(hwnd_value: isize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let hwnd = HWND(hwnd_value as *mut std::ffi::c_void);

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

    println!(
        "[CAPTURE] Capturing region: x={}, y={}, w={}, h={}",
        x, y, width, height
    );

    if width == 0 || height == 0 {
        return Err(CaptureError::CaptureFailed(
            "Window has zero dimensions".into(),
        ));
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
pub fn capture_window_raw(hwnd_value: isize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let window_id = hwnd_value as u32;
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
    // Flush DWM before capture for proper layered window composition
    #[cfg(target_os = "windows")]
    flush_dwm();

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

/// Capture a region using absolute screen coordinates (can span multiple monitors).
pub fn capture_screen_region_raw(
    selection: ScreenRegionSelection,
) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    // Flush DWM before capture to ensure proper composition
    #[cfg(target_os = "windows")]
    flush_dwm();

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

    // If only one monitor overlaps, capture full monitor and crop
    // This uses DXGI Desktop Duplication which properly captures DWM-composited content
    // (including WebView2/transparent windows), unlike BitBlt-based capture_region
    if overlapping.len() == 1 {
        let (_idx, mon) = overlapping[0];
        let mon_x = mon.x().unwrap_or(0);
        let mon_y = mon.y().unwrap_or(0);
        let mon_w = mon.width().unwrap_or(0);
        let mon_h = mon.height().unwrap_or(0);
        let rel_x = (sel_x - mon_x).max(0) as u32;
        let rel_y = (sel_y - mon_y).max(0) as u32;

        println!(
            "[CAPTURE] Region via full capture: sel=({},{}) mon=({},{}) rel=({},{}) size={}x{}",
            sel_x, sel_y, mon_x, mon_y, rel_x, rel_y, selection.width, selection.height
        );

        // Capture full monitor (uses DXGI Desktop Duplication)
        let full_image = mon.capture_image().map_err(|e| {
            CaptureError::CaptureFailed(format!("Failed to capture monitor: {}", e))
        })?;

        // Crop to the region
        let full_width = full_image.width();
        let full_height = full_image.height();
        let full_data = full_image.into_raw();

        // Clamp region to monitor bounds
        let crop_x = rel_x.min(full_width.saturating_sub(1));
        let crop_y = rel_y.min(full_height.saturating_sub(1));
        let crop_w = selection.width.min(full_width.saturating_sub(crop_x));
        let crop_h = selection.height.min(full_height.saturating_sub(crop_y));

        if crop_w == 0 || crop_h == 0 {
            return Err(CaptureError::InvalidRegion);
        }

        // Extract the cropped region
        let mut cropped = vec![0u8; (crop_w * crop_h * 4) as usize];
        for row in 0..crop_h as usize {
            let src_offset = ((crop_y as usize + row) * full_width as usize + crop_x as usize) * 4;
            let dst_offset = row * crop_w as usize * 4;
            let row_bytes = crop_w as usize * 4;

            if src_offset + row_bytes <= full_data.len() {
                cropped[dst_offset..dst_offset + row_bytes]
                    .copy_from_slice(&full_data[src_offset..src_offset + row_bytes]);
            }
        }

        return Ok((cropped, crop_w, crop_h));
    }

    // Multi-monitor: capture each monitor fully and composite
    // Uses DXGI Desktop Duplication for proper DWM content capture
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

        // Capture full monitor (uses DXGI Desktop Duplication)
        let full_image = match mon.capture_image() {
            Ok(img) => img,
            Err(e) => {
                println!("[CAPTURE] Failed to capture monitor: {}", e);
                continue;
            },
        };

        let full_width = full_image.width() as usize;
        let full_data = full_image.into_raw();

        // Calculate crop region within monitor
        let crop_x = (inter_left - mon_x) as usize;
        let crop_y = (inter_top - mon_y) as usize;
        let crop_w = (inter_right - inter_left) as usize;
        let crop_h = (inter_bottom - inter_top) as usize;

        // Calculate destination in output buffer
        let dst_x = (inter_left - sel_x) as usize;
        let dst_y = (inter_top - sel_y) as usize;

        // Copy cropped region to output
        for row in 0..crop_h {
            let src_offset = ((crop_y + row) * full_width + crop_x) * 4;
            let dst_offset = ((dst_y + row) * out_w + dst_x) * 4;
            let row_bytes = crop_w * 4;

            if src_offset + row_bytes <= full_data.len() && dst_offset + row_bytes <= output.len() {
                output[dst_offset..dst_offset + row_bytes]
                    .copy_from_slice(&full_data[src_offset..src_offset + row_bytes]);
            }
        }
    }

    Ok((output, selection.width, selection.height))
}

// ============================================================================
// Helpers
// ============================================================================

/// Encode an RGBA image to base64 PNG for the frontend.
fn encode_image_to_result(
    image: RgbaImage,
    has_transparency: bool,
) -> Result<CaptureResult, CaptureError> {
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
