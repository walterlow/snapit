//! Fallback capture implementation using xcap.
//!
//! Provides compatibility when Windows Graphics Capture or DXGI is unavailable.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use xcap::{Monitor, Window};

use super::types::{CaptureError, CaptureResult, MonitorInfo, RegionSelection, ScreenRegionSelection, WindowInfo};

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
    let start = std::time::Instant::now();

    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;
    println!("[TIMING] xcap Monitor::all(): {:?}", start.elapsed());

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

    let capture_start = std::time::Instant::now();
    let full_image = target_monitor
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture screen: {}", e)))?;
    println!("[TIMING] xcap monitor.capture_image(): {:?} ({}x{})",
        capture_start.elapsed(), full_image.width(), full_image.height());

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

    // Fast crop using direct memory copy instead of image crate's crop
    // This avoids DynamicImage conversion overhead
    let crop_start = std::time::Instant::now();
    let cropped = fast_crop(&full_image, rel_x, rel_y, crop_width, crop_height);
    println!("[TIMING] xcap crop: {:?}", crop_start.elapsed());

    Ok(cropped)
}

/// Fast crop using direct memory copy - avoids image crate overhead.
fn fast_crop(src: &RgbaImage, x: u32, y: u32, width: u32, height: u32) -> RgbaImage {
    let src_width = src.width();
    let src_data = src.as_raw();

    // Pre-allocate destination buffer
    let mut dst_data = vec![0u8; (width * height * 4) as usize];

    // Copy row by row
    let src_stride = (src_width * 4) as usize;
    let dst_stride = (width * 4) as usize;

    for row in 0..height {
        let src_offset = ((y + row) as usize * src_stride) + (x as usize * 4);
        let dst_offset = row as usize * dst_stride;

        dst_data[dst_offset..dst_offset + dst_stride]
            .copy_from_slice(&src_data[src_offset..src_offset + dst_stride]);
    }

    RgbaImage::from_raw(width, height, dst_data)
        .expect("Buffer size matches dimensions")
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

    let max_width = full_image.width().saturating_sub(rel_x);
    let max_height = full_image.height().saturating_sub(rel_y);
    let crop_width = scaled_width.min(max_width);
    let crop_height = scaled_height.min(max_height);

    if crop_width == 0 || crop_height == 0 {
        return Err(CaptureError::InvalidRegion);
    }

    // Use fast crop instead of image crate's slow crop_imm
    let cropped = fast_crop(&full_image, rel_x, rel_y, crop_width, crop_height);

    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(cropped.clone())
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
    let (rgba_data, width, height) = capture_fullscreen_raw()?;

    let image = RgbaImage::from_raw(width, height, rgba_data)
        .ok_or_else(|| CaptureError::EncodingFailed("Failed to create image from buffer".to_string()))?;
    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| CaptureError::EncodingFailed(e.to_string()))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency: false,
    })
}

// ============================================================================
// Raw Capture Functions (skip PNG encoding for fast editor display)
// ============================================================================

/// Capture a window and return raw RGBA data.
pub fn capture_window_raw(window_id: u32) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let total_start = std::time::Instant::now();

    // Get window bounds directly from Windows API first (faster than enumerating all windows)
    let win_rect_start = std::time::Instant::now();
    let (win_x, win_y, win_width, win_height) = get_window_rect_win32(window_id)
        .ok_or(CaptureError::WindowNotFound)?;
    println!("[TIMING] xcap get_window_rect_win32: {:?}", win_rect_start.elapsed());

    // Try monitor capture + crop first - it's often faster and more reliable
    let monitor_start = std::time::Instant::now();
    match capture_screen_region(win_x, win_y, win_width, win_height) {
        Ok(image) => {
            println!("[TIMING] xcap monitor+crop capture: {:?}", monitor_start.elapsed());
            let width = image.width();
            let height = image.height();
            let rgba_data = image.into_raw();
            println!("[TIMING] xcap capture_window_raw TOTAL: {:?}", total_start.elapsed());
            return Ok((rgba_data, width, height));
        }
        Err(e) => {
            println!("[TIMING] xcap monitor+crop failed: {:?}, trying direct capture", e);
        }
    }

    // Fallback: enumerate windows and use direct capture
    let enum_start = std::time::Instant::now();
    let windows =
        Window::all().map_err(|e| CaptureError::CaptureFailed(format!("Failed to get windows: {}", e)))?;
    println!("[TIMING] xcap Window::all(): {:?} ({} windows)", enum_start.elapsed(), windows.len());

    let target_window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or(CaptureError::WindowNotFound)?;

    if target_window.is_minimized().unwrap_or(false) {
        return Err(CaptureError::WindowMinimized);
    }

    // Try direct window capture
    let capture_start = std::time::Instant::now();
    let image = match target_window.capture_image() {
        Ok(img) if !is_capture_invalid(&img) => {
            println!("[TIMING] xcap direct capture_image: {:?}", capture_start.elapsed());
            img
        },
        _ => {
            println!("[TIMING] xcap direct capture failed, using screen region");
            capture_screen_region(win_x, win_y, win_width, win_height)?
        }
    };

    let width = image.width();
    let height = image.height();
    let rgba_data = image.into_raw();
    println!("[TIMING] xcap capture_window_raw TOTAL: {:?}", total_start.elapsed());

    Ok((rgba_data, width, height))
}

