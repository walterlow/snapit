//! Core video recording implementation.
//!
//! Uses windows-capture's DXGI Duplication API for frame capture
//! and VideoEncoder for hardware-accelerated MP4 encoding.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, TryRecvError};
use tauri::AppHandle;
use windows_capture::{
    dxgi_duplication_api::DxgiDuplicationApi,
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder},
    monitor::Monitor,
};

use super::audio_sync::AudioCaptureManager;
use super::cursor::{composite_cursor, CursorCapture};
use super::gif_encoder::GifRecorder;
use super::state::{RecorderCommand, RecordingProgress, RECORDING_CONTROLLER};
use super::webcam::{self, composite_webcam};
use super::wgc_capture::WgcVideoCapture;
use super::{emit_state_change, emit_webcam_error, get_webcam_settings, is_webcam_enabled, RecordingFormat, RecordingMode, RecordingSettings, RecordingState};

// ============================================================================
// Video Validation
// ============================================================================

/// Validate that a video file is properly formed (has moov atom for MP4).
/// Returns Ok(()) if valid, Err with message if corrupted.
fn validate_video_file(path: &PathBuf) -> Result<(), String> {
    // Only validate MP4 files
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if extension != "mp4" {
        return Ok(()); // Skip validation for non-MP4 files
    }

    // Find ffprobe
    let ffprobe_path = crate::commands::storage::find_ffprobe()
        .ok_or_else(|| "ffprobe not available for validation".to_string())?;

    // Run ffprobe to check if file is valid
    // A corrupted MP4 (missing moov atom) will fail with an error
    let output = std::process::Command::new(&ffprobe_path)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            &path.to_string_lossy().to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Check for common corruption indicators
        if stderr.contains("moov atom not found")
            || stderr.contains("Invalid data found")
            || stderr.contains("could not find codec parameters")
        {
            return Err(format!("Video file is corrupted: {}", stderr.trim()));
        }
        return Err(format!("Video validation failed: {}", stderr.trim()));
    }

    // Check that we got a valid duration
    let stdout = String::from_utf8_lossy(&output.stdout);
    let duration_str = stdout.trim();
    if duration_str.is_empty() || duration_str == "N/A" {
        return Err("Video file has no valid duration (likely corrupted)".to_string());
    }

    Ok(())
}

// ============================================================================
// Audio Helpers
// ============================================================================

/// Convert f32 audio samples to 16-bit PCM bytes (little-endian).
///
/// The encoder expects interleaved 16-bit PCM data.
/// WASAPI provides f32 samples in the range [-1.0, 1.0].
fn f32_to_i16_pcm(samples: &[f32]) -> Vec<u8> {
    let mut pcm_bytes = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        // Clamp to [-1.0, 1.0] and convert to i16
        let clamped = sample.clamp(-1.0, 1.0);
        let i16_sample = (clamped * 32767.0) as i16;
        // Little-endian bytes
        pcm_bytes.extend_from_slice(&i16_sample.to_le_bytes());
    }
    pcm_bytes
}

// ============================================================================
// DXGI Recovery Helpers
// ============================================================================

/// Capture backend abstraction.
///
/// Allows switching between DXGI and WGC capture methods.
enum CaptureBackend {
    /// DXGI Desktop Duplication (preferred, lower latency)
    Dxgi(DxgiDuplicationApi),
    /// Windows Graphics Capture (fallback, more compatible)
    Wgc(WgcVideoCapture),
}

impl CaptureBackend {
    fn width(&self) -> u32 {
        match self {
            CaptureBackend::Dxgi(dxgi) => dxgi.width(),
            CaptureBackend::Wgc(wgc) => wgc.width(),
        }
    }

    fn height(&self) -> u32 {
        match self {
            CaptureBackend::Dxgi(dxgi) => dxgi.height(),
            CaptureBackend::Wgc(wgc) => wgc.height(),
        }
    }

    fn name(&self) -> &'static str {
        match self {
            CaptureBackend::Dxgi(_) => "DXGI",
            CaptureBackend::Wgc(_) => "WGC",
        }
    }
}

/// Result of trying to acquire a frame from the capture backend.
enum FrameAcquireResult {
    /// Successfully acquired a frame
    Frame(Vec<u8>),
    /// No frame available (timeout)
    Timeout,
    /// GPU device was lost - should switch to WGC
    DeviceLost,
    /// Other error
    Error(String),
}

