use base64::{engine::general_purpose::STANDARD, Engine};
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::command;
use xcap::{Monitor, Window};

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
        .filter(|w| !w.is_minimized().unwrap_or(true))
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
        .filter(|w| !w.title.is_empty() && w.width > 0 && w.height > 0)
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

/// Get window at a specific screen coordinate
#[command]
pub async fn get_window_at_point(x: i32, y: i32) -> Result<Option<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    // Filter visible windows and sort by z-order (we'll use area as a heuristic - smaller windows on top)
    let mut candidates: Vec<_> = windows
        .iter()
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .filter(|w| {
            let title = w.title().unwrap_or_default();
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            !title.is_empty() && width > 0 && height > 0
        })
        .filter(|w| {
            // Check if point is inside window bounds
            let wx = w.x().unwrap_or(0);
            let wy = w.y().unwrap_or(0);
            let ww = w.width().unwrap_or(0) as i32;
            let wh = w.height().unwrap_or(0) as i32;
            x >= wx && x < wx + ww && y >= wy && y < wy + wh
        })
        .collect();

    // Sort by area (smaller = likely on top) to pick the topmost window
    candidates.sort_by_key(|w| {
        let width = w.width().unwrap_or(0) as i64;
        let height = w.height().unwrap_or(0) as i64;
        width * height
    });

    // Return the smallest window containing the point (likely the topmost)
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

    let image = target_window
        .capture_image()
        .map_err(|e| format!("Failed to capture window: {}", e))?;

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
