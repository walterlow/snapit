//! GIF capture implementation.
//!
//! Uses D3D capture (scap-direct3d) for fast async capture at 30+ FPS.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use tauri::AppHandle;

use super::super::gif_encoder::GifRecorder;
use super::super::state::{RecorderCommand, RecordingProgress};
use super::super::{
    emit_state_change, find_monitor_for_point, RecordingMode, RecordingSettings, RecordingState,
};
use super::capture_source::CaptureSource;
use super::helpers::is_window_mode;

/// Run GIF capture using D3D capture (scap-direct3d).
/// Fast async capture at 30+ FPS for smooth GIFs.
/// Returns the actual recording duration in seconds.
pub fn run_gif_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
    started_at: &str,
) -> Result<f64, String> {
    log::debug!("[GIF] Starting capture, mode={:?}", settings.mode);

    // Check if this is Window mode
    let window_id = is_window_mode(&settings.mode);

    // Get crop region if in region mode
    let crop_region = match &settings.mode {
        RecordingMode::Region {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Determine monitor index and offset for Region mode
    let (monitor_index, monitor_offset) = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => (*monitor_index, (0, 0)),
        RecordingMode::Region { x, y, .. } => {
            if let Some((idx, name, mx, my)) = find_monitor_for_point(*x, *y) {
                log::info!(
                    "[GIF] Region ({}, {}) is on monitor {} '{}' at offset ({}, {})",
                    x,
                    y,
                    idx,
                    &name,
                    mx,
                    my
                );
                (idx, (mx, my))
            } else {
                (0, (0, 0))
            }
        },
        _ => (0, (0, 0)),
    };

    // Create capture source based on mode (all use D3D now)
    let (mut capture, first_frame_dims) = if let Some(wid) = window_id {
        log::debug!("[GIF] Using D3D window capture for hwnd={}", wid);
        let capture = CaptureSource::new_window(wid, settings.include_cursor)
            .map_err(|e| format!("Failed to start D3D window capture: {}", e))?;

        // Wait for first frame to get actual dimensions
        let first_frame = capture.wait_for_first_frame(1000);
        if first_frame.is_none() {
            log::warn!("[GIF] Timeout waiting for first frame from window capture");
        }
        let dims = first_frame.as_ref().map(|(w, h, _)| (*w, *h));
        (capture, dims)
    } else if crop_region.is_some() {
        // Region mode: use D3D with crop
        log::debug!("[GIF] Using D3D region capture, monitor={}", monitor_index);
        let (x, y, w, h) = crop_region.unwrap();
        let capture = CaptureSource::new_region(
            monitor_index,
            (x, y, w, h),
            monitor_offset,
            settings.fps,
            settings.include_cursor,
        )
        .map_err(|e| format!("Failed to start D3D region capture: {}", e))?;

        let first_frame = capture.wait_for_first_frame(1000);
        let dims = first_frame.as_ref().map(|(w, h, _)| (*w, *h));
        (capture, dims)
    } else {
        // Monitor mode
        log::debug!("[GIF] Using D3D monitor capture, index={}", monitor_index);
        let capture = CaptureSource::new_monitor(monitor_index, settings.include_cursor)
            .map_err(|e| format!("Failed to start D3D capture: {}", e))?;

        let first_frame = capture.wait_for_first_frame(1000);
        let dims = first_frame.as_ref().map(|(w, h, _)| (*w, *h));
        (capture, dims)
    };

    // Get capture dimensions from first frame
    let (capture_width, capture_height) =
        first_frame_dims.unwrap_or_else(|| (capture.width(), capture.height()));
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else {
        (capture_width, capture_height)
    };

    let max_duration = settings
        .max_duration_secs
        .map(|s| Duration::from_secs(s as u64));
    let max_frames = settings.fps as usize * settings.max_duration_secs.unwrap_or(30) as usize;

    // Create GIF recorder
    let recorder = Arc::new(Mutex::new(GifRecorder::new(
        width,
        height,
        settings.fps,
        settings.gif_quality_preset,
        max_frames,
    )));

    // Recording loop - consume frames from WGC as they arrive
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let frame_timeout_ms = (frame_duration.as_millis() as u64).max(50);

    // Recording state was already emitted before thread started (optimistic UI)
    let start_time = Instant::now();
    let mut last_frame_time = start_time;

    loop {
        // Check for commands
        match command_rx.try_recv() {
            Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                if matches!(command_rx.try_recv(), Ok(RecorderCommand::Cancel)) {
                    progress.mark_cancelled();
                }
                break;
            },
            _ => {},
        }

        // Check max duration
        let elapsed = start_time.elapsed();
        if let Some(max_dur) = max_duration {
            if elapsed >= max_dur {
                break;
            }
        }

        // Wait until it's time for the next frame
        let now = Instant::now();
        let time_since_last = now.duration_since(last_frame_time);
        if time_since_last < frame_duration {
            let sleep_time = frame_duration - time_since_last;
            std::thread::sleep(sleep_time);
        }

        // Get the most recent frame
        let frame = match capture.get_frame(frame_timeout_ms) {
            Some(f) => f,
            None => continue,
        };

        last_frame_time = Instant::now();

        // D3D returns BGRA - keep it as BGRA, FFmpeg will handle it
        // Note: D3D capture with crop already returns cropped frames, no manual crop needed
        let final_data = frame.data;

        // Add frame with actual elapsed timestamp
        let timestamp = elapsed.as_secs_f64();
        if let Ok(mut rec) = recorder.lock() {
            rec.add_frame(final_data, width, height, timestamp);
        }

        progress.increment_frame();

        let frame_count = progress.get_frame_count();
        if frame_count % 30 == 0 {
            emit_state_change(
                app,
                &RecordingState::Recording {
                    started_at: started_at.to_string(),
                    elapsed_secs: elapsed.as_secs_f64(),
                    frame_count,
                },
            );
        }
    }

    // Stop D3D capture
    capture.stop();

    // Capture duration before any post-processing
    let recording_duration = start_time.elapsed().as_secs_f64();

    // Check if cancelled
    if progress.was_cancelled() {
        return Ok(recording_duration); // Return duration even if cancelled
    }

    // Encode GIF
    emit_state_change(app, &RecordingState::Processing { progress: 0.0 });

    let total_duration = start_time.elapsed();
    let recorder_guard = recorder.lock().map_err(|_| "Failed to lock recorder")?;
    let frame_count = recorder_guard.frame_count();

    log::debug!(
        "[GIF] Capture complete: {} frames in {:.2}s ({:.1} fps)",
        frame_count,
        total_duration.as_secs_f64(),
        frame_count as f64 / total_duration.as_secs_f64()
    );

    if frame_count == 0 {
        return Err("No frames captured".to_string());
    }

    let app_clone = app.clone();
    recorder_guard
        .encode_to_file(output_path, move |encoding_progress| {
            emit_state_change(
                &app_clone,
                &RecordingState::Processing {
                    progress: encoding_progress,
                },
            );
        })
        .map_err(|e| format!("Failed to encode GIF: {}", e))?;

    Ok(recording_duration)
}
