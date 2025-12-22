//! Screen and window capture module with transparency support.
//!
//! This module provides high-quality screen capture with the following features:
//! - Full transparency (alpha channel) support via Windows Graphics Capture API
//! - Automatic fallback to xcap when WGC is unavailable
//! - Region, window, and fullscreen capture modes
//!
//! The capture system uses a priority-based approach:
//! 1. Windows Graphics Capture (WGC) - Best quality, transparency support
//! 2. xcap fallback - Broad compatibility

pub mod fallback;
pub mod types;
pub mod wgc;

pub use types::{CaptureResult, FastCaptureResult, MonitorInfo, RegionSelection, ScreenRegionSelection, WindowInfo};

use tauri::command;
use std::io::Write;

/// Get all available monitors.
#[command]
pub async fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    fallback::get_monitors().map_err(|e| e.to_string())
}

/// Get all capturable windows.
#[command]
pub async fn get_windows() -> Result<Vec<WindowInfo>, String> {
    fallback::get_windows().map_err(|e| e.to_string())
}

/// Capture a specific window by its ID.
///
/// Attempts to use Windows Graphics Capture API first for transparency support,
/// falls back to xcap if WGC fails.
#[command]
pub async fn capture_window(window_id: u32) -> Result<CaptureResult, String> {
    // Try WGC first for better transparency support
    if wgc::is_available() {
        match wgc::capture_window(window_id as isize) {
            Ok(result) => return Ok(result),
            Err(_) => {}
        }
    }

    // Fallback to xcap
    fallback::capture_window(window_id).map_err(|e| e.to_string())
}

/// Capture a specific region from the screen.
///
/// Uses xcap for region capture (WGC doesn't directly support arbitrary regions).
#[command]
pub async fn capture_region(selection: RegionSelection) -> Result<CaptureResult, String> {
    // For region capture, we use the fallback since WGC captures entire windows/monitors
    // In the future, we could capture the monitor via WGC and crop
    fallback::capture_region(selection).map_err(|e| e.to_string())
}

/// Capture fullscreen (primary monitor).
///
/// Attempts to use Windows Graphics Capture API first,
/// falls back to xcap if WGC fails.
#[command]
pub async fn capture_fullscreen() -> Result<CaptureResult, String> {
    // Try WGC first
    if wgc::is_available() {
        // Find primary monitor index
        let monitors = fallback::get_monitors().map_err(|e| e.to_string())?;
        let primary_index = monitors
            .iter()
            .position(|m| m.is_primary)
            .unwrap_or(0);

        match wgc::capture_monitor(primary_index) {
            Ok(result) => return Ok(result),
            Err(_) => {}
        }
    }

    // Fallback to xcap
    fallback::capture_fullscreen().map_err(|e| e.to_string())
}

/// Get window at a specific screen coordinate.
///
/// This function is re-exported from the screenshot module for backward compatibility.
#[cfg(target_os = "windows")]
#[command]
pub async fn get_window_at_point(x: i32, y: i32) -> Result<Option<WindowInfo>, String> {
    use windows::Win32::{
        Foundation::POINT,
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{GetAncestor, GetWindow, WindowFromPoint, GA_ROOT, GW_HWNDNEXT},
    };

    let point = POINT { x, y };

    unsafe {
        let current_process_id = GetCurrentProcessId();

        let hwnd_at_point = WindowFromPoint(point);
        if hwnd_at_point.0.is_null() {
            return Ok(None);
        }

        let ancestor = GetAncestor(hwnd_at_point, GA_ROOT);
        let root_hwnd = if !ancestor.0.is_null() {
            ancestor
        } else {
            hwnd_at_point
        };

        let mut current_hwnd = root_hwnd;

        loop {
            if let Some(info) = try_get_window_info(current_hwnd, current_process_id, point) {
                return Ok(Some(info));
            }

            match GetWindow(current_hwnd, GW_HWNDNEXT) {
                Ok(next_hwnd) if !next_hwnd.0.is_null() => {
                    current_hwnd = next_hwnd;

                    if !is_point_in_hwnd(current_hwnd, point) {
                        continue;
                    }
                }
                _ => break,
            }
        }

        Ok(None)
    }
}

