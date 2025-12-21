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

pub use types::{CaptureResult, MonitorInfo, RegionSelection, WindowInfo};

use tauri::command;

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
            Err(e) => {
                log::warn!("WGC window capture failed, falling back to xcap: {}", e);
            }
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
            Err(e) => {
                log::warn!("WGC monitor capture failed, falling back to xcap: {}", e);
            }
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
    use xcap::Window;

    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            GetAncestor, GetClassNameW, GetLayeredWindowAttributes, GetWindow, GetWindowLongW,
            GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
            IsIconic, IsWindowVisible, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT,
            LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
            WS_EX_TRANSPARENT,
        },
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
fn try_get_window_info(
    hwnd: windows::Win32::Foundation::HWND,
    current_process_id: u32,
    point: windows::Win32::Foundation::POINT,
) -> Option<WindowInfo> {
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{
            GetClassNameW, GetLayeredWindowAttributes, GetWindowLongW, GetWindowRect,
            GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
            IsWindowVisible, GWL_EXSTYLE, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA,
            WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        },
    };
    use xcap::Window;

    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
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

        // Use DwmGetWindowAttribute to get the actual visible frame bounds
        // This excludes the invisible borders that Windows 10/11 adds for shadows
        let mut rect = RECT::default();
        let result = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        
        // Fallback to GetWindowRect if DWM fails
        if result.is_err() {
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return None;
            }
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

        match class_name.as_str() {
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow"
            | "Windows.UI.Core.CoreWindow" | "Progman" | "WorkerW" => return None,
            _ => {}
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
        let app_name = Window::all()
            .ok()
            .and_then(|windows| {
                windows
                    .iter()
                    .find(|w| w.id().unwrap_or(0) == hwnd_id)
                    .map(|w| w.app_name().unwrap_or_default())
            })
            .unwrap_or_default();

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
    use windows::Win32::{Foundation::RECT, UI::WindowsAndMessaging::GetWindowRect};

    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
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
