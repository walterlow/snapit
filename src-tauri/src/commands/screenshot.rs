use base64::{engine::general_purpose::STANDARD, Engine};
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::command;
use xcap::{Monitor, Window};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    System::Threading::GetCurrentProcessId,
    UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetLayeredWindowAttributes, GetWindow, GetWindowLongW,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT,
        LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT,
    },
};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub scale_factor: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_minimized: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureResult {
    pub image_data: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegionSelection {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub monitor_id: u32,
}

/// Get all available monitors
#[command]
pub async fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

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

/// Get all capturable windows
#[command]
pub async fn get_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

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

/// Capture a specific region from the screen
#[command]
pub async fn capture_region(selection: RegionSelection) -> Result<CaptureResult, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    let monitor = monitors
        .get(selection.monitor_id as usize)
        .ok_or("Monitor not found")?;

    let full_image = monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    let dynamic_image = DynamicImage::ImageRgba8(full_image);

    let monitor_x = monitor.x().unwrap_or(0);
    let monitor_y = monitor.y().unwrap_or(0);
    let rel_x = (selection.x - monitor_x).max(0) as u32;
    let rel_y = (selection.y - monitor_y).max(0) as u32;

    let max_width = dynamic_image.width().saturating_sub(rel_x);
    let max_height = dynamic_image.height().saturating_sub(rel_y);
    let crop_width = selection.width.min(max_width);
    let crop_height = selection.height.min(max_height);

    let cropped = dynamic_image.crop_imm(rel_x, rel_y, crop_width, crop_height);

    let mut buffer = Cursor::new(Vec::new());
    cropped
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width: cropped.width(),
        height: cropped.height(),
    })
}

/// Capture fullscreen (primary monitor)
#[command]
pub async fn capture_fullscreen() -> Result<CaptureResult, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or("No monitors found")?;

    let image = monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width: dynamic_image.width(),
        height: dynamic_image.height(),
    })
}

/// Check if a window is likely visible and capturable
fn is_window_visible(w: &Window) -> bool {
    // Must not be minimized
    if w.is_minimized().unwrap_or(true) {
        return false;
    }

    let title = w.title().unwrap_or_default();
    let app_name = w.app_name().unwrap_or_default();
    let width = w.width().unwrap_or(0);
    let height = w.height().unwrap_or(0);
    let wx = w.x().unwrap_or(0);
    let wy = w.y().unwrap_or(0);

    // Must have a title and reasonable size
    if title.is_empty() || width < 50 || height < 50 {
        return false;
    }

    // Filter out windows that are completely offscreen (likely invisible)
    // Get total screen bounds from monitors
    let monitors = Monitor::all().unwrap_or_default();
    let mut min_x = 0i32;
    let mut min_y = 0i32;
    let mut max_x = 3840i32; // Default fallback
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

    // Window must be at least partially visible on screen
    let ww = width as i32;
    let wh = height as i32;
    if wx + ww < min_x || wx > max_x || wy + wh < min_y || wy > max_y {
        return false;
    }

    // Filter out known invisible/system windows by app name patterns
    let app_lower = app_name.to_lowercase();
    let title_lower = title.to_lowercase();

    // Filter cloaked UWP frame hosts without real content
    if app_lower.contains("applicationframehost") && title_lower.is_empty() {
        return false;
    }

    // Filter system tray and shell windows
    if app_lower == "explorer.exe" || app_lower == "explorer" {
        // Allow File Explorer windows but filter shell/desktop
        if title_lower == "program manager"
            || title_lower.is_empty()
            || title_lower == "start"
        {
            return false;
        }
    }

    // Filter TextInputHost (Windows touch keyboard, emoji picker, etc.)
    if app_lower.contains("textinputhost") {
        return false;
    }

    // Filter Search UI
    if app_lower.contains("searchhost") || app_lower.contains("searchui") {
        return false;
    }

    // Filter Windows Shell Experience Host (Start menu, Action Center, etc.) when not active
    if app_lower.contains("shellexperiencehost") {
        return false;
    }

    // Filter LockApp
    if app_lower.contains("lockapp") {
        return false;
    }

    // Filter widgets
    if app_lower.contains("widgets") {
        return false;
    }

    true
}

