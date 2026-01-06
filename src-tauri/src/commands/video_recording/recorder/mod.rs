//! Core video recording implementation.
//!
//! Uses Windows Graphics Capture (WGC) for frame capture
//! and VideoEncoder for hardware-accelerated MP4 encoding.

// Allow unused internal helpers - may be useful for future features
#![allow(dead_code)]

mod buffer;
mod gif;
mod helpers;
mod video;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::Receiver;
use tauri::AppHandle;

use super::desktop_icons::{hide_desktop_icons, show_desktop_icons};
use super::state::{RecorderCommand, RecordingProgress, RECORDING_CONTROLLER};
use super::{emit_state_change, RecordingFormat, RecordingSettings, RecordingState};

// Note: validate_video_file is used internally by the module, not re-exported

// ============================================================================
// Public API
// ============================================================================

/// Start a new recording.
pub async fn start_recording(
    app: AppHandle,
    settings: RecordingSettings,
    output_path: PathBuf,
) -> Result<(), String> {
    log::debug!(
        "[RECORDING] Starting: format={:?}, countdown={}",
        settings.format,
        settings.countdown_secs
    );

    let (progress, command_rx) = {
        let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
        controller.start(settings.clone(), output_path.clone())?
    };

    // Note: Webcam and screen capture are pre-warmed when toolbar appears.
    // See prewarm_capture() in mod.rs

    // Handle countdown
    if settings.countdown_secs > 0 {
        let app_clone = app.clone();
        let settings_clone = settings.clone();
        let output_path_clone = output_path.clone();
        let progress_clone = Arc::clone(&progress);
        let command_rx_clone = command_rx.clone();

        // Use tauri's async runtime instead of tokio::spawn to ensure the task
        // persists across async boundaries
        tauri::async_runtime::spawn(async move {
            // Brief delay to allow countdown window to initialize its event listener
            // Without this, the first countdown event (3) may be emitted before the window is ready
            tokio::time::sleep(Duration::from_millis(150)).await;

            for i in (1..=settings_clone.countdown_secs).rev() {
                // Check for stop/cancel commands during countdown
                match command_rx_clone.try_recv() {
                    Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                        if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                            controller.reset();
                        }
                        emit_state_change(&app_clone, &RecordingState::Idle);
                        return;
                    },
                    _ => {},
                }

                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.update_countdown(i);
                }

                emit_state_change(
                    &app_clone,
                    &RecordingState::Countdown {
                        seconds_remaining: i,
                    },
                );

                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            // Final check before starting recording
            match command_rx_clone.try_recv() {
                Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.reset();
                    }
                    emit_state_change(&app_clone, &RecordingState::Idle);
                    return;
                },
                _ => {},
            }

            // Start actual recording
            if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                controller.start_actual_recording();
            }

            // Emit recording state IMMEDIATELY for instant UI feedback (optimistic UI)
            // Border shows right away, init happens in background
            let started_at = chrono::Local::now().to_rfc3339();
            emit_state_change(
                &app_clone,
                &RecordingState::Recording {
                    started_at: started_at.clone(),
                    elapsed_secs: 0.0,
                    frame_count: 0,
                },
            );

            // Start capture in background thread
            start_capture_thread(
                app_clone,
                settings_clone,
                output_path_clone,
                progress_clone,
                command_rx_clone,
                started_at,
            );
        });
    } else {
        // No countdown, start immediately
        // Emit recording state IMMEDIATELY for instant UI feedback
        let started_at = chrono::Local::now().to_rfc3339();
        emit_state_change(
            &app,
            &RecordingState::Recording {
                started_at: started_at.clone(),
                elapsed_secs: 0.0,
                frame_count: 0,
            },
        );

        start_capture_thread(app, settings, output_path, progress, command_rx, started_at);
    }

    Ok(())
}

