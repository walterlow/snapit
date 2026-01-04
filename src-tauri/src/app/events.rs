//! Window event handlers.
//!
//! This module contains window event handling logic extracted from lib.rs.

use tauri::{Manager, Window, WindowEvent};

use crate::commands;

/// Handle window events for the application.
///
/// This is called from the Tauri builder's `on_window_event` hook.
pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    match event {
        // Fix Windows resize lag by adding small delay
        // See: https://github.com/tauri-apps/tauri/issues/6322#issuecomment-2495685888
        #[cfg(target_os = "windows")]
        WindowEvent::Resized(_) => {
            std::thread::sleep(std::time::Duration::from_millis(1));
        },

        // Minimize to tray instead of closing the main window (if enabled)
        WindowEvent::CloseRequested { api, .. } => {
            let label = window.label();

            // Close webcam preview when main window or capture toolbar closes
            if label == "library" || label == "capture-toolbar" {
                if let Some(webcam_window) =
                    window.app_handle().get_webview_window("webcam-preview")
                {
                    let _ = webcam_window.destroy();
                }
            }

            // Handle minimize to tray for library window
            if label == "library" && commands::settings::is_close_to_tray() {
                api.prevent_close();
                let _ = window.hide();
            }
            // Otherwise let the window close normally
        },

        _ => {},
    }
}
