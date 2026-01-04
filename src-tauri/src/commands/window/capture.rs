//! Capture flow and overlay commands.

use std::sync::atomic::Ordering;
use tauri::{command, AppHandle, Emitter, Manager};

use super::recording::show_recording_border;
use super::{
    close_all_capture_windows, close_recording_border_window, restore_main_if_visible,
    CAPTURE_TOOLBAR_LABEL, MAIN_WAS_VISIBLE,
};

/// Trigger the capture overlay - uses DirectComposition overlay for all capture types.
/// capture_type: "screenshot", "video", or "gif"
///
/// Uses DirectComposition overlay to avoid blackout issues with hardware-accelerated
/// video content. This works for all capture types (screenshot, video, gif).
pub fn trigger_capture(app: &AppHandle, capture_type: Option<&str>) -> Result<(), String> {
    log::info!(
        "[trigger_capture] Called with capture_type: {:?}",
        capture_type
    );

    // Convert to owned String early to avoid lifetime issues with thread spawn
    let ct = capture_type.unwrap_or("screenshot").to_string();

    // Track if main window was visible (but don't hide it - user may want to capture it)
    if let Some(main_window) = app.get_webview_window("library") {
        let was_visible = main_window.is_visible().unwrap_or(false);
        MAIN_WAS_VISIBLE.store(was_visible, Ordering::SeqCst);
        // Don't hide main window - user may want to capture their own app
    }

    // Clone capture type as owned String for use in spawned thread
    let is_gif = ct == "gif";
    let ct_for_thread = ct.clone();

    // Launch DirectComposition overlay in background
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[window] Failed to create async runtime: {}", e);
                // Restore main window before returning since we hid it earlier
                if let Some(main_window) = app_clone.get_webview_window("library") {
                    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                        let _ = main_window.show();
                    }
                }
                return;
            },
        };
        rt.block_on(async {
            use crate::commands::capture_overlay::{OverlayAction, OverlayResult};

            match crate::commands::capture_overlay::show_capture_overlay(
                app_clone.clone(),
                None,
                Some(ct_for_thread),
                None,
                None,
                None,
            )
            .await
            {
                Ok(Some(result)) => {
                    let OverlayResult {
                        x,
                        y,
                        width,
                        height,
                        action,
                        window_id,
                    } = result;

                    match action {
                        OverlayAction::StartRecording => {
                            // Start recording flow
                            // The toolbar was created by show_toolbar in wndproc.rs
                            // We need to show the recording border separately
                            if let Err(e) =
                                show_recording_border(app_clone.clone(), x, y, width, height).await
                            {
                                log::error!("Failed to show recording border: {}", e);
                            }

                            // Determine format based on capture type
                            let format = if is_gif {
                                crate::commands::video_recording::RecordingFormat::Gif
                            } else {
                                crate::commands::video_recording::RecordingFormat::Mp4
                            };

                            // Emit format to the controls window
                            let format_str = if is_gif { "gif" } else { "mp4" };
                            let _ = app_clone.emit("recording-format", format_str);

                            // Get countdown setting
                            let countdown_secs =
                                crate::commands::video_recording::get_countdown_secs();

                            // Show countdown overlay window if countdown is enabled
                            if countdown_secs > 0 {
                                if let Err(e) = super::recording::show_countdown_window(
                                    app_clone.clone(),
                                    x,
                                    y,
                                    width,
                                    height,
                                )
                                .await
                                {
                                    log::error!("Failed to show countdown window: {}", e);
                                }
                            }

                            // Get recording settings from global state (set by frontend)
                            let system_audio_enabled =
                                crate::commands::video_recording::get_system_audio_enabled();
                            let fps = crate::commands::video_recording::get_fps();
                            let quality = crate::commands::video_recording::get_quality();
                            let include_cursor =
                                crate::commands::video_recording::get_include_cursor();
                            let max_duration_secs =
                                crate::commands::video_recording::get_max_duration_secs();

                            // Start the recording with the selected region
                            let quick_capture =
                                crate::commands::video_recording::get_quick_capture();
                            let settings = crate::commands::video_recording::RecordingSettings {
                                format,
                                mode: crate::commands::video_recording::RecordingMode::Region {
                                    x,
                                    y,
                                    width,
                                    height,
                                },
                                fps,
                                max_duration_secs,
                                include_cursor,
                                audio: crate::commands::video_recording::AudioSettings {
                                    capture_system_audio: system_audio_enabled,
                                    microphone_device_index:
                                        crate::commands::video_recording::get_microphone_device_index(
                                        ),
                                },
                                quality,
                                gif_quality_preset:
                                    crate::commands::video_recording::get_gif_quality_preset(),
                                countdown_secs,
                                quick_capture,
                            };

                            if let Err(e) =
                                crate::commands::video_recording::recorder::start_recording(
                                    app_clone.clone(),
                                    settings.clone(),
                                    crate::commands::video_recording::generate_output_path(
                                        &settings,
                                    )
                                    .unwrap_or_else(|_| {
                                        std::env::temp_dir()
                                            .join(format!("recording.{}", format_str))
                                    }),
                                )
                                .await
                            {
                                log::error!("Failed to start recording: {}", e);
                                // Close toolbar window and restore main window on error
                                if let Some(toolbar) =
                                    app_clone.get_webview_window(CAPTURE_TOOLBAR_LABEL)
                                {
                                    let _ = toolbar.close();
                                }
                                if let Some(main_window) = app_clone.get_webview_window("library") {
                                    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                        let _ = main_window.show();
                                    }
                                }
                            }
                        },
                        OverlayAction::CaptureScreenshot => {
                            // Screenshot flow - close all windows, capture, open editor
                            close_all_capture_windows(&app_clone);

                            // Use window capture if a window was selected, otherwise region capture
                            let capture_result = if let Some(hwnd) = window_id {
                                log::debug!("[CAPTURE] Using window capture for hwnd={}", hwnd);
                                crate::commands::capture::capture_window_fast(hwnd).await
                            } else {
                                log::debug!(
                                    "[CAPTURE] Using region capture: x={}, y={}, w={}, h={}",
                                    x,
                                    y,
                                    width,
                                    height
                                );
                                let selection = crate::commands::capture::ScreenRegionSelection {
                                    x,
                                    y,
                                    width,
                                    height,
                                };
                                crate::commands::capture::capture_screen_region_fast(selection)
                                    .await
                            };

                            match capture_result {
                                Ok(result) => {
                                    // Open editor with the captured image
                                    if let Err(e) = open_editor_fast(
                                        app_clone.clone(),
                                        result.file_path,
                                        result.width,
                                        result.height,
                                    )
                                    .await
                                    {
                                        log::error!("Failed to open editor: {}", e);
                                        restore_main_if_visible(&app_clone);
                                    }
                                },
                                Err(e) => {
                                    log::error!("Failed to capture screenshot: {}", e);
                                    restore_main_if_visible(&app_clone);
                                },
                            }
                        },
                        OverlayAction::Cancelled => {
                            // User cancelled - close recording border only (toolbar persists)
                            close_recording_border_window(&app_clone);
                            restore_main_if_visible(&app_clone);
                        },
                    }
                },
                Ok(None) => {
                    // Cancelled (no selection made) - toolbar persists, just restore main
                    close_recording_border_window(&app_clone);
                    restore_main_if_visible(&app_clone);
                },
                Err(e) => {
                    log::error!("Capture overlay error: {}", e);
                    close_recording_border_window(&app_clone);
                    restore_main_if_visible(&app_clone);
                },
            }
        });
    });

    Ok(())
}

