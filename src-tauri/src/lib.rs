use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;

mod commands;

/// Holds references to tray menu items for dynamic updates
#[cfg(desktop)]
pub struct TrayState {
    pub new_capture: MenuItem<tauri::Wry>,
    pub fullscreen: MenuItem<tauri::Wry>,
    pub all_monitors: MenuItem<tauri::Wry>,
}

#[cfg(desktop)]
impl TrayState {
    pub fn update_new_capture_text(&self, text: &str) -> Result<(), tauri::Error> {
        self.new_capture.set_text(text)
    }

    pub fn update_fullscreen_text(&self, text: &str) -> Result<(), tauri::Error> {
        self.fullscreen.set_text(text)
    }

    pub fn update_all_monitors_text(&self, text: &str) -> Result<(), tauri::Error> {
        self.all_monitors.set_text(text)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set WebView2 GPU optimization flags (Windows only)
    // These improve resize performance by enabling GPU rasterization
    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--enable-gpu-rasterization --enable-zero-copy",
        );
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // Called when a second instance tries to start
            // Bring the main window to front
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            println!("Second instance blocked. Args: {:?}, CWD: {:?}", args, cwd);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());

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
            // Minimize to tray instead of closing the main window (if enabled)
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if commands::settings::is_close_to_tray() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // If close_to_tray is false, let the window close normally
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Capture commands (with transparency support)
            commands::capture::capture_region,
            commands::capture::capture_fullscreen,
            commands::capture::capture_window,
            commands::capture::get_monitors,
            commands::capture::get_virtual_screen_bounds,
            commands::capture::get_windows,
            commands::capture::get_window_at_point,
            // Fast capture commands (skip PNG encoding for editor display)
            commands::capture::capture_window_fast,
            commands::capture::capture_region_fast,
            commands::capture::capture_screen_region_fast,
            commands::capture::capture_fullscreen_fast,
            commands::capture::read_rgba_file,
            commands::capture::cleanup_rgba_file,
            // Window commands
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::open_editor,
            commands::window::open_editor_fast,
            commands::window::move_overlays_offscreen,

            commands::window::show_recording_border,
            commands::window::hide_recording_border,
            commands::window::show_dcomp_toolbar,
            commands::window::update_dcomp_toolbar,
            commands::window::hide_dcomp_toolbar,
            commands::window::restore_main_window,
            commands::window::show_countdown_window,
            commands::window::hide_countdown_window,
            // Image commands
            commands::image::copy_image_to_clipboard,
            // Storage commands
            commands::storage::save_capture,
            commands::storage::save_capture_from_file,
            commands::storage::update_project_annotations,
            commands::storage::update_project_metadata,
            commands::storage::get_capture_list,
            commands::storage::get_project,
            commands::storage::get_project_image,
            commands::storage::delete_project,
            commands::storage::delete_projects,
            commands::storage::export_project,
            commands::storage::get_storage_stats,
            commands::storage::get_library_folder,
            commands::storage::startup_cleanup,
            commands::storage::import_image_from_path,
            commands::storage::ensure_ffmpeg,
            // Settings commands
            commands::settings::set_autostart,
            commands::settings::is_autostart_enabled,
            commands::settings::open_path_in_explorer,
            commands::settings::reveal_file_in_explorer,
            commands::settings::open_file_with_default_app,
            commands::settings::get_default_save_dir,
            commands::settings::update_tray_shortcut,
            commands::settings::set_close_to_tray,
            // Font commands
            commands::fonts::get_system_fonts,
            // Keyboard hook commands (Windows shortcut override)
            commands::keyboard_hook::register_shortcut_with_hook,
            commands::keyboard_hook::unregister_shortcut_hook,
            commands::keyboard_hook::unregister_all_hooks,
            commands::keyboard_hook::reinstall_hook,
            // Video recording commands
            commands::video_recording::start_recording,
            commands::video_recording::stop_recording,
            commands::video_recording::cancel_recording,
            commands::video_recording::pause_recording,
            commands::video_recording::resume_recording,
            commands::video_recording::get_recording_status,
            commands::video_recording::set_recording_countdown,
            // Logging commands
            commands::logging::write_log,
            commands::logging::write_logs,
            commands::logging::get_log_dir,
            commands::logging::open_log_dir,
            commands::logging::get_recent_logs,
            // DirectComposition overlay for video/gif (avoids video blackout)
            commands::dcomp_overlay::show_dcomp_video_overlay,
            commands::dcomp_overlay::dcomp_overlay_confirm,
            commands::dcomp_overlay::dcomp_overlay_cancel,
            commands::dcomp_overlay::dcomp_overlay_reselect,
        ])
        .setup(|app| {
            // Initialize logging system first
            if let Err(e) = commands::logging::init_logging(app.handle()) {
                eprintln!("Failed to initialize logging: {}", e);
            }

            #[cfg(desktop)]
            {
                let tray_state = setup_system_tray(app)?;
                app.manage(Mutex::new(tray_state));
                // Note: Shortcuts are now registered dynamically via frontend
                // after settings are loaded. See commands::settings module.
            }

            // Set window icon and show main window
            if let Some(window) = app.get_webview_window("main") {
                // Set the taskbar icon
                let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                    .expect("Failed to load window icon");
                let _ = window.set_icon(icon);
                let _ = window.show();
            }

            // Pre-create overlay windows in background for instant capture later
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                // Small delay to let main window fully initialize first
                std::thread::sleep(std::time::Duration::from_millis(500));
                let _ = commands::window::precreate_overlays(&app_handle);
            });

            // Ensure ffmpeg is available for video thumbnails (downloads if needed)
            // This runs in background and doesn't block app startup
            std::thread::spawn(|| {
                if commands::storage::find_ffmpeg().is_none() {
                    // Try to download ffmpeg if not found
                    let _ = ffmpeg_sidecar::download::auto_download();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn setup_system_tray(app: &tauri::App) -> Result<TrayState, Box<dyn std::error::Error>> {
    use tauri::menu::PredefinedMenuItem;

    let quit = MenuItem::with_id(app, "quit", "Quit SnapIt", true, None::<&str>)?;
    let capture =
        MenuItem::with_id(app, "capture", "New Capture", true, None::<&str>)?;
    let capture_full =
        MenuItem::with_id(app, "capture_full", "Fullscreen", true, None::<&str>)?;
    let capture_all =
        MenuItem::with_id(app, "capture_all", "All Monitors", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Library", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&capture, &capture_full, &capture_all, &separator, &show, &settings, &separator, &quit],
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
                let _ = commands::window::trigger_capture(app, None);
            }
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
                        ).await;
                    }
                });
            }
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
                        if let Ok(result) = commands::capture::capture_screen_region_fast(selection).await {
                            let _ = commands::window::open_editor_fast(
                                app_handle,
                                result.file_path,
                                result.width,
                                result.height,
                            ).await;
                        }
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
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(TrayState {
        new_capture: capture,
        fullscreen: capture_full,
        all_monitors: capture_all,
    })
}

// Global shortcuts are now registered dynamically via commands::settings module
// This allows users to customize shortcuts through the settings UI