/// Try to switch from DXGI to WGC capture backend.
fn switch_to_wgc(
    monitor_index: usize,
    include_cursor: bool,
) -> Result<CaptureBackend, String> {
    println!("[CAPTURE] GPU device lost - attempting to switch to WGC capture...");

    let wgc = WgcVideoCapture::new(monitor_index, include_cursor)
        .map_err(|e| format!("Failed to create WGC capture: {}", e))?;

    println!("[CAPTURE] Successfully switched to WGC capture backend");
    Ok(CaptureBackend::Wgc(wgc))
}

// ============================================================================
// Window Helpers
// ============================================================================

/// Get window bounds using Windows API.
/// Returns (x, y, width, height) of the window's visible bounds.
#[cfg(target_os = "windows")]
fn get_window_rect(window_id: u32) -> Result<(i32, i32, u32, u32), String> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{IsIconic, IsWindowVisible},
    };

    unsafe {
        let hwnd = HWND(window_id as *mut std::ffi::c_void);

        // Check if window is visible and not minimized
        if !IsWindowVisible(hwnd).as_bool() {
            return Err("Window is not visible".to_string());
        }

        if IsIconic(hwnd).as_bool() {
            return Err("Window is minimized".to_string());
        }

        // Get window bounds using DWM (excludes shadow, includes titlebar)
        let mut rect = RECT::default();
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        ).map_err(|e| format!("Failed to get window bounds: {:?}", e))?;

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;

        if width < 10 || height < 10 {
            return Err("Window is too small".to_string());
        }

        Ok((rect.left, rect.top, width, height))
    }
}

#[cfg(not(target_os = "windows"))]
fn get_window_rect(_window_id: u32) -> Result<(i32, i32, u32, u32), String> {
    Err("Window capture not supported on this platform".to_string())
}

