//! Core video recording implementation.
//!
//! Uses windows-capture's DXGI Duplication API for frame capture
//! and VideoEncoder for hardware-accelerated MP4 encoding.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ============================================================================
// Frame Buffer Pool - Reuses buffers to avoid per-frame allocations
// ============================================================================

/// Pre-allocated buffer pool for frame capture to avoid allocations in the hot loop.
///
/// The capture loop needs several buffers per frame:
/// - `frame_buffer`: Working copy for cursor/webcam compositing
/// - `flip_buffer`: Vertically flipped output for encoder
///
/// Note: DXGI's `as_nopadding_buffer` requires a fresh Vec each call, so we can't
/// pool that allocation. But we still save allocations on frame_buffer and flip_buffer.
struct FrameBufferPool {
    /// Buffer for compositing operations (cursor, webcam)
    frame_buffer: Vec<u8>,
    /// Buffer for vertical flip before encoding
    flip_buffer: Vec<u8>,
    /// Expected frame size in bytes (width * height * 4)
    frame_size: usize,
}

impl FrameBufferPool {
    /// Create a new buffer pool pre-sized for the given dimensions.
    fn new(width: u32, height: u32) -> Self {
        let frame_size = (width as usize) * (height as usize) * 4;
        Self {
            frame_buffer: vec![0u8; frame_size],
            flip_buffer: vec![0u8; frame_size],
            frame_size,
        }
    }

    /// Flip frame_buffer vertically into flip_buffer and return reference.
    fn flip_vertical(&mut self, width: u32, height: u32) -> &[u8] {
        let row_size = (width as usize) * 4;
        let total_size = row_size * (height as usize);

        // Flip from frame_buffer to flip_buffer
        for (i, row) in self.frame_buffer[..total_size].chunks_exact(row_size).enumerate() {
            let dest_row = height as usize - 1 - i;
            let dest_start = dest_row * row_size;
            self.flip_buffer[dest_start..dest_start + row_size].copy_from_slice(row);
        }

        &self.flip_buffer[..total_size]
    }
}

use crossbeam_channel::{Receiver, TryRecvError};
use tauri::{AppHandle, Emitter, Manager};
use windows_capture::{
    dxgi_duplication_api::DxgiDuplicationApi,
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType},
    monitor::Monitor,
};

use super::audio_multitrack::MultiTrackAudioRecorder;
use super::audio_sync::AudioCaptureManager;
use super::cursor::{composite_cursor, CursorCapture, CursorEventCapture, save_cursor_recording};
use super::desktop_icons::{hide_desktop_icons, show_desktop_icons};
use super::gif_encoder::GifRecorder;
use super::state::{RecorderCommand, RecordingProgress, RECORDING_CONTROLLER};
use super::webcam::stop_preview_service;
use super::wgc_capture::WgcVideoCapture;
use super::{emit_state_change, get_webcam_settings, RecordingFormat, RecordingMode, RecordingSettings, RecordingState};

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
/// Only used for modes that don't support native window capture.
fn resolve_window_to_region(mode: &RecordingMode) -> Result<RecordingMode, String> {
    match mode {
        RecordingMode::Window { window_id } => {
            let (x, y, width, height) = get_window_rect(*window_id)?;
            Ok(RecordingMode::Region { x, y, width, height })
        }
        other => Ok(other.clone()),
    }
}

