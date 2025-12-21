use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

// Unique session counter to avoid window label conflicts
static OVERLAY_SESSION: AtomicU64 = AtomicU64::new(0);

/// Trigger the capture overlay - called from tray or hotkey
pub fn trigger_capture(app: &AppHandle) -> Result<(), String> {
    // Clean up existing overlays first
    let windows = app.webview_windows();
    for (label, window) in windows {
        if label.starts_with("ov_") || label.starts_with("overlay_") {
            let _ = window.close();
        }
    }

    // Create overlay windows
    create_overlay_windows(app)?;

    // Hide main window
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.hide();
    }

    Ok(())
}

fn create_overlay_windows(app: &AppHandle) -> Result<(), String> {
    let session = OVERLAY_SESSION.fetch_add(1, Ordering::SeqCst);
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    for (idx, monitor) in monitors.iter().enumerate() {
        let label = format!("ov_{}_{}", session, idx);

        let x = monitor.x().unwrap_or(0) as f64;
        let y = monitor.y().unwrap_or(0) as f64;
        let width = monitor.width().unwrap_or(1920) as f64;
        let height = monitor.height().unwrap_or(1080) as f64;
        let scale = monitor.scale_factor().unwrap_or(1.0);

        let url = WebviewUrl::App(
            format!(
                "overlay.html?monitor={}&x={}&y={}&width={}&height={}&scale={}",
                idx, x as i32, y as i32, width as u32, height as u32, scale
            )
            .into(),
        );

        let window = WebviewWindowBuilder::new(app, &label, url)
            .title("")
            .inner_size(width, height)
            .position(x, y)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .build()
            .map_err(|e| format!("Failed to create overlay: {}", e))?;

        window
            .show()
            .map_err(|e| format!("Failed to show overlay: {}", e))?;
        let _ = window.set_focus();
    }

    Ok(())
}

/// Move all overlays off-screen (instant, synchronous) - call before capture
#[command]
pub async fn move_overlays_offscreen(app: AppHandle) -> Result<(), String> {
    let windows = app.webview_windows();
    
    for (label, window) in windows {
        if label.starts_with("ov_") || label.starts_with("overlay_") {
            // Move way off screen - this is instant and synchronous
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition { x: -10000, y: -10000 }
            ));
        }
    }
    
    // Small sync delay to ensure Windows compositor updates
    std::thread::sleep(std::time::Duration::from_millis(50));
    
    Ok(())
}

#[command]
pub async fn show_overlay(app: AppHandle) -> Result<(), String> {
    trigger_capture(&app)
}

#[command]
pub async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let windows = app.webview_windows();
    
    for (label, window) in windows {
        if label.starts_with("ov_") || label.starts_with("overlay_") {
            let _ = window.close();
        }
    }

    Ok(())
}

#[command]
pub async fn open_editor(app: AppHandle, image_data: String) -> Result<(), String> {
    // Close all overlays
    hide_overlay(app.clone()).await?;

    // Show main window with the captured image
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.unminimize();

        main_window
            .show()
            .map_err(|e| format!("Failed to show main window: {}", e))?;

        let _ = main_window.request_user_attention(Some(tauri::UserAttentionType::Informational));

        main_window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        main_window
            .emit("capture-complete", &image_data)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}