#[command]
pub async fn show_overlay(app: AppHandle, capture_type: Option<String>) -> Result<(), String> {
    trigger_capture(&app, capture_type.as_deref())
}

#[command]
pub async fn hide_overlay(app: AppHandle, restore_main_window: Option<bool>) -> Result<(), String> {
    // Restore main window if it was visible before capture started
    // Default to true for backward compatibility (screenshots)
    // Pass false when starting video recording to keep main window hidden
    let should_restore = restore_main_window.unwrap_or(true);
    if should_restore && MAIN_WAS_VISIBLE.swap(false, Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("library") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }

    Ok(())
}

/// Restore the main window (call this when video recording completes)
#[command]
pub async fn restore_main_window(app: AppHandle) -> Result<(), String> {
    // Check if main was visible before capture started
    if MAIN_WAS_VISIBLE.swap(false, Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("library") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }
    Ok(())
}

/// Show the library window (always shows, regardless of previous state)
#[command]
pub async fn show_library_window(app: AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("library") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    Ok(())
}

/// Open editor with a file path to raw RGBA data.
/// This is used with fast capture commands to skip PNG encoding on the Rust side.
/// The frontend will handle conversion to displayable format using browser APIs.
#[command]
pub async fn open_editor_fast(
    app: AppHandle,
    file_path: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Close all overlays and restore main window (this is for screenshots)
    hide_overlay(app.clone(), None).await?;

    // Show main window with the capture file path
    if let Some(main_window) = app.get_webview_window("library") {
        let _ = main_window.unminimize();

        main_window
            .show()
            .map_err(|e| format!("Failed to show main window: {}", e))?;

        let _ = main_window.request_user_attention(Some(tauri::UserAttentionType::Informational));

        main_window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        // Emit a different event for fast capture with file path
        let payload = serde_json::json!({
            "file_path": file_path,
            "width": width,
            "height": height,
        });

        main_window
            .emit("capture-complete-fast", payload)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}