#[cfg(target_os = "windows")]
fn get_process_name(process_id: u32) -> String {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id);
        if let Ok(handle) = handle {
            let mut buffer = [0u16; 260];
            let mut size = buffer.len() as u32;
            
            if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut size).is_ok() {
                let _ = CloseHandle(handle);
                let path = String::from_utf16_lossy(&buffer[..size as usize]);
                // Extract just the filename from the path
                return path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
            }
            let _ = CloseHandle(handle);
        }
        String::new()
    }
}

#[cfg(target_os = "windows")]
fn try_get_window_info(
    hwnd: windows::Win32::Foundation::HWND,
    current_process_id: u32,
    point: windows::Win32::Foundation::POINT,
) -> Option<WindowInfo> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{
            GetClassNameW, GetLayeredWindowAttributes, GetWindowLongW,
            GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
            IsWindowVisible, GWL_EXSTYLE, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA,
            WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        },
    };

    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        
        // Check if window is cloaked (hidden by DWM - catches UWP hidden windows)
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        ).is_ok() && cloaked != 0 {
            return None;
        }

        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == current_process_id {
            return None;
        }

        if !is_point_in_hwnd(hwnd, point) {
            return None;
        }

        // Use DWMWA_EXTENDED_FRAME_BOUNDS to get visible bounds (excludes shadow, includes titlebar)
        let mut rect = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        ).is_err() {
            return None;
        }

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;

        if width < 50 || height < 50 {
            return None;
        }

        let title_len = GetWindowTextLengthW(hwnd);
        let title = if title_len > 0 {
            let mut buffer = vec![0u16; (title_len + 1) as usize];
            GetWindowTextW(hwnd, &mut buffer);
            String::from_utf16_lossy(&buffer[..title_len as usize])
        } else {
            String::new()
        };

        if title.is_empty() {
            return None;
        }

        let mut class_name_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_name_buf);
        let class_name = if class_len > 0 {
            String::from_utf16_lossy(&class_name_buf[..class_len as usize])
        } else {
            String::new()
        };

        // Filter system windows
        match class_name.as_str() {
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow"
            | "Windows.UI.Core.CoreWindow" | "Progman" | "WorkerW" => return None,
            _ => {}
        }

        // Get process name directly from Windows API
        let app_name = get_process_name(process_id);
        let app_lower = app_name.to_lowercase();
        
        // Filter out our own SnapIt windows
        if app_lower.contains("snapit") {
            return None;
        }
        
        // Filter ApplicationFrameHost.exe - UWP container process, not the actual app
        if app_lower == "applicationframehost.exe" {
            return None;
        }
        
        // Filter known hidden/popup UI elements by title
        let title_lower = title.to_lowercase();
        if matches!(title_lower.as_str(), 
            "command palette" | "quick pick" | "go to file" | "go to symbol"
            | "input" | "dropdown" | "tooltip" | "popup" | "menu window"
        ) {
            return None;
        }
        
        // Filter webview windows with generic titles (likely our settings modal)
        if class_name.starts_with("Chrome_") || class_name.contains("WebView") {
            if title_lower == "settings" || title.is_empty() {
                return None;
            }
        }

        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;

        if (ex_style & WS_EX_TRANSPARENT.0) != 0 {
            return None;
        }

        if (ex_style & WS_EX_LAYERED.0) != 0 {
            let mut alpha = 255u8;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS::default();
            if GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut flags)).is_ok() {
                if (flags & LWA_ALPHA).0 != 0 && alpha < 30 {
                    return None;
                }
            }
        }

        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 && title.is_empty() {
            return None;
        }

        let hwnd_id = hwnd.0 as u32;

        Some(WindowInfo {
            id: hwnd_id,
            title,
            app_name,
            x: rect.left,
            y: rect.top,
            width,
            height,
            is_minimized: false,
        })
    }
}

