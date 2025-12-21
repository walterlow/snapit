use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

/// Trigger the capture overlay - called from tray or hotkey
pub fn trigger_capture(app: &AppHandle) -> Result<(), String> {
    // Hide main window if visible
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.hide();
    }

    // Small delay to ensure window is hidden before capture
    std::thread::sleep(std::time::Duration::from_millis(150));

    // Create overlay windows on each monitor
    create_overlay_windows(app)?;

    Ok(())
}

fn create_overlay_windows(app: &AppHandle) -> Result<(), String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    for (idx, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay_{}", idx);

        // Close existing overlay if present
        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.close();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

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

#[command]
pub async fn show_overlay(app: AppHandle) -> Result<(), String> {
    trigger_capture(&app)
}

#[command]
pub async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let monitors = Monitor::all().unwrap_or_default();

    for idx in 0..monitors.len().max(4) {
        let label = format!("overlay_{}", idx);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }

    Ok(())
}

#[command]
pub async fn open_editor(app: AppHandle, image_data: String) -> Result<(), String> {
    // Hide all overlays first
    hide_overlay(app.clone()).await?;

    // Small delay
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Show main window with the captured image
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .show()
            .map_err(|e| format!("Failed to show main window: {}", e))?;
        main_window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        // Emit event to frontend with the captured image
        main_window
            .emit("capture-complete", &image_data)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}
