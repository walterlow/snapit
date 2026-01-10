//! Settings window commands.

use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Settings window label
pub(crate) const SETTINGS_WINDOW_LABEL: &str = "settings";

/// Show the settings window, creating it if it doesn't exist.
/// If the window already exists, focus it and optionally switch to a specific tab.
#[command]
pub async fn show_settings_window(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    // Check if window already exists
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        // Emit tab change event if a specific tab was requested
        if let Some(tab) = tab {
            let _ = window.emit("settings-tab-change", serde_json::json!({ "tab": tab }));
        }

        window
            .show()
            .map_err(|e| format!("Failed to show settings window: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus settings window: {}", e))?;
        return Ok(());
    }

    let url = WebviewUrl::App("settings.html".into());

    // Create settings window - centered, resizable, with custom titlebar
    // NOTE: Do NOT apply DWM transparency - it can break click events on Windows
    let window = WebviewWindowBuilder::new(&app, SETTINGS_WINDOW_LABEL, url)
        .title("SnapIt Settings")
        .inner_size(560.0, 600.0)
        .min_inner_size(480.0, 400.0)
        .resizable(true)
        .maximizable(true)
        .transparent(true)
        .decorations(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .shadow(true)
        .center()
        .visible(true)
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to create settings window: {}", e))?;

    // Emit tab change event after window is created if a specific tab was requested
    if let Some(tab) = tab {
        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            // Small delay to ensure frontend is ready
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            let _ = window_clone.emit("settings-tab-change", serde_json::json!({ "tab": tab }));
        });
    }

    Ok(())
}

/// Close the settings window.
#[command]
pub async fn close_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close settings window: {}", e))?;
    }
    Ok(())
}