/// Start the capture thread based on recording mode and format.
fn start_capture_thread(
    app: AppHandle,
    settings: RecordingSettings,
    output_path: PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
    started_at: String,
) {
    let app_clone = app.clone();
    let output_path_clone = output_path.clone();

    let _handle = std::thread::spawn(move || {
        // Hide desktop icons if enabled (will be restored when recording ends)
        hide_desktop_icons();

        // Catch any panics to ensure we log them
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Window mode is now handled natively by WGC in run_video_capture/run_gif_capture
            // No need to resolve to region mode anymore

            let result = match settings.format {
                RecordingFormat::Mp4 => video::run_video_capture(
                    &app,
                    &settings,
                    &output_path,
                    progress.clone(),
                    command_rx,
                    &started_at,
                ),
                RecordingFormat::Gif => gif::run_gif_capture(
                    &app,
                    &settings,
                    &output_path,
                    progress.clone(),
                    command_rx,
                    &started_at,
                ),
            };

            // Check if recording was cancelled
            let was_cancelled = RECORDING_CONTROLLER
                .lock()
                .map(|c| {
                    c.active
                        .as_ref()
                        .map(|a| a.progress.was_cancelled())
                        .unwrap_or(false)
                })
                .unwrap_or(false);

            if was_cancelled {
                let _ = std::fs::remove_file(&output_path_clone);
                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.reset();
                }
                emit_state_change(&app_clone, &RecordingState::Idle);
                return;
            }

            // Handle result
            match result {
                Ok(recording_duration) => {
                    // Determine the actual video file path:
                    // - Quick capture: output_path is the video file itself
                    // - Editor flow: output_path is a folder, video is at screen.mp4 inside
                    let video_file_path = if output_path_clone.is_dir() {
                        output_path_clone.join("screen.mp4")
                    } else {
                        output_path_clone.clone()
                    };

                    // Validate the video file to ensure it's not corrupted
                    // This catches issues like missing moov atom from improper shutdown
                    if let Err(validation_error) = helpers::validate_video_file(&video_file_path) {
                        log::error!("[RECORDING] Video validation failed: {}", validation_error);
                        // Delete the corrupted file/folder
                        if output_path_clone.is_dir() {
                            let _ = std::fs::remove_dir_all(&output_path_clone);
                        } else {
                            let _ = std::fs::remove_file(&output_path_clone);
                        }
                        // Emit error state
                        let error_msg = format!("Recording failed: {}", validation_error);
                        if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                            controller.set_error(error_msg.clone());
                        }
                        emit_state_change(
                            &app_clone,
                            &RecordingState::Error { message: error_msg },
                        );
                        return;
                    }

                    let file_size = std::fs::metadata(&video_file_path)
                        .map(|m| m.len())
                        .unwrap_or(0);

                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.complete(
                            output_path_clone.to_string_lossy().to_string(),
                            recording_duration,
                            file_size,
                        );
                    }

                    emit_state_change(
                        &app_clone,
                        &RecordingState::Completed {
                            output_path: output_path_clone.to_string_lossy().to_string(),
                            duration_secs: recording_duration,
                            file_size_bytes: file_size,
                        },
                    );
                },
                Err(e) => {
                    log::error!("[RECORDING] Failed: {}", e);
                    // Also try to clean up any partial file on error
                    let _ = std::fs::remove_file(&output_path_clone);
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.set_error(e.clone());
                    }
                    emit_state_change(&app_clone, &RecordingState::Error { message: e });
                },
            }
        })); // End of catch_unwind

        // Handle panics
        if let Err(panic_info) = result {
            let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic".to_string()
            };
            log::error!("[RECORDING] Capture thread panicked: {}", panic_msg);
            if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                controller.set_error(format!("Capture thread panicked: {}", panic_msg));
            }
            emit_state_change(
                &app_clone,
                &RecordingState::Error {
                    message: format!("Capture thread panicked: {}", panic_msg),
                },
            );
        }

        // Always restore desktop icons when recording ends (success, error, or panic)
        show_desktop_icons();
    });
}

// ============================================================================
// Recording Control Commands
// ============================================================================

/// Stop the current recording.
///
/// This sends the stop command and returns immediately.
/// The UI immediately transitions to "Processing" state (optimistic update).
/// The actual completion is signaled via the 'recording-state-changed' event
/// when the state becomes Completed or Error.
pub async fn stop_recording(app: AppHandle) -> Result<(), String> {
    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !controller.is_active() {
        return Err("No recording in progress".to_string());
    }

    controller.send_command(RecorderCommand::Stop)?;

    // Immediately emit Processing state so UI feels responsive
    // Timer stops, user sees "Saving..." or similar
    emit_state_change(&app, &RecordingState::Processing { progress: 0.0 });

    Ok(())
}

/// Cancel the current recording.
pub async fn cancel_recording(_app: AppHandle) -> Result<(), String> {
    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !controller.is_active() {
        return Err("No recording in progress".to_string());
    }

    controller.send_command(RecorderCommand::Cancel)?;
    Ok(())
}

/// Pause the current recording.
pub async fn pause_recording(app: AppHandle) -> Result<(), String> {
    let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !matches!(controller.state, RecordingState::Recording { .. }) {
        return Err("No active recording to pause".to_string());
    }

    if let Some(ref settings) = controller.settings {
        if settings.format == RecordingFormat::Gif {
            return Err("GIF recording cannot be paused".to_string());
        }
    }

    controller.send_command(RecorderCommand::Pause)?;
    controller.set_paused(true);
    emit_state_change(&app, &controller.state);

    Ok(())
}

/// Resume a paused recording.
pub async fn resume_recording(app: AppHandle) -> Result<(), String> {
    let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !matches!(controller.state, RecordingState::Paused { .. }) {
        return Err("No paused recording to resume".to_string());
    }

    controller.send_command(RecorderCommand::Resume)?;
    controller.set_paused(false);
    emit_state_change(&app, &controller.state);

    Ok(())
}