/// Capture a region and return raw RGBA data.
pub fn capture_region_raw(selection: RegionSelection) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    let monitor = monitors
        .get(selection.monitor_id as usize)
        .ok_or(CaptureError::MonitorNotFound)?;

    let full_image = monitor
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture screen: {}", e)))?;

    // Get scale factor
    let scale_factor = monitor.scale_factor().unwrap_or(1.0) as f32;

    let monitor_x = monitor.x().unwrap_or(0);
    let monitor_y = monitor.y().unwrap_or(0);

    // Scale coordinates from logical to physical pixels
    let rel_x = ((selection.x - monitor_x).max(0) as f32 * scale_factor).round() as u32;
    let rel_y = ((selection.y - monitor_y).max(0) as f32 * scale_factor).round() as u32;
    let scaled_width = (selection.width as f32 * scale_factor).round() as u32;
    let scaled_height = (selection.height as f32 * scale_factor).round() as u32;

    let max_width = full_image.width().saturating_sub(rel_x);
    let max_height = full_image.height().saturating_sub(rel_y);
    let crop_width = scaled_width.min(max_width);
    let crop_height = scaled_height.min(max_height);

    if crop_width == 0 || crop_height == 0 {
        return Err(CaptureError::InvalidRegion);
    }

    // Use fast crop instead of image crate's slow crop_imm
    let cropped = fast_crop(&full_image, rel_x, rel_y, crop_width, crop_height);
    let width = cropped.width();
    let height = cropped.height();
    let rgba_data = cropped.into_raw();

    Ok((rgba_data, width, height))
}

/// Capture fullscreen and return raw RGBA data.
pub fn capture_fullscreen_raw() -> Result<(Vec<u8>, u32, u32), CaptureError> {
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

    let width = image.width();
    let height = image.height();
    let rgba_data = image.into_raw();

    Ok((rgba_data, width, height))
}

// ============================================================================
// Multi-Monitor Capture (stitches captures from multiple monitors)
// ============================================================================