/// Check if mode is Window capture (for native window recording).
fn is_window_mode(mode: &RecordingMode) -> Option<u32> {
    match mode {
        RecordingMode::Window { window_id } => Some(*window_id),
        _ => None,
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

            // NOTE: Webcam preview stays visible for user reference during recording.
            // The webcam is recorded to a separate file and composited in post-production.
            // Screen Studio style: preview is visible but final webcam position is set in editor.

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

        // NOTE: Webcam preview stays visible (Screen Studio style)
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

        // Hide desktop icons if enabled (will be restored when recording ends)
        hide_desktop_icons();

        // Catch any panics to ensure we log them
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {

        // Window mode is now handled natively by WGC in run_video_capture/run_gif_capture
        // No need to resolve to region mode anymore

        let result = match settings.format {
            RecordingFormat::Mp4 => {
                run_video_capture(&app, &settings, &output_path, progress.clone(), command_rx)
            }
            RecordingFormat::Gif => {
                run_gif_capture(&app, &settings, &output_path, progress.clone(), command_rx)
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
        
        // Always restore desktop icons when recording ends (success, error, or panic)
        show_desktop_icons();
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

    // === BROWSER-BASED WEBCAM RECORDING ===
    // Prepare webcam output path (emit will happen right before capture loop)
    let webcam_enabled = get_webcam_settings()
        .map(|s| s.enabled)
        .unwrap_or(false);
    
    let webcam_output_path = if webcam_enabled {
        // Generate webcam output path (.webm for browser MediaRecorder)
        let mut path = output_path.clone();
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        path.set_file_name(format!("{}_webcam.webm", stem));
        Some(path.to_string_lossy().to_string())
    } else {
        None
    };

    // Check if this is Window mode (native window capture via WGC)
    let window_id = is_window_mode(&settings.mode);

    // Get crop region if in region mode (not used for Window mode)
    let crop_region = match &settings.mode {
        RecordingMode::Region { x, y, width, height } => Some((*x, *y, *width, *height)),
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
                        eprintln!("[CAPTURE] Region ({}, {}) is on monitor {} at ({}, {})", x, y, idx, mx, my);
                        break;
                    }
                }
                found_idx
            } else {
                0
            }
        }
        _ => 0,
    };

    // Create capture backend based on mode
    let mut capture = if let Some(wid) = window_id {
        // Window mode: use native WGC window capture
        eprintln!("[CAPTURE] Using native WGC window capture for window {}", wid);
        let wgc = WgcVideoCapture::new_window(wid, settings.include_cursor)
            .map_err(|e| format!("Failed to create WGC window capture: {}", e))?;
        CaptureBackend::Wgc(wgc)
    } else {
        // Monitor/Region mode: use DXGI with WGC fallback
        eprintln!("[CAPTURE] Detected monitor index for WGC fallback: {}", monitor_index);

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

        // Small delay to let DXGI stabilize
        std::thread::sleep(Duration::from_millis(50));

        CaptureBackend::Dxgi(dxgi)
    };

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
    // Use H.264 codec for better browser/WebView compatibility (HEVC requires paid extension)
    let video_settings = VideoSettingsBuilder::new(width, height)
        .sub_type(VideoSettingsSubType::H264)
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

    // === WEBCAM SEPARATE RECORDING ===
    // Webcam recording is now handled by browser MediaRecorder.
    // The browser captures via getUserMedia and sends chunks to Rust for file writing.
    // See: webcam-recording-start/stop events emitted above, and webcam_recording_chunk command.
    // The old Rust-based WebcamEncoder has been removed.

    // === MULTI-TRACK AUDIO RECORDING ===
    // Record system audio and microphone to separate WAV files for later mixing.
    // This enables independent volume control in the video editor.
    // Use shared flags so pause/resume affects multi-track audio too.
    let mut multitrack_audio = MultiTrackAudioRecorder::with_flags(
        Arc::clone(&should_stop),
        Arc::clone(&is_paused),
    );
    let (system_audio_path, mic_audio_path) = {
        let stem = output_path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let parent = output_path.parent().unwrap_or(std::path::Path::new("."));
        
        let system_path = if settings.audio.capture_system_audio {
            Some(parent.join(format!("{}_system.wav", stem)))
        } else {
            None
        };
        
        let mic_path = if settings.audio.microphone_device_index.is_some() {
            Some(parent.join(format!("{}_mic.wav", stem)))
        } else {
            None
        };
        
        (system_path, mic_path)
    };
    
    // Start multi-track audio recording
    if system_audio_path.is_some() || mic_audio_path.is_some() {
        match multitrack_audio.start(system_audio_path.clone(), mic_audio_path.clone()) {
            Ok((sys, mic)) => {
                if let Some(ref p) = sys {
                    eprintln!("[CAPTURE] Multi-track system audio: {:?}", p);
                }
                if let Some(ref p) = mic {
                    eprintln!("[CAPTURE] Multi-track microphone: {:?}", p);
                }
            }
            Err(e) => {
                eprintln!("[CAPTURE] Warning: Failed to start multi-track audio: {}", e);
            }
        }
    }

    // === CURSOR EVENT CAPTURE ===
    // Record cursor positions and clicks for auto-zoom in video editor
    let mut cursor_event_capture = CursorEventCapture::new();
    let cursor_data_path = {
        let mut path = output_path.clone();
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        path.set_file_name(format!("{}_cursor.json", stem));
        path
    };
    
    // Get region for cursor capture (if region mode)
    let cursor_region = match &settings.mode {
        RecordingMode::Region { x, y, width, height } => Some((*x, *y, *width, *height)),
        _ => None,
    };
    
    if let Err(e) = cursor_event_capture.start(cursor_region) {
        eprintln!("[CAPTURE] Warning: Failed to start cursor event capture: {}", e);
    } else {
        eprintln!("[CAPTURE] Cursor event capture started, will save to: {:?}", cursor_data_path);
    }

    // Pre-allocate frame buffers to avoid per-frame allocations
    let mut buffer_pool = FrameBufferPool::new(width, height);

    // Recording loop
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let mut last_frame_time = Instant::now();
    let mut frame_count: u64 = 0;
    let mut paused = false;
    let mut pause_time = Duration::ZERO;
    let mut pause_start: Option<Instant> = None;

    // === START WEBCAM RECORDING (synced with capture loop) ===
    if let Some(ref path_str) = webcam_output_path {
        if let Err(e) = app.emit("webcam-recording-start", serde_json::json!({ "outputPath": path_str })) {
            eprintln!("[CAPTURE] Failed to emit webcam-recording-start: {}", e);
        } else {
            eprintln!("[CAPTURE] Emitted webcam-recording-start, path: {}", path_str);
        }
    }

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

        // Skip frame capture while paused - use blocking receive instead of polling
        if paused {
            // Block waiting for commands instead of busy-wait polling
            // This uses near-zero CPU while paused and responds instantly to commands
            match command_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(RecorderCommand::Resume) => {
                    eprintln!("[CAPTURE] Received Resume command while paused");
                    if let Some(ps) = pause_start.take() {
                        pause_time += ps.elapsed();
                    }
                    paused = false;
                    progress.set_paused(false);
                    is_paused.store(false, Ordering::SeqCst);
                }
                Ok(RecorderCommand::Stop) => {
                    eprintln!("[CAPTURE] Received Stop command while paused");
                    should_stop.store(true, Ordering::SeqCst);
                    break;
                }
                Ok(RecorderCommand::Cancel) => {
                    eprintln!("[CAPTURE] Received Cancel command while paused");
                    should_stop.store(true, Ordering::SeqCst);
                    progress.mark_cancelled();
                    break;
                }
                Ok(RecorderCommand::Pause) => {} // Already paused, ignore
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {} // Normal timeout, continue loop
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    eprintln!("[CAPTURE] Channel disconnected while paused");
                    should_stop.store(true, Ordering::SeqCst);
                    break;
                }
            }
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
                                    false
                                }
                            }
                        }
                    }
                    Err(windows_capture::dxgi_duplication_api::Error::Timeout) => false,
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
                            false
                        }
                    }
                }
            }
            CaptureBackend::Wgc(wgc) => {
                // WGC frame acquisition - copy into pooled buffer
                match wgc.get_frame(100) {
                    Some(frame) => {
                        let len = frame.data.len().min(buffer_pool.frame_size);
                        buffer_pool.frame_buffer[..len].copy_from_slice(&frame.data[..len]);
                        true
                    }
                    None => false, // Timeout or no frame
                }
            }
        };

        // Skip if no frame was acquired
        if !frame_acquired {
            continue;
        }

        last_frame_time = Instant::now();

        // Get mutable reference to frame buffer for compositing
        let frame_data = &mut buffer_pool.frame_buffer;

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
                            frame_data,
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

        // NOTE: Webcam is now recorded to a separate file (not composited onto screen)
        // This allows toggling webcam visibility in the video editor

        // Flip vertically using pooled buffer (both DXGI and WGC return top-down, encoder expects bottom-up)
        let flipped_data = buffer_pool.flip_vertical(width, height);

        // Get video timestamp
        let video_timestamp = (actual_elapsed.as_micros() * 10) as i64;

        // Send video frame to encoder
        if let Err(e) = encoder.send_frame_buffer(flipped_data, video_timestamp) {
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

        // Webcam recording is now handled by browser MediaRecorder (no Rust processing)

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

    // === STOP BROWSER-BASED WEBCAM RECORDING ===
    // Emit event to frontend to stop MediaRecorder
    if webcam_output_path.is_some() {
        if let Err(e) = app.emit("webcam-recording-stop", ()) {
            eprintln!("[CAPTURE] Failed to emit webcam-recording-stop: {}", e);
        } else {
            eprintln!("[CAPTURE] Emitted webcam-recording-stop");
        }
    }

    // Stop audio capture threads
    if let Some(mut manager) = audio_manager {
        println!("[CAPTURE] Stopping audio capture...");
        manager.stop();
        println!("[CAPTURE] Audio capture stopped");
    }

    // Stop multi-track audio recording
    if let Err(e) = multitrack_audio.stop() {
        eprintln!("[CAPTURE] Warning: Failed to stop multi-track audio: {}", e);
    } else {
        eprintln!("[CAPTURE] Multi-track audio recording stopped");
    }

    // Stop webcam preview service to release hardware
    // This frees the camera for other applications after recording
    stop_preview_service();
    eprintln!("[CAPTURE] Webcam preview service stopped");

    // === STOP CURSOR EVENT CAPTURE ===
    let cursor_recording = cursor_event_capture.stop();
    eprintln!("[CAPTURE] Cursor event capture stopped, collected {} events", cursor_recording.events.len());

    // Check if recording was cancelled - if so, skip encoding and let the file be deleted
    if progress.was_cancelled() {
        println!("[CAPTURE] Recording was cancelled, skipping encoder finish");
        // Drop the encoder without finishing to avoid saving the file
        drop(encoder);
        // Delete browser-based webcam recording file if it exists
        if let Some(ref path) = webcam_output_path {
            if let Err(e) = std::fs::remove_file(path) {
                eprintln!("[CAPTURE] Failed to delete cancelled webcam file: {}", e);
            } else {
                eprintln!("[CAPTURE] Deleted cancelled webcam file: {}", path);
            }
        }
        return Ok(());
    }

    // Webcam recording finish is handled by browser MediaRecorder (webcam_recording_stop command)

    // === SAVE CURSOR DATA ===
    if !cursor_recording.events.is_empty() {
        eprintln!("[CAPTURE] Saving cursor data to {:?}...", cursor_data_path);
        if let Err(e) = save_cursor_recording(&cursor_recording, &cursor_data_path) {
            eprintln!("[CAPTURE] Warning: Failed to save cursor data: {}", e);
            // Don't fail the whole recording for cursor data issues
        } else {
            eprintln!("[CAPTURE] Cursor data saved ({} events)", cursor_recording.events.len());
        }
    }

    // Finish encoding (only for Stop, not Cancel)
    println!("[CAPTURE] Finishing encoder...");
    encoder.finish().map_err(|e| format!("Failed to finish encoding: {:?}", e))?;
    println!("[CAPTURE] Encoder finished successfully");

    Ok(())
}

