//! Capture flow and overlay commands.

use std::sync::atomic::Ordering;
use tauri::{command, AppHandle, Emitter, Manager};

use super::{
    close_all_capture_windows, close_recording_border_window, restore_main_if_visible,
    MAIN_WAS_VISIBLE,
};

/// Trigger the capture overlay - uses DirectComposition overlay for all capture types.
/// capture_type: "screenshot", "video", or "gif"
///
/// Uses DirectComposition overlay to avoid blackout issues with hardware-accelerated
/// video content. This works for all capture types (screenshot, video, gif).
///
/// ## Recording Flow (Frontend is Source of Truth)
///
/// For video/gif recording, this function does NOT start recording. The flow is:
/// 1. Frontend calls `prepare_recording` when selection is confirmed → sets up output path + webcam pipe
/// 2. Frontend calls `set_webcam_enabled` to configure webcam settings
/// 3. Frontend calls `capture_overlay_confirm('recording')` → overlay closes
/// 4. Frontend calls `start_recording` with settings → uses prepared output path
///
/// This ensures webcam.mp4 and screen.mp4 are saved to the same folder.
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
                            // Recording is handled by the frontend via start_recording command.
                            // The frontend has already:
                            // 1. Called prepare_recording() to set up output path and webcam pipe
                            // 2. Set webcam settings via set_webcam_enabled()
                            // 3. Will call start_recording() with the correct prepared path
                            //
                            // We just need to log that we're done here - no duplicate recording logic.
                            log::info!(
                                "[trigger_capture] Overlay confirmed recording for region {}x{} at ({}, {})",
                                width, height, x, y
                            );
                        },
                        OverlayAction::CaptureScreenshot => {
                            // Screenshot flow - close all windows, capture, open editor
                            println!(
                                "[SCREENSHOT] Starting capture - bounds=({},{}) {}x{}, window_id={:?}",
                                x, y, width, height, window_id
                            );
                            close_all_capture_windows(&app_clone);

                            // Use window capture if a window was selected, otherwise region capture
                            let capture_result = if let Some(hwnd) = window_id {
                                println!("[SCREENSHOT] Using window capture for hwnd={} (0x{:X})", hwnd, hwnd);
                                crate::commands::capture::capture_window_fast(hwnd).await
                            } else {
                                println!(
                                    "[SCREENSHOT] Using region capture: x={}, y={}, w={}, h={}",
                                    x, y, width, height
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
                                    println!(
                                        "[SCREENSHOT] Capture succeeded - {}x{}, file: {}",
                                        result.width, result.height, result.file_path
                                    );
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
                                    println!("[SCREENSHOT] Capture FAILED: {}", e);
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
    // Close all overlays
    hide_overlay(app.clone(), None).await?;

    // Emit event to main window - it will open the image editor window
    // (library window no longer needs to be shown/focused since editor opens in separate window)
    if let Some(main_window) = app.get_webview_window("library") {
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
