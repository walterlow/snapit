//! Window event handlers.
//!
//! This module contains window event handling logic extracted from lib.rs.

use tauri::{Manager, Window, WindowEvent};

use crate::commands::video_recording::audio_monitor;
use crate::commands::window::image_editor;
use crate::commands::window::video_editor;
use crate::config;

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

            // Clean up resources when capture toolbar closes
            if label == "capture-toolbar" {
                // Stop audio monitoring (releases microphone)
                let _ = audio_monitor::stop_monitoring();

                // Close webcam preview
                if let Some(webcam_window) =
                    window.app_handle().get_webview_window("webcam-preview")
                {
                    let _ = webcam_window.destroy();
                }
            }

            // Close webcam preview when library window closes
            if label == "library" {
                if let Some(webcam_window) =
                    window.app_handle().get_webview_window("webcam-preview")
                {
                    let _ = webcam_window.destroy();
                }
            }

            // Handle minimize to tray for library window
            if label == "library" && config::app::is_close_to_tray() {
                api.prevent_close();
                let _ = window.hide();
            }

            // Clean up video editor window tracking
            if video_editor::is_video_editor_window(label) {
                video_editor::on_video_editor_closed(label);
            }

            // Clean up image editor window tracking
            if image_editor::is_image_editor_window(label) {
                image_editor::on_image_editor_closed(label);
            }
            // Otherwise let the window close normally
        },

        _ => {},
    }
}