#[cfg(target_os = "windows")]
fn is_point_in_hwnd(
    hwnd: windows::Win32::Foundation::HWND,
    point: windows::Win32::Foundation::POINT,
) -> bool {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
    };

    unsafe {
        let mut rect = RECT::default();
        // Use DWMWA_EXTENDED_FRAME_BOUNDS for visible bounds (excludes shadow)
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        ).is_ok() {
            point.x >= rect.left
                && point.x < rect.right
                && point.y >= rect.top
                && point.y < rect.bottom
        } else {
            false
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[command]
pub async fn get_window_at_point(x: i32, y: i32) -> Result<Option<WindowInfo>, String> {
    use xcap::Window;

    let windows =
        Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    let mut candidates: Vec<_> = windows
        .iter()
        .filter(|w| {
            let wx = w.x().unwrap_or(0);
            let wy = w.y().unwrap_or(0);
            let ww = w.width().unwrap_or(0) as i32;
            let wh = w.height().unwrap_or(0) as i32;
            x >= wx && x < wx + ww && y >= wy && y < wy + wh
        })
        .collect();

    candidates.sort_by_key(|w| {
        let width = w.width().unwrap_or(0) as i64;
        let height = w.height().unwrap_or(0) as i64;
        width * height
    });

    Ok(candidates.first().map(|w| WindowInfo {
        id: w.id().unwrap_or(0),
        title: w.title().unwrap_or_default(),
        app_name: w.app_name().unwrap_or_default(),
        x: w.x().unwrap_or(0),
        y: w.y().unwrap_or(0),
        width: w.width().unwrap_or(0),
        height: w.height().unwrap_or(0),
        is_minimized: w.is_minimized().unwrap_or(false),
    }))
}

// ============================================================================
// Fast Capture Commands (skip PNG encoding for editor display)
// ============================================================================

/// Write raw RGBA bytes to a temporary file and return the path.
fn write_rgba_to_temp_file(rgba_data: &[u8], width: u32, height: u32) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let temp_dir = std::env::temp_dir();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_name = format!("snapit_capture_{}_{}.rgba", timestamp, std::process::id());
    let file_path = temp_dir.join(file_name);

    let mut file = std::fs::File::create(&file_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    // Write a simple header: width (4 bytes), height (4 bytes), then RGBA data
    file.write_all(&width.to_le_bytes())
        .map_err(|e| format!("Failed to write width: {}", e))?;
    file.write_all(&height.to_le_bytes())
        .map_err(|e| format!("Failed to write height: {}", e))?;
    file.write_all(rgba_data)
        .map_err(|e| format!("Failed to write RGBA data: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// Fast capture of a window - returns file path instead of base64.
/// Skips PNG encoding for ~300-500ms savings on large captures.
#[command]
pub async fn capture_window_fast(window_id: u32) -> Result<FastCaptureResult, String> {
    let total_start = std::time::Instant::now();

    // Try WGC first for transparency support
    if wgc::is_available() {
        let wgc_start = std::time::Instant::now();
        match wgc::capture_window_raw(window_id as isize) {
            Ok((rgba_data, width, height)) => {
                println!("[TIMING] WGC capture: {:?}", wgc_start.elapsed());

                let write_start = std::time::Instant::now();
                let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
                println!("[TIMING] File write ({}x{}, {} bytes): {:?}",
                    width, height, rgba_data.len(), write_start.elapsed());

                println!("[TIMING] capture_window_fast TOTAL: {:?}", total_start.elapsed());
                return Ok(FastCaptureResult {
                    file_path,
                    width,
                    height,
                    has_transparency: true,
                });
            }
            Err(e) => {
                println!("[TIMING] WGC failed: {:?}, falling back", e);
            }
        }
    }

    // Fallback to xcap (still need to get raw data)
    let xcap_start = std::time::Instant::now();
    fallback::capture_window_raw(window_id)
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            println!("[TIMING] xcap capture: {:?}", xcap_start.elapsed());

            let write_start = std::time::Instant::now();
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
            println!("[TIMING] File write: {:?}", write_start.elapsed());

            println!("[TIMING] capture_window_fast TOTAL: {:?}", total_start.elapsed());
            Ok(FastCaptureResult {
                file_path,
                width,
                height,
                has_transparency: false,
            })
        })
}

/// Fast capture of a region - returns file path instead of base64.
#[command]
pub async fn capture_region_fast(selection: RegionSelection) -> Result<FastCaptureResult, String> {
    let total_start = std::time::Instant::now();

    let capture_start = std::time::Instant::now();
    let result = fallback::capture_region_raw(selection);
    println!("[TIMING] Region capture: {:?}", capture_start.elapsed());

    result
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            let write_start = std::time::Instant::now();
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
            println!("[TIMING] File write: {:?}", write_start.elapsed());
            println!("[TIMING] capture_region_fast TOTAL: {:?}", total_start.elapsed());

            Ok(FastCaptureResult {
                file_path,
                width,
                height,
                has_transparency: false,
            })
        })
}