/// Get window at a specific screen coordinate using Windows API for accurate topmost detection
#[cfg(target_os = "windows")]
#[command]
pub async fn get_window_at_point(x: i32, y: i32) -> Result<Option<WindowInfo>, String> {
    let point = POINT { x, y };

    unsafe {
        let current_process_id = GetCurrentProcessId();

        // Use WindowFromPoint to get the actual topmost window
        let hwnd_at_point = WindowFromPoint(point);
        if hwnd_at_point.0.is_null() {
            return Ok(None);
        }

        // Get the root/top-level window (in case we hit a child control)
        let ancestor = GetAncestor(hwnd_at_point, GA_ROOT);
        let root_hwnd = if !ancestor.0.is_null() {
            ancestor
        } else {
            hwnd_at_point
        };

        // Walk the z-order to find the first valid capturable window
        let mut current_hwnd = root_hwnd;

        loop {
            if let Some(info) = try_get_window_info(current_hwnd, current_process_id, point) {
                return Ok(Some(info));
            }

            // Move to next window in z-order (towards background)
            match GetWindow(current_hwnd, GW_HWNDNEXT) {
                Ok(next_hwnd) if !next_hwnd.0.is_null() => {
                    current_hwnd = next_hwnd;

                    // Check if this window still contains the point
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

/// Try to get window info if it's valid for capture
#[cfg(target_os = "windows")]
fn try_get_window_info(hwnd: HWND, current_process_id: u32, point: POINT) -> Option<WindowInfo> {
    unsafe {
        // Must be visible and not minimized
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }

        // Don't capture our own process
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == current_process_id {
            return None;
        }

        // Point must be inside window bounds
        if !is_point_in_hwnd(hwnd, point) {
            return None;
        }

        // Get window rect
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;

        // Skip tiny windows
        if width < 50 || height < 50 {
            return None;
        }

        // Get window title
        let title_len = GetWindowTextLengthW(hwnd);
        let title = if title_len > 0 {
            let mut buffer = vec![0u16; (title_len + 1) as usize];
            GetWindowTextW(hwnd, &mut buffer);
            String::from_utf16_lossy(&buffer[..title_len as usize])
        } else {
            String::new()
        };

        // Skip windows without titles (usually invisible helper windows)
        if title.is_empty() {
            return None;
        }

        // Get window class name for filtering
        let mut class_name_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_name_buf);
        let class_name = if class_len > 0 {
            String::from_utf16_lossy(&class_name_buf[..class_len as usize])
        } else {
            String::new()
        };

        // Filter out system windows by class name
        match class_name.as_str() {
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow"
            | "Windows.UI.Core.CoreWindow" | "Progman" | "WorkerW" => return None,
            _ => {}
        }

        // Handle transparent/layered windows
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;

        // Skip fully transparent click-through windows
        if (ex_style & WS_EX_TRANSPARENT.0) != 0 {
            return None;
        }

        // Check layered window alpha - skip nearly invisible windows
        if (ex_style & WS_EX_LAYERED.0) != 0 {
            let mut alpha = 255u8;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS::default();
            if GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut flags)).is_ok() {
                if (flags & LWA_ALPHA).0 != 0 && alpha < 30 {
                    return None; // Too transparent
                }
            }
        }

        // Skip tool windows that are likely popups/tooltips
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
            // Allow tool windows with titles (like floating toolbars)
            if title.is_empty() {
                return None;
            }
        }

        // Get app name by finding the xcap Window with matching ID
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

/// Check if a point is inside a window's bounds
#[cfg(target_os = "windows")]
fn is_point_in_hwnd(hwnd: HWND, point: POINT) -> bool {
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

/// Fallback for non-Windows platforms
#[cfg(not(target_os = "windows"))]
#[command]
pub async fn get_window_at_point(x: i32, y: i32) -> Result<Option<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    let mut candidates: Vec<_> = windows
        .iter()
        .filter(|w| is_window_visible(w))
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

/// Apply rounded corner transparency to an image (Windows 11 style)
fn apply_rounded_corners(image: &mut image::RgbaImage, radius: u32) {
    let width = image.width();
    let height = image.height();
    let radius = radius.min(width / 2).min(height / 2);

    if radius == 0 {
        return;
    }

    let radius_f = radius as f64;

    // Process corners
    for y in 0..radius {
        for x in 0..radius {
            let corners = [
                (x, y),                           // Top-left
                (width - 1 - x, y),               // Top-right
                (x, height - 1 - y),              // Bottom-left
                (width - 1 - x, height - 1 - y),  // Bottom-right
            ];

            // Distance from corner center
            let dx = radius_f - x as f64 - 0.5;
            let dy = radius_f - y as f64 - 0.5;
            let dist = (dx * dx + dy * dy).sqrt();

            // Calculate alpha based on distance from corner arc
            let alpha = if dist > radius_f {
                0u8 // Outside the corner arc - fully transparent
            } else if dist > radius_f - 1.5 {
                // Anti-aliasing at the edge
                ((radius_f - dist) / 1.5 * 255.0) as u8
            } else {
                255u8 // Inside - fully opaque
            };

            // Apply to all four corners
            for (cx, cy) in corners {
                let pixel = image.get_pixel_mut(cx, cy);
                // Multiply existing alpha with corner alpha
                let current_alpha = pixel[3] as u16;
                pixel[3] = ((current_alpha * alpha as u16) / 255) as u8;
            }
        }
    }
}

/// Capture a specific window by its ID
#[command]
pub async fn capture_window(window_id: u32) -> Result<CaptureResult, String> {
    let windows = Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    let target_window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or("Window not found")?;

    if target_window.is_minimized().unwrap_or(false) {
        return Err("Cannot capture minimized window".to_string());
    }

    let mut image = target_window
        .capture_image()
        .map_err(|e| format!("Failed to capture window: {}", e))?;

    // Apply rounded corners for Windows 11 style (8px radius at 96 DPI)
    // Scale radius based on image size to handle DPI scaling
    let corner_radius = 8u32;
    apply_rounded_corners(&mut image, corner_radius);

    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    let base64_data = STANDARD.encode(buffer.get_ref());

    Ok(CaptureResult {
        image_data: base64_data,
        width: dynamic_image.width(),
        height: dynamic_image.height(),
    })
}
