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
pub mod error;
pub mod rendering;

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
    // WebView2 GPU flags disabled - was causing capture artifacts
    // #[cfg(target_os = "windows")]
    // {
    //     std::env::set_var(
    //         "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    //         "--enable-gpu-rasterization --enable-zero-copy",
    //     );
    // }

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
            // Show the startup toolbar (or bring it to front if already visible)
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = commands::window::show_startup_toolbar(app_handle).await {
                    log::error!("Failed to show startup toolbar on second instance: {}", e);
                }
            });
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
            match event {
                // Fix Windows resize lag by adding small delay
                // See: https://github.com/tauri-apps/tauri/issues/6322#issuecomment-2495685888
                #[cfg(target_os = "windows")]
                WindowEvent::Resized(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                // Minimize to tray instead of closing the main window (if enabled)
                WindowEvent::CloseRequested { api, .. } => {
                    let label = window.label();
                    
                    // Close webcam preview when main window or capture toolbar closes
                    if label == "library" || label == "capture-toolbar" {
                        if let Some(webcam_window) = window.app_handle().get_webview_window("webcam-preview") {
                            let _ = webcam_window.destroy();
                        }
                    }
                    
                    // Handle minimize to tray for library window
                    if label == "library" && commands::settings::is_close_to_tray() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // Otherwise let the window close normally
                }
                _ => {}
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
            commands::window::open_editor_fast,
            commands::window::show_recording_border,
            commands::window::hide_recording_border,
            commands::window::show_capture_toolbar,
            commands::window::update_capture_toolbar,
            commands::window::hide_capture_toolbar,
            commands::window::close_capture_toolbar,
            commands::window::bring_capture_toolbar_to_front,
            commands::window::resize_capture_toolbar,
            commands::window::set_capture_toolbar_bounds,
            commands::window::set_capture_toolbar_position,
            commands::window::set_capture_toolbar_ignore_cursor,
            commands::window::restore_main_window,
            commands::window::show_library_window,
            commands::window::show_countdown_window,
            commands::window::hide_countdown_window,
            commands::window::show_startup_toolbar,
            commands::window::hide_startup_toolbar,
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
            commands::video_recording::set_recording_system_audio,
            commands::video_recording::set_recording_fps,
            commands::video_recording::set_recording_quality,
            commands::video_recording::set_gif_quality_preset,
            commands::video_recording::set_recording_include_cursor,
            commands::video_recording::set_recording_max_duration,
            commands::video_recording::set_recording_microphone_device,
            commands::video_recording::set_hide_desktop_icons,
            commands::video_recording::reset_recording_settings_cmd,
            // Webcam commands
            commands::video_recording::get_webcam_settings_cmd,
            commands::video_recording::set_webcam_enabled,
            commands::video_recording::set_webcam_device,
            commands::video_recording::set_webcam_position,
            commands::video_recording::set_webcam_size,
            commands::video_recording::set_webcam_shape,
            commands::video_recording::set_webcam_mirror,
            commands::video_recording::list_webcam_devices,
            commands::video_recording::list_audio_input_devices,
            commands::video_recording::close_webcam_preview,
            commands::video_recording::bring_webcam_preview_to_front,
            commands::video_recording::move_webcam_to_anchor,
            commands::video_recording::clamp_webcam_to_selection,
            commands::video_recording::start_webcam_preview,
            commands::video_recording::stop_webcam_preview,
            commands::video_recording::is_webcam_preview_running,
            commands::video_recording::exclude_webcam_from_capture,
            // Native webcam preview (Windows-only, GDI-based with circle mask)
            #[cfg(target_os = "windows")]
            commands::video_recording::start_native_webcam_preview,
            #[cfg(target_os = "windows")]
            commands::video_recording::stop_native_webcam_preview,
            #[cfg(target_os = "windows")]
            commands::video_recording::is_native_webcam_preview_running,
            // MF webcam preview (Windows-only, low-latency async Media Foundation)
            #[cfg(target_os = "windows")]
            commands::video_recording::start_mf_webcam_preview,
            #[cfg(target_os = "windows")]
            commands::video_recording::stop_mf_webcam_preview,
            #[cfg(target_os = "windows")]
            commands::video_recording::is_mf_webcam_preview_running,
            // Browser-based webcam recording (MediaRecorder chunks)
            commands::video_recording::webcam_recording_start,
            commands::video_recording::webcam_recording_chunk,
            commands::video_recording::webcam_recording_stop,
            // Video editor commands
            commands::video_recording::load_video_project,
            commands::video_recording::save_video_project,
            commands::video_recording::extract_frame,
            commands::video_recording::clear_video_frame_cache,
            commands::video_recording::generate_auto_zoom,
            commands::video_recording::export_video,
            // GPU-accelerated video editor commands
            commands::video_recording::gpu_editor::create_editor_instance,
            commands::video_recording::gpu_editor::destroy_editor_instance,
            commands::video_recording::gpu_editor::editor_play,
            commands::video_recording::gpu_editor::editor_pause,
            commands::video_recording::gpu_editor::editor_seek,
            commands::video_recording::gpu_editor::editor_set_speed,
            commands::video_recording::gpu_editor::editor_get_state,
            commands::video_recording::gpu_editor::editor_render_frame,
            commands::video_recording::gpu_editor::editor_get_timestamp,
            // Audio monitoring commands
            commands::video_recording::start_audio_monitoring,
            commands::video_recording::stop_audio_monitoring,
            commands::video_recording::is_audio_monitoring,
            // Logging commands
            commands::logging::write_log,
            commands::logging::write_logs,
            commands::logging::get_log_dir,
            commands::logging::open_log_dir,
            commands::logging::get_recent_logs,
            // Capture overlay for video/gif region selection (uses DirectComposition to avoid video blackout)
            commands::capture_overlay::show_capture_overlay,
            commands::capture_overlay::commands::capture_overlay_confirm,
            commands::capture_overlay::commands::capture_overlay_cancel,
            commands::capture_overlay::commands::capture_overlay_reselect,
            commands::capture_overlay::commands::capture_overlay_set_dimensions,
            commands::capture_overlay::commands::capture_overlay_highlight_monitor,
            commands::capture_overlay::commands::capture_overlay_highlight_window,
            // Preview overlay for picker panels
            commands::capture_overlay::start_highlight_preview,
            commands::capture_overlay::stop_highlight_preview,
            commands::capture_overlay::is_highlight_preview_active,
        ])
        .setup(|app| {
            // Initialize logging system first
            if let Err(e) = commands::logging::init_logging(app.handle()) {
                // Can't use log! here since logging initialization failed
                eprintln!("Failed to initialize logging: {}", e);
            }

            // Install panic hook to restore desktop icons on any future panic (fast, non-blocking)
            commands::video_recording::desktop_icons::install_panic_hook();
            
            // Safety: Restore desktop icons in case previous session crashed while hiding them
            // Run in background thread to not block startup toolbar
            std::thread::spawn(|| {
                commands::video_recording::desktop_icons::force_show_desktop_icons();
            });

            #[cfg(desktop)]
            {
                let tray_state = setup_system_tray(app)?;
                app.manage(Mutex::new(tray_state));
                // Note: Shortcuts are now registered dynamically via frontend
                // after settings are loaded. See commands::settings module.
            }

            // Initialize GPU editor state for video editing
            app.manage(commands::video_recording::EditorState::new());

            // Set window icon on library window (kept for when it's shown via tray)
            if let Some(window) = app.get_webview_window("library") {
                // Set the taskbar icon
                let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                    .expect("Failed to load window icon");
                let _ = window.set_icon(icon);

                // Apply DWM blur-behind for proper transparency on Windows
                // This fixes capture artifacts when screenshotting the main window
                // (WS_EX_LAYERED from tauri's transparent: true has issues with hardware capture)
                #[cfg(target_os = "windows")]
                if let Err(e) = commands::window::apply_dwm_transparency(&window) {
                    log::warn!("Failed to apply DWM transparency to library window: {}", e);
                }

                // Explicitly hide - window-state plugin may have restored visibility
                // Library is shown via tray "Show Library" menu
                let _ = window.hide();
            }

            // Show floating startup toolbar on app launch
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = commands::window::show_startup_toolbar(app_handle).await {
                    log::error!("Failed to show startup toolbar: {}", e);
                }
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
    let show_toolbar =
        MenuItem::with_id(app, "show_toolbar", "Show Capture Toolbar", true, None::<&str>)?;
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
        &[&show_toolbar, &separator, &capture, &capture_full, &capture_all, &separator, &show, &settings, &separator, &quit],
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
            "show_toolbar" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::window::show_startup_toolbar(app_handle).await {
                        log::error!("Failed to show capture toolbar: {}", e);
                    }
                });
            }
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
                if let Some(window) = app.get_webview_window("library") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "settings" => {
                // Show library window and emit event to open settings modal
                if let Some(window) = app.get_webview_window("library") {
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

// Global shortcuts are now registered dynamically via commands::settings module
// This allows users to customize shortcuts through the settings UI
