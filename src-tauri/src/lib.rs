use tauri::{image::Image, Manager};

#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;

pub mod app;
mod commands;
pub mod config;
pub mod error;
pub mod rendering;

// Re-export TrayState for external use
#[cfg(desktop)]
pub use app::TrayState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize env_logger for Rust log::info!/log::debug! output
    // Only in debug builds to avoid spamming production
    #[cfg(debug_assertions)]
    {
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .format_timestamp_millis()
            .init();
    }

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
                if let Err(e) = commands::window::toolbar::show_startup_toolbar(app_handle).await {
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
            app::events::handle_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            // Capture commands (with transparency support)
            commands::capture::capture_region,
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
            // Window commands - capture flow
            commands::window::capture::show_overlay,
            commands::window::capture::hide_overlay,
            commands::window::capture::open_editor_fast,
            commands::window::capture::restore_main_window,
            commands::window::capture::show_library_window,
            // Window commands - recording
            commands::window::recording::show_recording_border,
            commands::window::recording::hide_recording_border,
            commands::window::recording::show_countdown_window,
            commands::window::recording::hide_countdown_window,
            // Window commands - toolbar
            commands::window::toolbar::show_capture_toolbar,
            commands::window::toolbar::update_capture_toolbar,
            commands::window::toolbar::hide_capture_toolbar,
            commands::window::toolbar::close_capture_toolbar,
            commands::window::toolbar::bring_capture_toolbar_to_front,
            commands::window::toolbar::resize_capture_toolbar,
            commands::window::toolbar::set_capture_toolbar_bounds,
            commands::window::toolbar::set_capture_toolbar_position,
            commands::window::toolbar::set_capture_toolbar_ignore_cursor,
            commands::window::toolbar::show_startup_toolbar,
            commands::window::toolbar::hide_startup_toolbar,
            // Image commands
            commands::image::copy_image_to_clipboard,
            // Storage commands
            commands::storage::operations::save_capture,
            commands::storage::operations::save_capture_from_file,
            commands::storage::operations::update_project_annotations,
            commands::storage::operations::update_project_metadata,
            commands::storage::operations::get_capture_list,
            commands::storage::operations::get_project,
            commands::storage::operations::get_project_image,
            commands::storage::operations::delete_project,
            commands::storage::operations::delete_projects,
            commands::storage::operations::export_project,
            commands::storage::operations::get_storage_stats,
            commands::storage::operations::get_library_folder,
            commands::storage::operations::startup_cleanup,
            commands::storage::operations::import_image_from_path,
            commands::storage::operations::ensure_ffmpeg,
            // Settings commands
            commands::settings::set_autostart,
            commands::settings::is_autostart_enabled,
            commands::settings::open_path_in_explorer,
            commands::settings::reveal_file_in_explorer,
            commands::settings::open_file_with_default_app,
            commands::settings::get_default_save_dir,
            commands::settings::update_tray_shortcut,
            // App config commands (from centralized config module)
            config::app::set_close_to_tray,
            config::app::get_app_config,
            config::app::set_app_config,
            // Font commands
            commands::fonts::get_system_fonts,
            // Keyboard hook commands (Windows shortcut override)
            commands::keyboard_hook::register_shortcut_with_hook,
            commands::keyboard_hook::unregister_shortcut_hook,
            commands::keyboard_hook::unregister_all_hooks,
            commands::keyboard_hook::reinstall_hook,
            commands::keyboard_hook::suspend_shortcut,
            commands::keyboard_hook::resume_shortcut,
            commands::keyboard_hook::is_shortcut_registered_hook,
            commands::keyboard_hook::check_shortcut_available,
            // Video recording commands
            commands::video_recording::start_recording,
            commands::video_recording::stop_recording,
            commands::video_recording::cancel_recording,
            commands::video_recording::pause_recording,
            commands::video_recording::resume_recording,
            commands::video_recording::get_recording_status,
            // Recording config commands (from centralized config module)
            config::recording::set_recording_countdown,
            config::recording::set_recording_system_audio,
            config::recording::set_recording_fps,
            config::recording::set_recording_quality,
            config::recording::set_gif_quality_preset,
            config::recording::set_recording_include_cursor,
            config::recording::set_recording_quick_capture,
            config::recording::set_recording_max_duration,
            config::recording::set_recording_microphone_device,
            config::recording::set_hide_desktop_icons,
            config::recording::reset_recording_config_cmd,
            config::recording::set_recording_config,
            config::recording::get_recording_config,
            // Webcam config commands (from centralized config module)
            config::webcam::get_webcam_settings_cmd,
            config::webcam::set_webcam_enabled,
            config::webcam::set_webcam_device,
            config::webcam::set_webcam_position,
            config::webcam::set_webcam_size,
            config::webcam::set_webcam_shape,
            config::webcam::set_webcam_mirror,
            config::webcam::set_webcam_config,
            commands::video_recording::list_webcam_devices,
            commands::video_recording::list_audio_input_devices,
            commands::video_recording::close_webcam_preview,
            commands::video_recording::bring_webcam_preview_to_front,
            commands::video_recording::move_webcam_to_anchor,
            commands::video_recording::clamp_webcam_to_selection,
            commands::video_recording::start_webcam_preview,
            commands::video_recording::stop_webcam_preview,
            commands::video_recording::is_webcam_preview_running,
            commands::video_recording::prewarm_capture,
            commands::video_recording::stop_prewarm,
            commands::video_recording::prepare_recording,
            commands::video_recording::get_webcam_preview_frame,
            commands::video_recording::get_webcam_preview_dimensions,
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
            commands::video_recording::load_cursor_recording_cmd,
            commands::video_recording::extract_frame,
            commands::video_recording::clear_video_frame_cache,
            commands::video_recording::extract_audio_waveform,
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
                app::tray::init(app)?;
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
                if let Err(e) = commands::window::toolbar::show_startup_toolbar(app_handle).await {
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

// Global shortcuts are now registered dynamically via commands::settings module
// This allows users to customize shortcuts through the settings UI