/// Fast capture of a screen region (multi-monitor support).
/// Uses absolute screen coordinates and can stitch captures from multiple monitors.
#[command]
pub async fn capture_screen_region_fast(selection: ScreenRegionSelection) -> Result<FastCaptureResult, String> {
    let total_start = std::time::Instant::now();

    let capture_start = std::time::Instant::now();
    let result = fallback::capture_screen_region_raw(selection);
    println!("[TIMING] Screen region capture: {:?}", capture_start.elapsed());

    result
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            let write_start = std::time::Instant::now();
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
            println!("[TIMING] File write: {:?}", write_start.elapsed());
            println!("[TIMING] capture_screen_region_fast TOTAL: {:?}", total_start.elapsed());

            Ok(FastCaptureResult {
                file_path,
                width,
                height,
                has_transparency: false,
            })
        })
}

/// Fast capture of fullscreen - returns file path instead of base64.
#[command]
pub async fn capture_fullscreen_fast() -> Result<FastCaptureResult, String> {
    let total_start = std::time::Instant::now();

    // Try WGC first
    if wgc::is_available() {
        let monitors = fallback::get_monitors().map_err(|e| e.to_string())?;
        let primary_index = monitors
            .iter()
            .position(|m| m.is_primary)
            .unwrap_or(0);

        let wgc_start = std::time::Instant::now();
        match wgc::capture_monitor_raw(primary_index) {
            Ok((rgba_data, width, height)) => {
                println!("[TIMING] WGC fullscreen capture: {:?}", wgc_start.elapsed());

                let write_start = std::time::Instant::now();
                let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
                println!("[TIMING] File write: {:?}", write_start.elapsed());
                println!("[TIMING] capture_fullscreen_fast TOTAL: {:?}", total_start.elapsed());

                return Ok(FastCaptureResult {
                    file_path,
                    width,
                    height,
                    has_transparency: false,
                });
            }
            Err(_) => {}
        }
    }

    // Fallback to xcap
    let xcap_start = std::time::Instant::now();
    fallback::capture_fullscreen_raw()
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            println!("[TIMING] xcap fullscreen capture: {:?}", xcap_start.elapsed());

            let write_start = std::time::Instant::now();
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
            println!("[TIMING] File write: {:?}", write_start.elapsed());
            println!("[TIMING] capture_fullscreen_fast TOTAL: {:?}", total_start.elapsed());

            Ok(FastCaptureResult {
                file_path,
                width,
                height,
                has_transparency: false,
            })
        })
}

/// Read raw RGBA data from a temp file (for converting to PNG when saving).
#[command]
pub async fn read_rgba_file(file_path: String) -> Result<CaptureResult, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use image::{DynamicImage, RgbaImage};
    use std::io::{Cursor, Read};

    let mut file = std::fs::File::open(&file_path)
        .map_err(|e| format!("Failed to open temp file: {}", e))?;

    // Read header
    let mut width_bytes = [0u8; 4];
    let mut height_bytes = [0u8; 4];
    file.read_exact(&mut width_bytes)
        .map_err(|e| format!("Failed to read width: {}", e))?;
    file.read_exact(&mut height_bytes)
        .map_err(|e| format!("Failed to read height: {}", e))?;

    let width = u32::from_le_bytes(width_bytes);
    let height = u32::from_le_bytes(height_bytes);

    // Read RGBA data
    let expected_size = (width * height * 4) as usize;
    let mut rgba_data = vec![0u8; expected_size];
    file.read_exact(&mut rgba_data)
        .map_err(|e| format!("Failed to read RGBA data: {}", e))?;

    // Encode to PNG
    let image = RgbaImage::from_raw(width, height, rgba_data)
        .ok_or_else(|| "Failed to create image from buffer".to_string())?;
    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;

    let base64_data = STANDARD.encode(buffer.into_inner());

    // Clean up temp file
    let _ = std::fs::remove_file(&file_path);

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency: true,
    })
}

/// Clean up a temp RGBA file.
#[command]
pub async fn cleanup_rgba_file(file_path: String) -> Result<(), String> {
    std::fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete temp file: {}", e))
}
