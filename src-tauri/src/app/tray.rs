//! System tray setup and event handling.
//!
//! This module contains all tray-related functionality extracted from lib.rs
//! for better code organization.

use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Emitter, Manager,
};

use crate::commands;

/// Holds references to tray menu items for dynamic updates.
pub struct TrayState {
    pub new_capture: MenuItem<tauri::Wry>,
    pub fullscreen: MenuItem<tauri::Wry>,
    pub all_monitors: MenuItem<tauri::Wry>,
}

impl TrayState {
    /// Update the "New Capture" menu item text (e.g., to show shortcut).
    pub fn update_new_capture_text(&self, text: &str) -> Result<(), tauri::Error> {
        self.new_capture.set_text(text)
    }

    /// Update the "Fullscreen" menu item text.
    pub fn update_fullscreen_text(&self, text: &str) -> Result<(), tauri::Error> {
        self.fullscreen.set_text(text)
    }

    /// Update the "All Monitors" menu item text.
    pub fn update_all_monitors_text(&self, text: &str) -> Result<(), tauri::Error> {
        self.all_monitors.set_text(text)
    }
}

/// Set up the system tray with menu and event handlers.
///
/// Returns a `TrayState` that should be managed by the app for dynamic updates.
pub fn setup_system_tray(app: &App) -> Result<TrayState, Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit SnapIt", true, None::<&str>)?;
    let show_toolbar = MenuItem::with_id(
        app,
        "show_toolbar",
        "Show Capture Toolbar",
        true,
        None::<&str>,
    )?;
    let capture = MenuItem::with_id(app, "capture", "New Capture", true, None::<&str>)?;
    let capture_full = MenuItem::with_id(app, "capture_full", "Fullscreen", true, None::<&str>)?;
    let capture_all = MenuItem::with_id(app, "capture_all", "All Monitors", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Library", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_toolbar,
            &separator,
            &capture,
            &capture_full,
            &capture_all,
            &separator,
            &show,
            &settings,
            &separator,
            &quit,
        ],
    )?;

    // Load custom tray icon (32x32 is standard for system tray)
    let tray_icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
        .expect("Failed to load tray icon");

    let _tray = TrayIconBuilder::new()
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show_toolbar" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::window::show_startup_toolbar(app_handle).await {
                        log::error!("Failed to show capture toolbar: {}", e);
                    }
                });
            },
            "capture" => {
                let _ = commands::window::trigger_capture(app, None);
            },
            "capture_full" => {
                // Fast fullscreen capture - no overlay, no PNG encoding
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(result) = commands::capture::capture_fullscreen_fast().await {
                        let _ = commands::window::open_editor_fast(
                            app_handle,
                            result.file_path,
                            result.width,
                            result.height,
                        )
                        .await;
                    }
                });
            },
            "capture_all" => {
                // Capture all monitors combined
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(bounds) = commands::capture::get_virtual_screen_bounds().await {
                        let selection = commands::capture::ScreenRegionSelection {
                            x: bounds.x,
                            y: bounds.y,
                            width: bounds.width,
                            height: bounds.height,
                        };
                        if let Ok(result) =
                            commands::capture::capture_screen_region_fast(selection).await
                        {
                            let _ = commands::window::open_editor_fast(
                                app_handle,
                                result.file_path,
                                result.width,
                                result.height,
                            )
                            .await;
                        }
                    }
                });
            },
            "show" => {
                if let Some(window) = app.get_webview_window("library") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
            "settings" => {
                // Show library window and emit event to open settings modal
                if let Some(window) = app.get_webview_window("library") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("open-settings", ());
            },
            _ => {},
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                // Left-click shows the capture toolbar
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::window::show_startup_toolbar(app).await {
                        log::error!("Failed to show capture toolbar on tray click: {}", e);
                    }
                });
            }
        })
        .build(app)?;

    Ok(TrayState {
        new_capture: capture,
        fullscreen: capture_full,
        all_monitors: capture_all,
    })
}

/// Initialize the system tray and register it with the app state.
///
/// This is called from the app setup hook.
pub fn init(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let tray_state = setup_system_tray(app)?;
    app.manage(Mutex::new(tray_state));
    Ok(())
}
