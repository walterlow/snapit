//! Screen and window capture module.
//!
//! - WGC: Window captures (transparency support)
//! - xcap: Region/fullscreen captures (reliable, no padding issues)

pub mod fallback;
pub mod types;
pub mod wgc;

pub use types::{CaptureResult, FastCaptureResult, MonitorInfo, RegionSelection, ScreenRegionSelection, VirtualScreenBounds, WindowInfo};

use tauri::{command, Emitter};
use std::io::Write;
use std::sync::atomic::{AtomicI32, Ordering};

// Track which monitor is currently detecting windows to prevent duplicate borders
// When a monitor calls get_window_at_point, it becomes the "active" monitor
// Other monitors' pending requests will return None
static ACTIVE_WINDOW_DETECT_MONITOR: AtomicI32 = AtomicI32::new(-1);

/// Get all available monitors.
#[command]
pub async fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    fallback::get_monitors().map_err(|e| e.to_string())
}

/// Get the bounding box of all monitors combined (virtual screen bounds).
/// This is useful for capturing all monitors at once.
#[command]
pub async fn get_virtual_screen_bounds() -> Result<VirtualScreenBounds, String> {
    let monitors = fallback::get_monitors().map_err(|e| e.to_string())?;

    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    for mon in &monitors {
        min_x = min_x.min(mon.x);
        min_y = min_y.min(mon.y);
        max_x = max_x.max(mon.x + mon.width as i32);
        max_y = max_y.max(mon.y + mon.height as i32);
    }

    Ok(VirtualScreenBounds {
        x: min_x,
        y: min_y,
        width: (max_x - min_x) as u32,
        height: (max_y - min_y) as u32,
    })
}

/// Get all capturable windows.
#[command]
pub async fn get_windows() -> Result<Vec<WindowInfo>, String> {
    fallback::get_windows().map_err(|e| e.to_string())
}

/// Capture a specific window by its ID.
/// Uses WGC for transparency support, falls back to xcap.
#[command]
pub async fn capture_window(window_id: u32) -> Result<CaptureResult, String> {
    match wgc::capture_window(window_id as isize) {
        Ok(result) => Ok(result),
        Err(e) => {
            println!("[CAPTURE] WGC window failed: {:?}, trying xcap", e);
            fallback::capture_window(window_id).map_err(|e| e.to_string())
        }
    }
}

/// Capture a specific region from the screen.
#[command]
pub async fn capture_region(selection: RegionSelection) -> Result<CaptureResult, String> {
    fallback::capture_region(selection).map_err(|e| e.to_string())
}

/// Capture fullscreen (primary monitor).
#[command]
pub async fn capture_fullscreen() -> Result<CaptureResult, String> {
    fallback::capture_fullscreen().map_err(|e| e.to_string())
}

/// Get window at a specific screen coordinate.
///
/// The monitor_index parameter is used to track which overlay is currently detecting windows.
/// This prevents duplicate borders when rapidly switching between monitors - only the most
/// recent monitor to request detection will receive results.
#[cfg(target_os = "windows")]
#[command]
pub async fn get_window_at_point(app: tauri::AppHandle, x: i32, y: i32, monitor_index: i32) -> Result<Option<WindowInfo>, String> {
    use windows::Win32::{
        Foundation::POINT,
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{GetAncestor, GetWindow, WindowFromPoint, GA_ROOT, GW_HWNDNEXT},
    };

    // Mark this monitor as the active one for window detection
    // If a different monitor was previously active, emit event to clear its hover state
    let previous_monitor = ACTIVE_WINDOW_DETECT_MONITOR.swap(monitor_index, Ordering::SeqCst);
    if previous_monitor != monitor_index && previous_monitor >= 0 {
        // Tell the previous monitor to clear its hovered window
        let _ = app.emit("clear-hovered-window", previous_monitor);
    }

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
                // Before returning, check if we're still the active monitor
                // If another monitor has since requested detection, return None
                // to prevent duplicate borders
                if ACTIVE_WINDOW_DETECT_MONITOR.load(Ordering::SeqCst) != monitor_index {
                    return Ok(None);
                }
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
pub async fn get_window_at_point(_app: tauri::AppHandle, _x: i32, _y: i32, _monitor_index: i32) -> Result<Option<WindowInfo>, String> {
    // Window detection not supported on non-Windows platforms
    Ok(None)
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
/// Uses WGC for transparency support, falls back to xcap.
#[command]
pub async fn capture_window_fast(window_id: u32) -> Result<FastCaptureResult, String> {
    // Try WGC first for transparency
    match wgc::capture_window_raw(window_id as isize) {
        Ok((rgba_data, width, height)) => {
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
            return Ok(FastCaptureResult {
                file_path,
                width,
                height,
                has_transparency: true,
            });
        }
        Err(e) => println!("[CAPTURE] WGC window failed: {:?}, trying xcap", e),
    }

    // Fallback to xcap
    fallback::capture_window_raw(window_id)
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
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
    fallback::capture_region_raw(selection)
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
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
    fallback::capture_screen_region_raw(selection)
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
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
    fallback::capture_fullscreen_raw()
        .map_err(|e| e.to_string())
        .and_then(|(rgba_data, width, height)| {
            let file_path = write_rgba_to_temp_file(&rgba_data, width, height)?;
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