/// Convert Window mode to Region mode by getting window bounds.
fn resolve_window_to_region(mode: &RecordingMode) -> Result<RecordingMode, String> {
    match mode {
        RecordingMode::Window { window_id } => {
            let (x, y, width, height) = get_window_rect(*window_id)?;
            Ok(RecordingMode::Region { x, y, width, height })
        }
        other => Ok(other.clone()),
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Start a new recording.
pub async fn start_recording(
    app: AppHandle,
    settings: RecordingSettings,
    output_path: PathBuf,
) -> Result<(), String> {
    // Use eprintln for immediate output (stderr is unbuffered)
    eprintln!("[START] start_recording called, format={:?}, countdown={}", settings.format, settings.countdown_secs);
    println!("[START] start_recording called, format={:?}", settings.format);

    let (progress, command_rx) = {
        let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
        controller.start(settings.clone(), output_path.clone())?
    };
    println!("[START] Controller started, countdown_secs={}", settings.countdown_secs);

    // Handle countdown
    if settings.countdown_secs > 0 {
        let app_clone = app.clone();
        let settings_clone = settings.clone();
        let output_path_clone = output_path.clone();
        let progress_clone = Arc::clone(&progress);
        let command_rx_clone = command_rx.clone();

        // Use tauri's async runtime instead of tokio::spawn to ensure the task
        // persists even when called from a temporary runtime (like in trigger_capture)
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
                    }
                    _ => {}
                }

                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.update_countdown(i);
                }

                emit_state_change(&app_clone, &RecordingState::Countdown {
                    seconds_remaining: i,
                });

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
                }
                _ => {}
            }

            // Start actual recording
            if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                controller.start_actual_recording();
            }

            emit_state_change(&app_clone, &RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: 0.0,
                frame_count: 0,
            });

            // Start capture in background thread
            start_capture_thread(
                app_clone,
                settings_clone,
                output_path_clone,
                progress_clone,
                command_rx_clone,
            );
        });
    } else {
        // No countdown, start immediately
        emit_state_change(&app, &RecordingState::Recording {
            started_at: chrono::Local::now().to_rfc3339(),
            elapsed_secs: 0.0,
            frame_count: 0,
        });

        start_capture_thread(app, settings, output_path, progress, command_rx);
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
) {
    println!("[START] About to spawn capture thread...");
    let app_clone = app.clone();
    let output_path_clone = output_path.clone();
    let _format_for_log = settings.format;

    let handle = std::thread::spawn(move || {
        println!("[THREAD] Capture thread started, format={:?}", settings.format);
        
        // Catch any panics to ensure we log them
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {

        // Resolve Window mode to Region mode (fixed region capture)
        let resolved_mode = match resolve_window_to_region(&settings.mode) {
            Ok(mode) => mode,
            Err(e) => {
                println!("[THREAD] Failed to resolve window mode: {}", e);
                emit_state_change(&app, &RecordingState::Error { message: e.clone() });
                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.set_error(e);
                }
                return;
            }
        };

        // Create settings with resolved mode
        let resolved_settings = RecordingSettings {
            mode: resolved_mode,
            ..settings.clone()
        };

        let result = match resolved_settings.format {
            RecordingFormat::Mp4 => {
                run_video_capture(&app, &resolved_settings, &output_path, progress.clone(), command_rx)
            }
            RecordingFormat::Gif => {
                run_gif_capture(&app, &resolved_settings, &output_path, progress.clone(), command_rx)
            }
        };

        println!("[THREAD] Capture finished, result={:?}", result.is_ok());

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
            Ok(()) => {
                println!("[THREAD] Recording OK, checking file at: {:?}", output_path_clone);

                // Validate the video file to ensure it's not corrupted
                // This catches issues like missing moov atom from improper shutdown
                if let Err(validation_error) = validate_video_file(&output_path_clone) {
                    println!("[THREAD] Video validation FAILED: {}", validation_error);
                    // Delete the corrupted file
                    if let Err(e) = std::fs::remove_file(&output_path_clone) {
                        println!("[THREAD] Failed to delete corrupted file: {}", e);
                    } else {
                        println!("[THREAD] Deleted corrupted file: {:?}", output_path_clone);
                    }
                    // Emit error state
                    let error_msg = format!("Recording failed: {}", validation_error);
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.set_error(error_msg.clone());
                    }
                    emit_state_change(&app_clone, &RecordingState::Error { message: error_msg });
                    return;
                }

                let file_size = std::fs::metadata(&output_path_clone)
                    .map(|m| m.len())
                    .unwrap_or(0);
                println!("[THREAD] File size: {} bytes", file_size);

                let duration = RECORDING_CONTROLLER
                    .lock()
                    .map(|c| c.get_elapsed_secs())
                    .unwrap_or(0.0);
                println!("[THREAD] Duration: {} secs", duration);

                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.complete(
                        output_path_clone.to_string_lossy().to_string(),
                        duration,
                        file_size,
                    );
                }

                println!("[THREAD] Emitting Completed state");
                emit_state_change(&app_clone, &RecordingState::Completed {
                    output_path: output_path_clone.to_string_lossy().to_string(),
                    duration_secs: duration,
                    file_size_bytes: file_size,
                });
            }
            Err(e) => {
                println!("[THREAD] Recording FAILED: {}", e);
                // Also try to clean up any partial file on error
                let _ = std::fs::remove_file(&output_path_clone);
                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.set_error(e.clone());
                }
                emit_state_change(&app_clone, &RecordingState::Error { message: e });
            }
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
            println!("[THREAD] PANIC in capture thread: {}", panic_msg);
            if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                controller.set_error(format!("Capture thread panicked: {}", panic_msg));
            }
            emit_state_change(&app_clone, &RecordingState::Error { 
                message: format!("Capture thread panicked: {}", panic_msg) 
            });
        }
    });
    
    println!("[START] Capture thread spawned successfully, handle: {:?}", handle.thread().id());
}