/// Run GIF capture using WGC (Windows Graphics Capture).
/// Fast async capture at 30+ FPS for smooth GIFs.
fn run_gif_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
) -> Result<(), String> {
    println!("[GIF] run_gif_capture starting with WGC");

    // Check if this is Window mode (native window capture via WGC)
    let window_id = is_window_mode(&settings.mode);

    // Get crop region if in region mode (not used for Window mode)
    let crop_region = match &settings.mode {
        RecordingMode::Region { x, y, width, height } => Some((*x, *y, *width, *height)),
        _ => None,
    };

    // Start WGC capture based on mode
    let wgc = if let Some(wid) = window_id {
        // Window mode: use native WGC window capture
        eprintln!("[GIF] Using native WGC window capture for window {}", wid);
        WgcVideoCapture::new_window(wid, settings.include_cursor)
            .map_err(|e| format!("Failed to start WGC window capture: {}", e))?
    } else {
        // Monitor/Region mode: use monitor capture
        let monitor_index = match &settings.mode {
            RecordingMode::Monitor { monitor_index } => *monitor_index,
            _ => 0,
        };
        WgcVideoCapture::new(monitor_index, settings.include_cursor)
            .map_err(|e| format!("Failed to start WGC capture: {}", e))?
    };

    // Get capture dimensions
    let (capture_width, capture_height) = (wgc.width(), wgc.height());
    let (width, height) = if let Some((_, _, w, h)) = crop_region {
        (w, h)
    } else {
        (capture_width, capture_height)
    };

    eprintln!("[GIF] WGC capture started: {}x{} (output: {}x{})",
        capture_width, capture_height, width, height);

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

    // Recording loop - consume frames from WGC as they arrive
    let frame_duration = Duration::from_secs_f64(1.0 / settings.fps as f64);
    let frame_timeout_ms = (frame_duration.as_millis() as u64).max(50);
    let start_time = Instant::now();
    let mut last_frame_time = start_time;

    eprintln!("[GIF] Starting WGC capture at {} FPS (frame_timeout={}ms)", settings.fps, frame_timeout_ms);

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

        // Wait until it's time for the next frame
        let now = Instant::now();
        let time_since_last = now.duration_since(last_frame_time);
        if time_since_last < frame_duration {
            let sleep_time = frame_duration - time_since_last;
            std::thread::sleep(sleep_time);
        }

        // Drain channel to get the most recent frame (skip stale frames)
        let mut frame = match wgc.get_frame(frame_timeout_ms) {
            Some(f) => f,
            None => continue,
        };

        // Keep draining to get the freshest frame
        while let Some(newer_frame) = wgc.try_get_frame() {
            frame = newer_frame;
        }

        last_frame_time = Instant::now();

        // WGC returns BGRA - keep it as BGRA, FFmpeg will handle it
        let bgra_data = frame.data;

        // Crop if needed
        let final_data = if let Some((x, y, w, h)) = crop_region {
            let x = x.max(0) as u32;
            let y = y.max(0) as u32;
            let mut cropped = Vec::with_capacity((w * h * 4) as usize);

            for row in y..(y + h).min(frame.height) {
                let start = ((row * frame.width + x) * 4) as usize;
                let end = ((row * frame.width + x + w.min(frame.width - x)) * 4) as usize;
                if start < bgra_data.len() && end <= bgra_data.len() {
                    cropped.extend_from_slice(&bgra_data[start..end]);
                }
            }
            cropped
        } else {
            bgra_data
        };

        // Add frame with actual elapsed timestamp
        let timestamp = elapsed.as_secs_f64();
        if let Ok(mut rec) = recorder.lock() {
            rec.add_frame(final_data, width, height, timestamp);
        }

        progress.increment_frame();

        let frame_count = progress.get_frame_count();
        if frame_count % 30 == 0 {
            emit_state_change(app, &RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: elapsed.as_secs_f64(),
                frame_count,
            });
        }
    }

    // Stop WGC capture
    wgc.stop();

    // Check if cancelled
    if progress.was_cancelled() {
        return Err("Recording cancelled".to_string());
    }

    // Encode GIF
    emit_state_change(app, &RecordingState::Processing { progress: 0.0 });

    let total_duration = start_time.elapsed();
    let recorder_guard = recorder.lock().map_err(|_| "Failed to lock recorder")?;
    let frame_count = recorder_guard.frame_count();
    let expected_frames = (total_duration.as_secs_f64() * settings.fps as f64) as usize;

    eprintln!("[GIF] Capture complete: {} frames in {:.2}s (expected ~{} at {} FPS)",
        frame_count, total_duration.as_secs_f64(), expected_frames, settings.fps);

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
