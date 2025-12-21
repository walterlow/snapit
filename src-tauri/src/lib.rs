use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .on_window_event(|window, event| {
            // Minimize to tray instead of closing the main window
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Screenshot commands
            commands::screenshot::capture_region,
            commands::screenshot::capture_fullscreen,
            commands::screenshot::capture_window,
            commands::screenshot::get_monitors,
            commands::screenshot::get_windows,
            commands::screenshot::get_window_at_point,
            // Window commands
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::open_editor,
            // Image commands
            commands::image::save_image,
            commands::image::copy_to_clipboard,
            commands::image::crop_image,
            commands::image::apply_blur_region,
            // Storage commands
            commands::storage::save_capture,
            commands::storage::update_project_annotations,
            commands::storage::update_project_metadata,
            commands::storage::get_capture_list,
            commands::storage::get_project,
            commands::storage::get_project_image,
            commands::storage::delete_project,
            commands::storage::delete_projects,
            commands::storage::export_project,
            commands::storage::get_storage_stats,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                setup_system_tray(app)?;
                setup_global_shortcuts(app)?;
            }

            // Show main window after setup
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn setup_system_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit SnapIt", true, None::<&str>)?;
    let capture =
        MenuItem::with_id(app, "capture", "Region Capture (Ctrl+Shift+S)", true, None::<&str>)?;
    let capture_full =
        MenuItem::with_id(app, "capture_full", "Fullscreen (Ctrl+Shift+F)", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Library", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&capture, &capture_full, &show, &quit])?;

    // Load custom tray icon (32x32 is standard for system tray)
    let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .expect("Failed to load tray icon");

    let _tray = TrayIconBuilder::new()
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "capture" => {
                let _ = commands::window::trigger_capture(app);
            }
            "capture_full" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(result) = commands::screenshot::capture_fullscreen().await {
                        let _ = commands::window::open_editor(app_handle, result.image_data).await;
                    }
                });
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(desktop)]
fn setup_global_shortcuts(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Register Ctrl+Shift+S for region capture
    let app_handle = app.handle().clone();
    let region_shortcut = "Ctrl+Shift+S".parse::<Shortcut>()?;

    app.global_shortcut()
        .on_shortcut(region_shortcut, move |_app, _scut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = commands::window::trigger_capture(&app_handle);
            }
        })?;

    // Register Ctrl+Shift+F for fullscreen capture
    let app_handle2 = app.handle().clone();
    let fullscreen_shortcut = "Ctrl+Shift+F".parse::<Shortcut>()?;

    app.global_shortcut()
        .on_shortcut(fullscreen_shortcut, move |_app, _scut, event| {
            if event.state == ShortcutState::Pressed {
                let app_clone = app_handle2.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(result) = commands::screenshot::capture_fullscreen().await {
                        let _ = commands::window::open_editor(app_clone, result.image_data).await;
                    }
                });
            }
        })?;

    Ok(())
}