/// Run video (MP4) capture using DXGI Duplication API.
fn run_video_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
) -> Result<(), String> {
    println!("[CAPTURE] run_video_capture starting, mode={:?}", settings.mode);

    // Get crop region if in region mode
    let crop_region = match &settings.mode {
        RecordingMode::Region { x, y, width, height } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Get monitor index for potential WGC fallback
    // For region mode, find which monitor contains the region
    let monitor_index = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => *monitor_index,
        RecordingMode::Region { x, y, .. } => {
            // Find monitor that contains this region's top-left corner
            // Use xcap::Monitor which has position info
            if let Ok(monitors) = xcap::Monitor::all() {
                let mut found_idx = 0;
                for (idx, m) in monitors.iter().enumerate() {
                    let mx = m.x().unwrap_or(0);
                    let my = m.y().unwrap_or(0);
                    let mw = m.width().unwrap_or(0) as i32;
                    let mh = m.height().unwrap_or(0) as i32;
                    if *x >= mx && *x < mx + mw && *y >= my && *y < my + mh {
                        found_idx = idx;
                        eprintln!("[CAPTURE] Region ({}, {}) is on monitor {} at ({}, {})", x, y, idx, mx, my);
                        break;
                    }
                }
                found_idx
            } else {
                0
            }
        }
        _ => 0, // Primary monitor for other modes
    };

    eprintln!("[CAPTURE] Detected monitor index for WGC fallback: {}", monitor_index);

    // Get monitor to capture
    let monitor = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => {
            let monitors = Monitor::enumerate()
                .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
            monitors
                .get(*monitor_index)
                .ok_or("Monitor not found")?
                .clone()
        }
        _ => Monitor::primary().map_err(|e| format!("Failed to get primary monitor: {}", e))?,
    };

    println!("[CAPTURE] Using monitor: {:?}", monitor.name());

    // Create DXGI duplication session (will fallback to WGC if needed)
    let dxgi = DxgiDuplicationApi::new(monitor)
        .map_err(|e| format!("Failed to create DXGI duplication: {:?}", e))?;

    // Small delay to let DXGI stabilize (helps with GPU power-saving states)
    std::thread::sleep(Duration::from_millis(50));

    // Wrap in capture backend
    let mut capture = CaptureBackend::Dxgi(dxgi);

    // Get capture dimensions
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else {
        (capture.width(), capture.height())
    };

    println!("[CAPTURE] Dimensions: {}x{}, crop: {:?}, fps: {}", width, height, crop_region, settings.fps);
    eprintln!("[CAPTURE] include_cursor: {}, quality: {}", settings.include_cursor, settings.quality);

    let bitrate = settings.calculate_bitrate(width, height);
    let max_duration = settings.max_duration_secs.map(|s| Duration::from_secs(s as u64));
    println!("[CAPTURE] Bitrate: {}, max_duration: {:?}", bitrate, max_duration);

    // Determine if we need audio
    let capture_audio = settings.audio.capture_system_audio || settings.audio.microphone_device_index.is_some();

    // Create video encoder with audio enabled if needed
    let video_settings = VideoSettingsBuilder::new(width, height)
        .bitrate(bitrate)
        .frame_rate(settings.fps);

    let audio_settings = if capture_audio {
        AudioSettingsBuilder::default()
    } else {
        AudioSettingsBuilder::default().disabled(true)
    };

    let mut encoder = VideoEncoder::new(
        video_settings,
        audio_settings,
        ContainerSettingsBuilder::default(),
        output_path,
    ).map_err(|e| format!("Failed to create encoder: {:?}", e))?;

    println!("[CAPTURE] Encoder created successfully");

    // === AUDIO CAPTURE SETUP ===
    // Create shared control flags for audio threads
    let should_stop = Arc::new(AtomicBool::new(false));
    let is_paused = Arc::new(AtomicBool::new(false));
    let start_time = Instant::now();

    // Create audio capture manager
    let mut audio_manager = if capture_audio {
        let mut manager = AudioCaptureManager::new(
            Arc::clone(&should_stop),
            Arc::clone(&is_paused),
        );

        // Start system audio capture (WASAPI loopback)
        if settings.audio.capture_system_audio {
            match manager.start_system_audio(start_time) {
                Ok(()) => println!("[CAPTURE] System audio capture started"),
                Err(e) => {
                    // Log warning but continue without audio
                    println!("[CAPTURE] Warning: Failed to start system audio: {}", e);
                }
            }
        }

        // Start microphone capture with selected device
        if let Some(device_index) = settings.audio.microphone_device_index {
            match manager.start_microphone(device_index, start_time) {
                Ok(()) => println!("[CAPTURE] Microphone capture started on device {}", device_index),
                Err(e) => {
                    println!("[CAPTURE] Warning: Failed to start microphone: {}", e);
                }
            }
        }

        Some(manager)
    } else {
        None
    };

    // Cursor capture manager (for include_cursor option)
    let mut cursor_capture = if settings.include_cursor {
        Some(CursorCapture::new())
    } else {
        None
    };

    // Webcam overlay is captured on-screen (the preview window is part of the screen capture)
    // No need for separate webcam compositing - the browser's getUserMedia preview is visible
    let webcam_settings = get_webcam_settings();
    let use_webcam = false; // Disabled - webcam is captured as part of screen
    let _ = webcam_settings; // Suppress unused warning

    // Recording loop
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let mut last_frame_time = Instant::now();
    let mut frame_count: u64 = 0;
    let mut paused = false;
    let mut pause_time = Duration::ZERO;
    let mut pause_start: Option<Instant> = None;

    let mut loop_count: u64 = 0;
    loop {
        loop_count += 1;
        
        // Log every 100 loops to show we're alive
        if loop_count % 100 == 0 {
            eprintln!("[CAPTURE] Loop iteration {}, checking commands...", loop_count);
        }
        
        // Check for commands
        match command_rx.try_recv() {
            Ok(RecorderCommand::Stop) => {
                eprintln!("[CAPTURE] Received Stop command!");
                println!("[CAPTURE] Received Stop command");
                should_stop.store(true, Ordering::SeqCst);
                break;
            }
            Ok(RecorderCommand::Cancel) => {
                eprintln!("[CAPTURE] Received Cancel command!");
                println!("[CAPTURE] Received Cancel command");
                should_stop.store(true, Ordering::SeqCst);
                progress.mark_cancelled();
                break;
            }
            Ok(RecorderCommand::Pause) => {
                eprintln!("[CAPTURE] Received Pause command!");
                println!("[CAPTURE] Received Pause command");
                if !paused {
                    paused = true;
                    pause_start = Some(Instant::now());
                    progress.set_paused(true);
                    is_paused.store(true, Ordering::SeqCst);
                }
            }
            Ok(RecorderCommand::Resume) => {
                eprintln!("[CAPTURE] Received Resume command!");
                println!("[CAPTURE] Received Resume command");
                if paused {
                    if let Some(ps) = pause_start.take() {
                        pause_time += ps.elapsed();
                    }
                    paused = false;
                    progress.set_paused(false);
                    is_paused.store(false, Ordering::SeqCst);
                }
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                eprintln!("[CAPTURE] Channel disconnected!");
                println!("[CAPTURE] Channel disconnected");
                should_stop.store(true, Ordering::SeqCst);
                break;
            }
        }

        // Skip frame capture while paused
        if paused {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Check max duration
        let actual_elapsed = start_time.elapsed() - pause_time;
        if let Some(max_dur) = max_duration {
            if actual_elapsed >= max_dur {
                println!("[CAPTURE] Max duration reached");
                should_stop.store(true, Ordering::SeqCst);
                break;
            }
        }

        // Frame rate limiting
        if last_frame_time.elapsed() < frame_duration {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }

        // Acquire next frame from capture backend (DXGI or WGC)
        let frame_result: Option<Vec<u8>> = match &mut capture {
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
                                let mut raw_data = Vec::new();
                                let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);
                                Some(pixel_data.to_vec())
                            }
                            Err(e) => {
                                let err_str = format!("{:?}", e);
                                if err_str.contains("0x887A0005") || err_str.contains("DEVICE_REMOVED") || err_str.contains("suspended") {
                                    // GPU device lost - switch to WGC
                                    println!("[CAPTURE] GPU device lost during buffer access, switching to WGC...");
                                    match switch_to_wgc(monitor_index, settings.include_cursor) {
                                        Ok(new_backend) => {
                                            capture = new_backend;
                                            continue; // Retry with new backend
                                        }
                                        Err(e) => {
                                            return Err(format!("DXGI failed and WGC fallback also failed: {}", e));
                                        }
                                    }
                                } else {
                                    println!("[CAPTURE] Failed to get buffer: {:?}", e);
                                    None
                                }
                            }
                        }
                    }
                    Err(windows_capture::dxgi_duplication_api::Error::Timeout) => None,
                    Err(windows_capture::dxgi_duplication_api::Error::AccessLost) => {
                        println!("[CAPTURE] DXGI access lost, switching to WGC...");
                        match switch_to_wgc(monitor_index, settings.include_cursor) {
                            Ok(new_backend) => {
                                capture = new_backend;
                                continue;
                            }
                            Err(e) => {
                                return Err(format!("DXGI access lost and WGC fallback failed: {}", e));
                            }
                        }
                    }
                    Err(e) => {
                        let err_str = format!("{:?}", e);
                        if err_str.contains("0x887A0005") || err_str.contains("DEVICE_REMOVED") {
                            println!("[CAPTURE] GPU device error, switching to WGC...");
                            match switch_to_wgc(monitor_index, settings.include_cursor) {
                                Ok(new_backend) => {
                                    capture = new_backend;
                                    continue;
                                }
                                Err(e) => {
                                    return Err(format!("DXGI error and WGC fallback failed: {}", e));
                                }
                            }
                        } else {
                            println!("[CAPTURE] DXGI error: {:?}, retrying...", e);
                            std::thread::sleep(Duration::from_millis(50));
                            None
                        }
                    }
                }
            }
            CaptureBackend::Wgc(wgc) => {
                // WGC frame acquisition
                match wgc.get_frame(100) {
                    Some(frame) => Some(frame.data),
                    None => None, // Timeout or no frame
                }
            }
        };

        // Process the frame if we got one
        let Some(frame_data_raw) = frame_result else {
            continue; // No frame available, try again
        };

        last_frame_time = Instant::now();

        // Copy to mutable buffer for cursor compositing
        let mut frame_data = frame_data_raw;

        // Composite cursor onto frame (before vertical flip)
        // Note: WGC can include cursor natively, but we use our own for consistency
        if let Some(ref mut cursor_cap) = cursor_capture {
            match cursor_cap.capture() {
                Ok(cursor_state) => {
                    if cursor_state.visible {
                        let (region_x, region_y) = crop_region
                            .map(|(x, y, _, _)| (x, y))
                            .unwrap_or((0, 0));

                        if frame_count == 0 {
                            eprintln!("[CURSOR] Cursor visible at ({}, {}), size {}x{}, hotspot ({}, {})",
                                cursor_state.screen_x, cursor_state.screen_y,
                                cursor_state.width, cursor_state.height,
                                cursor_state.hotspot_x, cursor_state.hotspot_y);
                        }

                        composite_cursor(
                            &mut frame_data,
                            width,
                            height,
                            &cursor_state,
                            region_x,
                            region_y,
                        );
                    }
                }
                Err(e) => {
                    if frame_count == 0 {
                        eprintln!("[CURSOR] Failed to capture cursor: {}", e);
                    }
                }
            }
        }

        // Composite webcam overlay onto frame (after cursor, before flip)
        if use_webcam {
            if webcam::preview_has_error() {
                if let Some(error_msg) = webcam::get_preview_error() {
                    static WEBCAM_ERROR_EMITTED: std::sync::atomic::AtomicBool =
                        std::sync::atomic::AtomicBool::new(false);
                    if !WEBCAM_ERROR_EMITTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        eprintln!("[WEBCAM] Fatal error detected: {}", error_msg);
                        emit_webcam_error(app, &error_msg, true);
                    }
                }
            } else if let Some(webcam_frame) = webcam::get_preview_frame() {
                if frame_count == 0 {
                    eprintln!("[WEBCAM] Compositing webcam frame {}x{} onto recording {}x{}",
                        webcam_frame.width, webcam_frame.height, width, height);
                }
                composite_webcam(
                    &mut frame_data,
                    width,
                    height,
                    &webcam_frame,
                    &webcam_settings,
                );
            }
        }

        // Flip vertically (both DXGI and WGC return top-down, encoder expects bottom-up)
        let row_size = (width as usize) * 4;
        let mut flipped_data = Vec::with_capacity(frame_data.len());
        for row in frame_data.chunks_exact(row_size).rev() {
            flipped_data.extend_from_slice(row);
        }

        // Get video timestamp
        let video_timestamp = (actual_elapsed.as_micros() * 10) as i64;

        // Send video frame to encoder
        if let Err(e) = encoder.send_frame_buffer(&flipped_data, video_timestamp) {
            println!("[CAPTURE] Failed to send frame: {:?}", e);
        }

        // Send audio to encoder
        if let Some(ref mut manager) = audio_manager {
            while let Some(audio_frame) = manager.collector().try_get_audio() {
                let pcm_bytes = f32_to_i16_pcm(&audio_frame.samples);
                if let Err(e) = encoder.send_audio_buffer(&pcm_bytes, audio_frame.timestamp_100ns) {
                    println!("[CAPTURE] Failed to send audio: {:?}", e);
                }
            }
        }

        frame_count += 1;
        progress.increment_frame();

        if frame_count == 1 {
            println!("[CAPTURE] First frame captured using {} backend!", capture.name());
        }

        // Emit progress periodically
        if frame_count % 30 == 0 {
            emit_state_change(app, &RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: actual_elapsed.as_secs_f64(),
                frame_count,
            });
        }
    }

    // Check if we captured any frames
    if frame_count == 0 {
        println!("[CAPTURE] WARNING: No video frames were captured!");
    }

    // Stop audio capture threads
    if let Some(mut manager) = audio_manager {
        println!("[CAPTURE] Stopping audio capture...");
        manager.stop();
        println!("[CAPTURE] Audio capture stopped");
    }

    // Note: Webcam preview service continues running (shared with preview window)
    // It will be stopped when the preview window closes

    // Check if recording was cancelled - if so, skip encoding and let the file be deleted
    if progress.was_cancelled() {
        println!("[CAPTURE] Recording was cancelled, skipping encoder finish");
        // Drop the encoder without finishing to avoid saving the file
        drop(encoder);
        return Ok(());
    }

    // Finish encoding (only for Stop, not Cancel)
    println!("[CAPTURE] Finishing encoder...");
    encoder.finish().map_err(|e| format!("Failed to finish encoding: {:?}", e))?;
    println!("[CAPTURE] Encoder finished successfully");

    Ok(())
}

