//! Video (MP4) capture implementation.
//!
//! Uses DXGI Duplication API for frame capture with WGC fallback,
//! and VideoEncoder for hardware-accelerated MP4 encoding.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, TryRecvError};
use tauri::AppHandle;
use windows_capture::{
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
        VideoSettingsSubType,
    },
    monitor::Monitor,
};

use super::super::audio_multitrack::MultiTrackAudioRecorder;
use super::super::cursor::{save_cursor_recording, CursorEventCapture};
use super::super::state::{RecorderCommand, RecordingProgress};
use super::super::webcam::{stop_capture_service, WebcamEncoderPipe};
use super::super::wgc_capture::WgcVideoCapture;
use super::super::{
    emit_state_change, get_webcam_settings, RecordingMode, RecordingSettings, RecordingState,
};
use super::backend::{switch_to_wgc, CaptureBackend};
use super::buffer::FrameBufferPool;
use super::helpers::{create_video_project_file, is_window_mode, mux_audio_to_video};

/// Run video (MP4) capture using DXGI Duplication API.
///
/// For MP4, `output_path` is a project folder containing:
///   - screen.mp4 (main recording)
///   - webcam.mp4 (optional)
///   - cursor.json (optional)
///   - project.json (video project metadata, created after recording)
///
/// Returns the actual recording duration in seconds.
pub fn run_video_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
    started_at: &str,
) -> Result<f64, String> {
    log::debug!(
        "[CAPTURE] Starting video capture, mode={:?}, quick_capture={}",
        settings.mode,
        settings.quick_capture
    );

    // Determine video output path based on capture mode:
    // - Quick capture: output_path IS the final MP4 file
    // - Editor flow: output_path is a folder, video goes to screen.mp4 inside
    let screen_video_path = if settings.quick_capture {
        output_path.clone()
    } else {
        output_path.join("screen.mp4")
    };

    // === WEBCAM OUTPUT PATH ===
    // Webcam is only supported in editor flow (not quick capture).
    // Webcam capture service is already running (pre-warmed during countdown).
    let webcam_output_path: Option<PathBuf> = if !settings.quick_capture {
        let webcam_enabled = get_webcam_settings().map(|s| s.enabled).unwrap_or(false);
        if webcam_enabled {
            Some(output_path.join("webcam.mp4"))
        } else {
            None
        }
    } else {
        // Quick capture: no webcam support
        None
    };

    // Check if this is Window mode (native window capture via WGC)
    let window_id = is_window_mode(&settings.mode);

    // Get crop region if in region mode (not used for Window mode)
    let crop_region = match &settings.mode {
        RecordingMode::Region {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Get monitor index for potential WGC fallback (not used for Window mode)
    let monitor_index = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => *monitor_index,
        RecordingMode::Region { x, y, .. } => {
            // Find monitor that contains this region's top-left corner
            if let Ok(monitors) = xcap::Monitor::all() {
                let mut found_idx = 0;
                for (idx, m) in monitors.iter().enumerate() {
                    let mx = m.x().unwrap_or(0);
                    let my = m.y().unwrap_or(0);
                    let mw = m.width().unwrap_or(0) as i32;
                    let mh = m.height().unwrap_or(0) as i32;
                    if *x >= mx && *x < mx + mw && *y >= my && *y < my + mh {
                        found_idx = idx;
                        break;
                    }
                }
                found_idx
            } else {
                0
            }
        },
        _ => 0,
    };

    // Create capture backend based on mode
    // For WGC window capture, we need to wait for the first frame to get accurate dimensions
    // (window rect may differ from actual capture due to DPI scaling on multi-monitor setups)
    let (mut capture, first_wgc_frame) = if let Some(wid) = window_id {
        let wgc = WgcVideoCapture::new_window(wid, settings.include_cursor)
            .map_err(|e| format!("Failed to create WGC window capture: {}", e))?;

        // Wait for first frame to get actual dimensions (important for DPI scaling)
        let first_frame = wgc.wait_for_first_frame(1000);
        (CaptureBackend::Wgc(wgc), first_frame)
    } else {
        // Monitor/Region mode: use DXGI with WGC fallback
        let monitor = match &settings.mode {
            RecordingMode::Monitor { monitor_index } => {
                let monitors = Monitor::enumerate()
                    .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
                monitors
                    .get(*monitor_index)
                    .ok_or("Monitor not found")?
                    .clone()
            },
            _ => Monitor::primary().map_err(|e| format!("Failed to get primary monitor: {}", e))?,
        };

        // Create DXGI duplication session (will fallback to WGC if needed)
        let dxgi = windows_capture::dxgi_duplication_api::DxgiDuplicationApi::new(monitor)
            .map_err(|e| format!("Failed to create DXGI duplication: {:?}", e))?;

        (CaptureBackend::Dxgi(dxgi), None)
    };

    // Get capture dimensions - for WGC window capture, use actual frame dimensions
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else if let Some((w, h, _)) = &first_wgc_frame {
        // Use actual frame dimensions from WGC (handles DPI scaling correctly)
        (*w, *h)
    } else {
        (capture.width(), capture.height())
    };

    let bitrate = settings.calculate_bitrate(width, height);
    let max_duration = settings
        .max_duration_secs
        .map(|s| Duration::from_secs(s as u64));

    // Determine if we need audio
    let _capture_audio =
        settings.audio.capture_system_audio || settings.audio.microphone_device_index.is_some();

    // Create video encoder with audio enabled if needed
    // Use H.264 codec for better browser/WebView compatibility (HEVC requires paid extension)
    let video_settings = VideoSettingsBuilder::new(width, height)
        .sub_type(VideoSettingsSubType::H264)
        .bitrate(bitrate)
        .frame_rate(settings.fps);

    // ALWAYS disable audio in VideoEncoder - windows-capture's MediaTranscoder
    // introduces audio jitter. Instead, we use MultiTrackAudioRecorder to capture
    // perfect WAV files, then mux with FFmpeg post-recording.
    let audio_settings = AudioSettingsBuilder::default().disabled(true);

    let mut encoder = VideoEncoder::new(
        video_settings,
        audio_settings,
        ContainerSettingsBuilder::default(),
        &screen_video_path,
    )
    .map_err(|e| format!("Failed to create encoder: {:?}", e))?;

    // === SHARED CONTROL FLAGS ===
    let should_stop = Arc::new(AtomicBool::new(false));
    let is_paused = Arc::new(AtomicBool::new(false));

    // NOTE: Cursor is now captured via CursorEventCapture (events + images)
    // and rendered by the video editor/exporter - not composited during recording.

    // === WEBCAM ENCODER SETUP ===
    // Try to use pre-spawned FFmpeg pipe (from prepare_recording).
    // Falls back to spawning new one if not available.
    let mut webcam_pipe: Option<WebcamEncoderPipe> = if webcam_output_path.is_some() {
        use super::super::take_prepared_webcam_pipe;
        use super::super::webcam::WEBCAM_BUFFER;

        // Quick check if webcam is ready (should be, since we pre-warmed)
        if WEBCAM_BUFFER.current_frame_id() == 0 {
            let deadline = Instant::now() + Duration::from_millis(100);
            while Instant::now() < deadline && WEBCAM_BUFFER.current_frame_id() == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        // Try to use pre-spawned pipe first (instant!)
        if let Some(pipe) = take_prepared_webcam_pipe() {
            Some(pipe)
        } else if let Some(ref webcam_path) = webcam_output_path {
            // Fallback: spawn new FFmpeg (slower)
            log::debug!("[WEBCAM] No prepared pipe, spawning FFmpeg now");
            match WebcamEncoderPipe::new(webcam_path.clone()) {
                Ok(pipe) => Some(pipe),
                Err(e) => {
                    log::warn!("Webcam encoder failed: {}", e);
                    stop_capture_service();
                    None
                },
            }
        } else {
            None
        }
    } else {
        None
    };

    // === MULTI-TRACK AUDIO RECORDING ===
    // Record system audio and microphone to separate WAV files for later mixing.
    // This enables independent volume control in the video editor.
    // Use shared flags so pause/resume affects multi-track audio too.
    let mut multitrack_audio =
        MultiTrackAudioRecorder::with_flags(Arc::clone(&should_stop), Arc::clone(&is_paused));

    // Audio files location depends on capture mode:
    // - Quick capture: output_path is a FILE (e.g., recording.mp4), so put audio as siblings
    // - Editor flow: output_path is a FOLDER, so put audio files inside
    let (system_audio_path, mic_audio_path) = {
        let audio_base_path = if settings.quick_capture {
            // Quick capture: put temp audio files alongside the video file
            // e.g., recording.mp4 → recording_system.wav, recording_mic.wav
            output_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| output_path.clone())
        } else {
            // Editor flow: put audio files inside the project folder
            output_path.clone()
        };

        let file_stem = if settings.quick_capture {
            output_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("recording")
                .to_string()
        } else {
            String::new()
        };

        let system_path = if settings.audio.capture_system_audio {
            if settings.quick_capture {
                Some(audio_base_path.join(format!("{}_system.wav", file_stem)))
            } else {
                Some(audio_base_path.join("system.wav"))
            }
        } else {
            None
        };

        let mic_path = if settings.audio.microphone_device_index.is_some() {
            if settings.quick_capture {
                Some(audio_base_path.join(format!("{}_mic.wav", file_stem)))
            } else {
                Some(audio_base_path.join("mic.wav"))
            }
        } else {
            None
        };

        (system_path, mic_path)
    };

    // Start multi-track audio recording
    if system_audio_path.is_some() || mic_audio_path.is_some() {
        log::debug!(
            "[AUDIO] Starting multi-track recording: system={:?}, mic={:?}",
            system_audio_path,
            mic_audio_path
        );
        if let Err(e) = multitrack_audio.start(system_audio_path.clone(), mic_audio_path.clone()) {
            log::warn!("Failed to start multi-track audio: {}", e);
        }
    }

    // === CURSOR EVENT CAPTURE ===
    // Record cursor positions and clicks for auto-zoom in video editor.
    // Only used in editor flow (not quick capture) since cursor is baked into video for quick capture.
    let mut cursor_event_capture = CursorEventCapture::new();
    let cursor_data_path = if !settings.quick_capture {
        Some(output_path.join("cursor.json"))
    } else {
        None
    };

    // Get region for cursor capture (if region mode)
    let cursor_region = match &settings.mode {
        RecordingMode::Region {
            x,
            y,
            width,
            height,
        } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Only start cursor capture for editor flow
    if !settings.quick_capture {
        if let Err(e) = cursor_event_capture.start(cursor_region) {
            log::warn!("Failed to start cursor event capture: {}", e);
        }
    }

    // Pre-allocate frame buffers to avoid per-frame allocations
    let mut buffer_pool = FrameBufferPool::new(width, height);

    // Recording loop variables
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let mut frame_count: u64 = 0;
    let mut paused = false;
    let mut pause_time = Duration::ZERO;
    let mut pause_start: Option<Instant> = None;

    // === START RECORDING ===
    // Recording state was already emitted before thread started (optimistic UI)
    log::debug!(
        "[RECORDING] Capture loop starting: {}x{} @ {}fps, webcam={}",
        width,
        height,
        settings.fps,
        webcam_pipe.is_some()
    );
    let start_time = Instant::now();
    let mut last_frame_time = start_time;

    // If we captured a first frame for dimension detection, use it as the first recorded frame
    let mut pending_first_frame: Option<Vec<u8>> = first_wgc_frame.map(|(_, _, f)| f.data);

    loop {
        // Check for commands
        match command_rx.try_recv() {
            Ok(RecorderCommand::Stop) => {
                should_stop.store(true, Ordering::SeqCst);
                break;
            },
            Ok(RecorderCommand::Cancel) => {
                should_stop.store(true, Ordering::SeqCst);
                progress.mark_cancelled();
                break;
            },
            Ok(RecorderCommand::Pause) => {
                if !paused {
                    paused = true;
                    pause_start = Some(Instant::now());
                    progress.set_paused(true);
                    is_paused.store(true, Ordering::SeqCst);
                }
            },
            Ok(RecorderCommand::Resume) => {
                if paused {
                    if let Some(ps) = pause_start.take() {
                        pause_time += ps.elapsed();
                    }
                    paused = false;
                    progress.set_paused(false);
                    is_paused.store(false, Ordering::SeqCst);
                }
            },
            Err(TryRecvError::Empty) => {},
            Err(TryRecvError::Disconnected) => {
                should_stop.store(true, Ordering::SeqCst);
                break;
            },
        }

        // Skip frame capture while paused
        if paused {
            match command_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(RecorderCommand::Resume) => {
                    if let Some(ps) = pause_start.take() {
                        pause_time += ps.elapsed();
                    }
                    paused = false;
                    progress.set_paused(false);
                    is_paused.store(false, Ordering::SeqCst);
                },
                Ok(RecorderCommand::Stop) => {
                    should_stop.store(true, Ordering::SeqCst);
                    break;
                },
                Ok(RecorderCommand::Cancel) => {
                    should_stop.store(true, Ordering::SeqCst);
                    progress.mark_cancelled();
                    break;
                },
                Ok(RecorderCommand::Pause) => {}, // Already paused, ignore
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}, // Normal timeout, continue loop
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    should_stop.store(true, Ordering::SeqCst);
                    break;
                },
            }
            continue;
        }

        // Check max duration
        let actual_elapsed = start_time.elapsed() - pause_time;
        if let Some(max_dur) = max_duration {
            if actual_elapsed >= max_dur {
                should_stop.store(true, Ordering::SeqCst);
                break;
            }
        }

        // Frame rate limiting - sleep for remaining time instead of busy-waiting
        let elapsed_since_frame = last_frame_time.elapsed();
        if elapsed_since_frame < frame_duration {
            let remaining = frame_duration - elapsed_since_frame;
            // Sleep for most of the remaining time, leaving a small margin for timing accuracy
            if remaining > Duration::from_micros(500) {
                std::thread::sleep(remaining - Duration::from_micros(500));
            }
            continue;
        }

        // Acquire next frame from capture backend (DXGI or WGC) into buffer pool
        let frame_acquired = match &mut capture {
            CaptureBackend::Dxgi(dxgi) => {
                match dxgi.acquire_next_frame(100) {
                    Ok(mut frame) => {
                        // Get frame buffer (with optional crop)
                        let buffer_result = if let Some((x, y, w, h)) = crop_region {
                            let start_x = x.max(0) as u32;
                            let start_y = y.max(0) as u32;
                            let end_x = start_x + w;
                            let end_y = start_y + h;
                            frame.buffer_crop(start_x, start_y, end_x, end_y)
                        } else {
                            frame.buffer()
                        };

                        match buffer_result {
                            Ok(buffer) => {
                                // Use a temporary Vec for DXGI extraction (as_nopadding_buffer has specific requirements)
                                // Then copy to the pooled frame_buffer for compositing
                                let mut raw_data = Vec::new();
                                let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);
                                let len = pixel_data.len().min(buffer_pool.frame_size);
                                buffer_pool.frame_buffer[..len].copy_from_slice(&pixel_data[..len]);
                                true
                            },
                            Err(e) => {
                                let err_str = format!("{:?}", e);
                                if err_str.contains("0x887A0005")
                                    || err_str.contains("DEVICE_REMOVED")
                                    || err_str.contains("suspended")
                                {
                                    // GPU device lost - switch to WGC
                                    match switch_to_wgc(monitor_index, settings.include_cursor) {
                                        Ok(new_backend) => {
                                            capture = new_backend;
                                            continue;
                                        },
                                        Err(e) => {
                                            return Err(format!(
                                                "DXGI failed and WGC fallback also failed: {}",
                                                e
                                            ));
                                        },
                                    }
                                } else {
                                    false
                                }
                            },
                        }
                    },
                    Err(windows_capture::dxgi_duplication_api::Error::Timeout) => false,
                    Err(windows_capture::dxgi_duplication_api::Error::AccessLost) => {
                        match switch_to_wgc(monitor_index, settings.include_cursor) {
                            Ok(new_backend) => {
                                capture = new_backend;
                                continue;
                            },
                            Err(e) => {
                                return Err(format!(
                                    "DXGI access lost and WGC fallback failed: {}",
                                    e
                                ));
                            },
                        }
                    },
                    Err(e) => {
                        let err_str = format!("{:?}", e);
                        if err_str.contains("0x887A0005") || err_str.contains("DEVICE_REMOVED") {
                            match switch_to_wgc(monitor_index, settings.include_cursor) {
                                Ok(new_backend) => {
                                    capture = new_backend;
                                    continue;
                                },
                                Err(e) => {
                                    return Err(format!(
                                        "DXGI error and WGC fallback failed: {}",
                                        e
                                    ));
                                },
                            }
                        } else {
                            std::thread::sleep(Duration::from_millis(50));
                            false
                        }
                    },
                }
            },
            CaptureBackend::Wgc(wgc) => {
                // WGC frame acquisition - use pending first frame if available, else get new one
                let frame_data = if let Some(data) = pending_first_frame.take() {
                    Some(data)
                } else {
                    wgc.get_frame(100).map(|f| f.data)
                };

                match frame_data {
                    Some(data) => {
                        let len = data.len().min(buffer_pool.frame_size);
                        buffer_pool.frame_buffer[..len].copy_from_slice(&data[..len]);
                        true
                    },
                    None => false, // Timeout or no frame
                }
            },
        };

        // Skip if no frame was acquired
        if !frame_acquired {
            continue;
        }

        last_frame_time = Instant::now();

        // NOTE: Cursor is NO LONGER composited onto frames!
        // Cursor events and images are captured separately (CursorEventCapture)
        // and rendered by the video editor/exporter for flexibility.
        // This allows: cursor type switching, motion blur, physics smoothing, etc.

        // NOTE: Webcam is recorded to a separate file (not composited onto screen)
        // This allows toggling webcam visibility in the video editor

        // Flip vertically using pooled buffer (both DXGI and WGC return top-down, encoder expects bottom-up)
        let flipped_data = buffer_pool.flip_vertical(width, height);

        // Get video timestamp
        let video_timestamp = (actual_elapsed.as_micros() * 10) as i64;

        // Send video frame to encoder
        let _ = encoder.send_frame_buffer(flipped_data, video_timestamp);

        // Audio is NOT sent to encoder - see comment at audio_settings creation.
        // MultiTrackAudioRecorder handles WAV capture, FFmpeg muxes post-recording.

        // === WEBCAM FRAME (synchronized with screen frame) ===
        // Write webcam frame for each screen frame - ensures 1:1 correspondence
        if let Some(ref mut pipe) = webcam_pipe {
            pipe.write_frame();
        }

        frame_count += 1;
        progress.increment_frame();

        // Emit progress periodically
        if frame_count % 30 == 0 {
            emit_state_change(
                app,
                &RecordingState::Recording {
                    started_at: started_at.to_string(),
                    elapsed_secs: actual_elapsed.as_secs_f64(),
                    frame_count,
                },
            );
        }
    }

    // Calculate recording stats
    let total_elapsed = start_time.elapsed();
    let recording_duration = total_elapsed - pause_time;
    let webcam_frames = webcam_pipe
        .as_ref()
        .map(|p| p.frames_written())
        .unwrap_or(0);
    log::debug!(
        "[RECORDING] Complete: {:.2}s, {} frames ({:.1} fps), webcam: {} frames",
        recording_duration.as_secs_f64(),
        frame_count,
        frame_count as f64 / recording_duration.as_secs_f64(),
        webcam_frames
    );

    // Check if recording was cancelled
    let was_cancelled = progress.was_cancelled();

    // Finish webcam encoder BEFORE stopping capture service
    // Pass the actual recording duration so webcam syncs perfectly with screen
    if let Some(pipe) = webcam_pipe {
        if was_cancelled {
            pipe.cancel();
            if let Some(ref path) = webcam_output_path {
                let _ = std::fs::remove_file(path);
            }
        } else if let Err(e) = pipe.finish_with_duration(recording_duration.as_secs_f64()) {
            log::warn!("Webcam encoding failed: {}", e);
        }
    }

    // Stop capture services
    stop_capture_service();
    let _ = multitrack_audio.stop();
    let cursor_recording = cursor_event_capture.stop();

    // If cancelled, skip main encoder
    if was_cancelled {
        drop(encoder);
        return Ok(recording_duration.as_secs_f64());
    }

    // Save cursor data (editor flow only)
    if !settings.quick_capture {
        if let Some(ref path) = cursor_data_path {
            if !cursor_recording.events.is_empty() {
                let _ = save_cursor_recording(&cursor_recording, path);
            }
        }
    }

    // Finish main video encoder (video-only, no audio)
    encoder
        .finish()
        .map_err(|e| format!("Failed to finish encoding: {:?}", e))?;

    // Mux audio with video using FFmpeg (bypasses windows-capture audio jitter)
    if let Err(e) = mux_audio_to_video(
        &screen_video_path,
        system_audio_path.as_ref(),
        mic_audio_path.as_ref(),
    ) {
        log::warn!("Audio muxing failed: {}", e);
    }

    // NOTE: Webcam sync is now handled in finish_with_duration() above.
    // The webcam encoder remuxes with correct FPS to match screen duration.

    // Create project.json with video project metadata (editor flow only)
    if !settings.quick_capture {
        create_video_project_file(
            output_path,
            width,
            height,
            recording_duration.as_millis() as u64,
            settings.fps,
            webcam_output_path.is_some(),
            cursor_data_path
                .as_ref()
                .map(|_| !cursor_recording.events.is_empty())
                .unwrap_or(false),
        )?;
    }

    Ok(recording_duration.as_secs_f64())
}
