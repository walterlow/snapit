use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;



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
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ));
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
            // Capture commands (with transparency support)
            commands::capture::capture_region,
            commands::capture::capture_fullscreen,
            commands::capture::capture_window,
            commands::capture::get_monitors,
            commands::capture::get_windows,
            commands::capture::get_window_at_point,
            // Window commands
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::open_editor,
            commands::window::move_overlays_offscreen,
            // Image commands
            commands::image::save_image,
            commands::image::save_png_bytes,
            commands::image::copy_to_clipboard,
            commands::image::copy_rgba_to_clipboard,
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
            // Settings commands
            commands::settings::set_autostart,
            commands::settings::is_autostart_enabled,
            commands::settings::open_path_in_explorer,
            commands::settings::get_default_save_dir,
            // Keyboard hook commands (Windows shortcut override)
            commands::keyboard_hook::register_shortcut_with_hook,
            commands::keyboard_hook::unregister_shortcut_hook,
            commands::keyboard_hook::unregister_all_hooks,
            commands::keyboard_hook::reinstall_hook,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                setup_system_tray(app)?;
                // Note: Shortcuts are now registered dynamically via frontend
                // after settings are loaded. See commands::settings module.
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
    use tauri::menu::PredefinedMenuItem;

    let quit = MenuItem::with_id(app, "quit", "Quit SnapIt", true, None::<&str>)?;
    let capture =
        MenuItem::with_id(app, "capture", "Region Capture (Ctrl+Shift+S)", true, None::<&str>)?;
    let capture_full =
        MenuItem::with_id(app, "capture_full", "Fullscreen (Ctrl+Shift+F)", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Library", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&capture, &capture_full, &separator, &show, &settings, &separator, &quit],
    )?;

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
                    if let Ok(result) = commands::capture::capture_fullscreen().await {
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
            "settings" => {
                // Show main window and emit event to open settings modal
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("open-settings", ());
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

// Global shortcuts are now registered dynamically via commands::settings module
// This allows users to customize shortcuts through the settings UI