/// Run GIF capture using DXGI Duplication API.
fn run_gif_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
) -> Result<(), String> {
    println!("[GIF] run_gif_capture starting");

    // Get crop region if in region mode
    let crop_region = match &settings.mode {
        RecordingMode::Region { x, y, width, height } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Get monitor to capture
    let monitor = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => {
            let monitors = Monitor::enumerate()
                .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
            monitors
                .get(*monitor_index)
                .ok_or("Monitor not found")?
                .clone()
        }
        _ => Monitor::primary().map_err(|e| format!("Failed to get primary monitor: {}", e))?,
    };

    // Create DXGI duplication session
    let mut dxgi = DxgiDuplicationApi::new(monitor)
        .map_err(|e| format!("Failed to create DXGI duplication: {:?}", e))?;

    // Small delay to let DXGI stabilize (helps with GPU power-saving states)
    std::thread::sleep(Duration::from_millis(50));

    // Get capture dimensions
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else {
        (dxgi.width(), dxgi.height())
    };

    let max_duration = settings.max_duration_secs.map(|s| Duration::from_secs(s as u64));
    let max_frames = settings.fps as usize * settings.max_duration_secs.unwrap_or(30) as usize;

    // Create GIF recorder
    let recorder = Arc::new(Mutex::new(GifRecorder::new(
        width,
        height,
        settings.fps,
        settings.gif_quality_preset,
        max_frames,
    )));

    // Cursor capture manager (for include_cursor option)
    let mut cursor_capture = if settings.include_cursor {
        Some(CursorCapture::new())
    } else {
        None
    };

    // Webcam overlay is captured on-screen (the preview window is part of the screen capture)
    // No need for separate webcam compositing - the browser's getUserMedia preview is visible
    let webcam_settings = get_webcam_settings();
    let use_webcam = false; // Disabled - webcam is captured as part of screen
    let _ = webcam_settings; // Suppress unused warning

    // Recording loop
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let start_time = Instant::now();
    let mut last_frame_time = Instant::now();

    loop {
        // Check for commands
        match command_rx.try_recv() {
            Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                println!("[GIF] Received stop/cancel command");
                if matches!(command_rx.try_recv(), Ok(RecorderCommand::Cancel)) {
                    progress.mark_cancelled();
                }
                break;
            }
            _ => {}
        }

        // Check max duration
        let elapsed = start_time.elapsed();
        if let Some(max_dur) = max_duration {
            if elapsed >= max_dur {
                break;
            }
        }

        // Frame rate limiting
        if last_frame_time.elapsed() < frame_duration {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }

        // Acquire next frame
        match dxgi.acquire_next_frame(100) {
            Ok(mut frame) => {
                last_frame_time = Instant::now();

                let buffer_result = if let Some((x, y, w, h)) = crop_region {
                    let start_x = x.max(0) as u32;
                    let start_y = y.max(0) as u32;
                    frame.buffer_crop(start_x, start_y, start_x + w, start_y + h)
                } else {
                    frame.buffer()
                };

                if let Ok(buffer) = buffer_result {
                    let mut raw_data = Vec::new();
                    let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);

                    // Copy to mutable buffer for cursor compositing
                    let mut frame_data = pixel_data.to_vec();

                    // Composite cursor onto frame (in BGRA format)
                    if let Some(ref mut cursor_cap) = cursor_capture {
                        if let Ok(cursor_state) = cursor_cap.capture() {
                            if cursor_state.visible {
                                // Get capture region offset for cursor positioning
                                let (region_x, region_y) = crop_region
                                    .map(|(x, y, _, _)| (x, y))
                                    .unwrap_or((0, 0));

                                composite_cursor(
                                    &mut frame_data,
                                    width,
                                    height,
                                    &cursor_state,
                                    region_x,
                                    region_y,
                                );
                            }
                        }
                    }

                    // Composite webcam overlay onto frame
                    // Uses shared preview service frames (same source as preview window)
                    if use_webcam {
                        // Check if preview service has encountered a fatal error
                        if webcam::preview_has_error() {
                            if let Some(error_msg) = webcam::get_preview_error() {
                                // Only emit error once (use a static to track)
                                static GIF_WEBCAM_ERROR_EMITTED: std::sync::atomic::AtomicBool =
                                    std::sync::atomic::AtomicBool::new(false);
                                if !GIF_WEBCAM_ERROR_EMITTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                                    eprintln!("[WEBCAM] Fatal error detected in GIF recording: {}", error_msg);
                                    emit_webcam_error(app, &error_msg, true);
                                }
                            }
                            // Skip webcam compositing when there's an error
                        } else if let Some(webcam_frame) = webcam::get_preview_frame() {
                            composite_webcam(
                                &mut frame_data,
                                width,
                                height,
                                &webcam_frame,
                                &webcam_settings,
                            );
                        }
                    }

                    // Convert BGRA to RGBA for GIF encoder
                    let rgba_data: Vec<u8> = frame_data
                        .chunks_exact(4)
                        .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]])
                        .collect();

                    let timestamp = elapsed.as_secs_f64();
                    if let Ok(mut rec) = recorder.lock() {
                        rec.add_frame(rgba_data, width, height, timestamp);
                    }

                    progress.increment_frame();

                    let frame_count = progress.get_frame_count();
                    // Emit progress every 30 frames (~1/sec at 30fps) to reduce event overhead
                    if frame_count % 30 == 0 {
                        emit_state_change(app, &RecordingState::Recording {
                            started_at: chrono::Local::now().to_rfc3339(),
                            elapsed_secs: elapsed.as_secs_f64(),
                            frame_count,
                        });
                    }
                }
            }
            Err(windows_capture::dxgi_duplication_api::Error::Timeout) => {}
            Err(windows_capture::dxgi_duplication_api::Error::AccessLost) => {
                match dxgi.recreate() {
                    Ok(new_dxgi) => dxgi = new_dxgi,
                    Err(e) => return Err(format!("DXGI access lost: {:?}", e)),
                }
            }
            Err(e) => {
                println!("[GIF] DXGI error: {:?}", e);
            }
        }
    }

    // Note: Webcam preview service continues running (shared with preview window)
    // It will be stopped when the preview window closes

    // Check if cancelled
    if progress.was_cancelled() {
        return Err("Recording cancelled".to_string());
    }

    // Encode GIF
    emit_state_change(app, &RecordingState::Processing { progress: 0.0 });

    let recorder_guard = recorder.lock().map_err(|_| "Failed to lock recorder")?;
    let frame_count = recorder_guard.frame_count();

    if frame_count == 0 {
        return Err("No frames captured".to_string());
    }

    let app_clone = app.clone();
    recorder_guard
        .encode_to_file(output_path, move |encoding_progress| {
            emit_state_change(&app_clone, &RecordingState::Processing {
                progress: encoding_progress,
            });
        })
        .map_err(|e| format!("Failed to encode GIF: {}", e))?;

    Ok(())
}

/// Stop the current recording.
/// 
/// This sends the stop command and returns immediately.
/// The actual completion is signaled via the 'recording-state-changed' event
/// when the state becomes Completed or Error.
pub async fn stop_recording(_app: AppHandle) -> Result<(), String> {
    eprintln!("[STOP] stop_recording called");
    println!("[STOP] stop_recording called");

    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;

    if !controller.is_active() {
        return Err("No recording in progress".to_string());
    }

    println!("[STOP] Sending Stop command...");
    controller.send_command(RecorderCommand::Stop)?;
    println!("[STOP] Stop command sent successfully");

    // Return immediately - don't wait for recording to finish
    // The frontend will receive the completion via 'recording-state-changed' event
    Ok(())
}

/// Cancel the current recording.
pub async fn cancel_recording(_app: AppHandle) -> Result<(), String> {
    println!("[CANCEL] cancel_recording called");

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