/// Capture a region that may span multiple monitors.
/// Uses screen coordinates (virtual desktop space) and stitches monitor captures together.
pub fn capture_screen_region_raw(selection: ScreenRegionSelection) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let start = std::time::Instant::now();

    let monitors = Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to get monitors: {}", e)))?;

    if monitors.is_empty() {
        return Err(CaptureError::MonitorNotFound);
    }

    // Selection bounds in screen coordinates
    let sel_left = selection.x;
    let sel_top = selection.y;
    let sel_right = selection.x + selection.width as i32;
    let sel_bottom = selection.y + selection.height as i32;

    // Find all monitors that overlap with the selection
    let overlapping: Vec<_> = monitors
        .iter()
        .filter(|m| {
            let mx = m.x().unwrap_or(0);
            let my = m.y().unwrap_or(0);
            let mw = m.width().unwrap_or(0) as i32;
            let mh = m.height().unwrap_or(0) as i32;

            // Check for intersection
            let intersects = mx < sel_right && mx + mw > sel_left &&
                           my < sel_bottom && my + mh > sel_top;
            intersects
        })
        .collect();

    if overlapping.is_empty() {
        return Err(CaptureError::InvalidRegion);
    }

    println!("[TIMING] Multi-monitor: {} monitors overlap selection", overlapping.len());

    // If only one monitor overlaps, use the fast single-monitor path
    if overlapping.len() == 1 {
        let monitor = overlapping[0];
        let scale = monitor.scale_factor().unwrap_or(1.0) as f32;
        let mx = monitor.x().unwrap_or(0);
        let my = monitor.y().unwrap_or(0);

        let capture_start = std::time::Instant::now();
        let full_image = monitor
            .capture_image()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture: {}", e)))?;
        println!("[TIMING] Single monitor capture: {:?}", capture_start.elapsed());

        // Calculate crop region relative to monitor (in physical pixels)
        let rel_x = ((sel_left - mx).max(0) as f32 * scale).round() as u32;
        let rel_y = ((sel_top - my).max(0) as f32 * scale).round() as u32;
        let scaled_width = (selection.width as f32 * scale).round() as u32;
        let scaled_height = (selection.height as f32 * scale).round() as u32;

        let max_width = full_image.width().saturating_sub(rel_x);
        let max_height = full_image.height().saturating_sub(rel_y);
        let crop_width = scaled_width.min(max_width);
        let crop_height = scaled_height.min(max_height);

        if crop_width == 0 || crop_height == 0 {
            return Err(CaptureError::InvalidRegion);
        }

        let cropped = fast_crop(&full_image, rel_x, rel_y, crop_width, crop_height);
        println!("[TIMING] capture_screen_region_raw TOTAL: {:?}", start.elapsed());

        return Ok((cropped.into_raw(), crop_width, crop_height));
    }

    // Multi-monitor path: capture and stitch
    // For simplicity, assume all monitors have the same scale factor
    // (mixed DPI is complex and rare)
    let scale = overlapping[0].scale_factor().unwrap_or(1.0) as f32;

    // Calculate output dimensions in physical pixels
    let output_width = (selection.width as f32 * scale).round() as u32;
    let output_height = (selection.height as f32 * scale).round() as u32;

    // Create output buffer (initialized to transparent/black)
    let mut output = vec![0u8; (output_width * output_height * 4) as usize];

    // Capture each monitor and composite onto output
    for monitor in &overlapping {
        let mx = monitor.x().unwrap_or(0);
        let my = monitor.y().unwrap_or(0);
        let monitor_scale = monitor.scale_factor().unwrap_or(1.0) as f32;

        let capture_start = std::time::Instant::now();
        let monitor_image = match monitor.capture_image() {
            Ok(img) => img,
            Err(e) => {
                println!("[WARN] Failed to capture monitor: {}", e);
                continue;
            }
        };
        println!("[TIMING] Monitor capture: {:?}", capture_start.elapsed());

        // Calculate the intersection between selection and this monitor
        let mw = monitor.width().unwrap_or(0) as i32;
        let mh = monitor.height().unwrap_or(0) as i32;

        let intersect_left = sel_left.max(mx);
        let intersect_top = sel_top.max(my);
        let intersect_right = sel_right.min(mx + mw);
        let intersect_bottom = sel_bottom.min(my + mh);

        if intersect_left >= intersect_right || intersect_top >= intersect_bottom {
            continue;
        }

        // Source region in monitor's image (physical pixels)
        let src_x = ((intersect_left - mx) as f32 * monitor_scale).round() as u32;
        let src_y = ((intersect_top - my) as f32 * monitor_scale).round() as u32;
        let src_w = ((intersect_right - intersect_left) as f32 * monitor_scale).round() as u32;
        let src_h = ((intersect_bottom - intersect_top) as f32 * monitor_scale).round() as u32;

        // Destination position in output buffer (physical pixels)
        let dst_x = ((intersect_left - sel_left) as f32 * scale).round() as u32;
        let dst_y = ((intersect_top - sel_top) as f32 * scale).round() as u32;

        // Bounds check
        let src_w = src_w.min(monitor_image.width().saturating_sub(src_x));
        let src_h = src_h.min(monitor_image.height().saturating_sub(src_y));
        let dst_w = src_w.min(output_width.saturating_sub(dst_x));
        let dst_h = src_h.min(output_height.saturating_sub(dst_y));

        if dst_w == 0 || dst_h == 0 {
            continue;
        }

        // Copy pixels from monitor capture to output buffer
        let src_data = monitor_image.as_raw();
        let src_stride = (monitor_image.width() * 4) as usize;
        let dst_stride = (output_width * 4) as usize;

        for row in 0..dst_h {
            let src_offset = ((src_y + row) as usize * src_stride) + (src_x as usize * 4);
            let dst_offset = ((dst_y + row) as usize * dst_stride) + (dst_x as usize * 4);
            let copy_len = (dst_w * 4) as usize;

            if src_offset + copy_len <= src_data.len() && dst_offset + copy_len <= output.len() {
                output[dst_offset..dst_offset + copy_len]
                    .copy_from_slice(&src_data[src_offset..src_offset + copy_len]);
            }
        }
    }

    println!("[TIMING] capture_screen_region_raw TOTAL: {:?}", start.elapsed());
    Ok((output, output_width, output_height))
}
