//! Core video recording implementation.
//!
//! Uses windows-capture's VideoEncoder for hardware-accelerated MP4 encoding.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, TryRecvError};
use tauri::{AppHandle, Emitter};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor as WgcMonitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window as WgcWindow,
};

use super::gif_encoder::GifRecorder;
use super::state::{RecorderCommand, RecordingProgress, RECORDING_CONTROLLER};
use super::{emit_state_change, RecordingFormat, RecordingMode, RecordingSettings, RecordingState, StopRecordingResult};

/// Video recording handler that implements GraphicsCaptureApiHandler.
struct VideoRecordingHandler {
    /// Video encoder for MP4 output.
    encoder: Option<VideoEncoder>,
    /// Start time of the recording.
    start_time: Instant,
    /// Shared progress tracker.
    progress: Arc<RecordingProgress>,
    /// Target FPS for frame rate limiting.
    target_fps: u32,
    /// Time of last captured frame.
    last_frame_time: Instant,
    /// Maximum recording duration.
    max_duration: Option<Duration>,
    /// Command receiver for stop/pause signals.
    command_rx: Receiver<RecorderCommand>,
    /// App handle for emitting events.
    app_handle: AppHandle,
    /// Accumulated pause time.
    pause_time: Duration,
    /// When pause started (if paused).
    pause_start: Option<Instant>,
}

impl GraphicsCaptureApiHandler for VideoRecordingHandler {
    type Flags = VideoRecorderFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        
        // Create video encoder
        let video_settings = VideoSettingsBuilder::new(flags.width, flags.height)
            .bitrate(flags.bitrate)
            .frame_rate(flags.fps);
        
        let audio_settings = if flags.capture_audio {
            AudioSettingsBuilder::default()
        } else {
            AudioSettingsBuilder::default().disabled(true)
        };
        
        let container_settings = ContainerSettingsBuilder::default();
        
        let encoder = VideoEncoder::new(
            video_settings,
            audio_settings,
            container_settings,
            &flags.output_path,
        )?;
        
        Ok(Self {
            encoder: Some(encoder),
            start_time: Instant::now(),
            progress: flags.progress,
            target_fps: flags.fps,
            last_frame_time: Instant::now(),
            max_duration: flags.max_duration,
            command_rx: flags.command_rx,
            app_handle: flags.app_handle,
            pause_time: Duration::ZERO,
            pause_start: None,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Check for commands
        match self.command_rx.try_recv() {
            Ok(RecorderCommand::Stop) => {
                self.progress.request_stop();
            }
            Ok(RecorderCommand::Cancel) => {
                self.progress.mark_cancelled();
            }
            Ok(RecorderCommand::Pause) => {
                if self.pause_start.is_none() {
                    self.pause_start = Some(Instant::now());
                    self.progress.set_paused(true);
                }
            }
            Ok(RecorderCommand::Resume) => {
                if let Some(pause_start) = self.pause_start.take() {
                    self.pause_time += pause_start.elapsed();
                    self.progress.set_paused(false);
                }
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.progress.request_stop();
            }
        }
        
        // Check if we should stop
        if self.progress.should_stop() {
            self.finish_recording(capture_control)?;
            return Ok(());
        }
        
        // Skip frames while paused
        if self.progress.is_paused() {
            return Ok(());
        }
        
        // Calculate actual elapsed time (excluding pauses)
        let total_elapsed = self.start_time.elapsed();
        let actual_elapsed = total_elapsed - self.pause_time;
        
        // Check max duration
        if let Some(max_duration) = self.max_duration {
            if actual_elapsed >= max_duration {
                self.progress.request_stop();
                self.finish_recording(capture_control)?;
                return Ok(());
            }
        }
        
        // Frame rate limiting
        let frame_duration = Duration::from_secs_f64(1.0 / self.target_fps as f64);
        let since_last_frame = self.last_frame_time.elapsed();
        
        if since_last_frame < frame_duration {
            return Ok(());
        }
        
        self.last_frame_time = Instant::now();
        
        // Send frame to encoder
        if let Some(ref mut encoder) = self.encoder {
            encoder.send_frame(frame)?;
        }
        
        // Update progress
        self.progress.increment_frame();
        
        // Emit progress event periodically (every 10 frames)
        let frame_count = self.progress.get_frame_count();
        if frame_count % 10 == 0 {
            let state = RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: actual_elapsed.as_secs_f64(),
                frame_count,
            };
            emit_state_change(&self.app_handle, &state);
        }
        
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // Window was closed, stop recording
        self.progress.request_stop();
        Ok(())
    }
}

impl VideoRecordingHandler {
    fn finish_recording(&mut self, capture_control: InternalCaptureControl) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Finish encoding
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        
        // Stop capture
        capture_control.stop();
        
        Ok(())
    }
}

/// Flags passed to the video recording handler.
pub struct VideoRecorderFlags {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub capture_audio: bool,
    pub max_duration: Option<Duration>,
    pub output_path: PathBuf,
    pub progress: Arc<RecordingProgress>,
    pub command_rx: Receiver<RecorderCommand>,
    pub app_handle: AppHandle,
}

/// GIF recording handler that buffers frames for later encoding.
struct GifRecordingHandler {
    /// GIF recorder that buffers frames.
    recorder: GifRecorder,
    /// Start time of the recording.
    start_time: Instant,
    /// Shared progress tracker.
    progress: Arc<RecordingProgress>,
    /// Target FPS.
    target_fps: u32,
    /// Time of last captured frame.
    last_frame_time: Instant,
    /// Maximum recording duration.
    max_duration: Option<Duration>,
    /// Command receiver.
    command_rx: Receiver<RecorderCommand>,
    /// App handle.
    app_handle: AppHandle,
}

impl GraphicsCaptureApiHandler for GifRecordingHandler {
    type Flags = GifRecorderFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        
        let recorder = GifRecorder::new(
            flags.width,
            flags.height,
            flags.fps,
            flags.quality,
            flags.max_frames,
        );
        
        Ok(Self {
            recorder,
            start_time: Instant::now(),
            progress: flags.progress,
            target_fps: flags.fps,
            last_frame_time: Instant::now(),
            max_duration: flags.max_duration,
            command_rx: flags.command_rx,
            app_handle: flags.app_handle,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Check for commands
        match self.command_rx.try_recv() {
            Ok(RecorderCommand::Stop) | Ok(RecorderCommand::Cancel) => {
                self.progress.request_stop();
            }
            _ => {}
        }
        
        // Check if we should stop
        if self.progress.should_stop() {
            capture_control.stop();
            return Ok(());
        }
        
        // Check max duration
        let elapsed = self.start_time.elapsed();
        if let Some(max_duration) = self.max_duration {
            if elapsed >= max_duration {
                self.progress.request_stop();
                capture_control.stop();
                return Ok(());
            }
        }
        
        // Frame rate limiting
        let frame_duration = Duration::from_secs_f64(1.0 / self.target_fps as f64);
        if self.last_frame_time.elapsed() < frame_duration {
            return Ok(());
        }
        self.last_frame_time = Instant::now();
        
        // Get frame buffer
        let mut buffer = frame.buffer()?;
        let width = buffer.width();
        let height = buffer.height();
        let rgba_data = buffer.as_nopadding_buffer()?.to_vec();
        
        // Add frame to buffer
        let timestamp = elapsed.as_secs_f64();
        self.recorder.add_frame(rgba_data, width, height, timestamp);
        
        // Update progress
        self.progress.increment_frame();
        
        // Emit progress event periodically
        let frame_count = self.progress.get_frame_count();
        if frame_count % 10 == 0 {
            let state = RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: elapsed.as_secs_f64(),
                frame_count,
            };
            emit_state_change(&self.app_handle, &state);
        }
        
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.progress.request_stop();
        Ok(())
    }
}

/// Flags for GIF recording handler.
pub struct GifRecorderFlags {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub quality: u32,
    pub max_frames: usize,
    pub max_duration: Option<Duration>,
    pub progress: Arc<RecordingProgress>,
    pub command_rx: Receiver<RecorderCommand>,
    pub app_handle: AppHandle,
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
    let (progress, command_rx) = {
        let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
        controller.start(settings.clone(), output_path.clone())?
    };
    
    // Handle countdown
    if settings.countdown_secs > 0 {
        let app_clone = app.clone();
        let settings_clone = settings.clone();
        let output_path_clone = output_path.clone();
        let progress_clone = Arc::clone(&progress);
        let command_rx_clone = command_rx.clone();
        
        tokio::spawn(async move {
            for i in (1..=settings_clone.countdown_secs).rev() {
                // Check for cancellation
                if progress_clone.should_stop() {
                    return;
                }
                
                // Update countdown state
                {
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.update_countdown(i);
                    }
                }
                
                emit_state_change(&app_clone, &RecordingState::Countdown {
                    seconds_remaining: i,
                });
                
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            
            // Start actual recording
            {
                if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                    controller.start_actual_recording();
                }
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
    let app_clone = app.clone();
    let output_path_clone = output_path.clone();
    
    std::thread::spawn(move || {
        let result = match settings.format {
            RecordingFormat::Mp4 => {
                run_video_capture(&app, &settings, &output_path, progress, command_rx)
            }
            RecordingFormat::Gif => {
                run_gif_capture(&app, &settings, &output_path, progress, command_rx)
            }
        };
        
        // Handle result
        match result {
            Ok(()) => {
                // Get file size
                let file_size = std::fs::metadata(&output_path_clone)
                    .map(|m| m.len())
                    .unwrap_or(0);
                
                // Calculate duration
                let duration = {
                    RECORDING_CONTROLLER
                        .lock()
                        .map(|c| c.get_elapsed_secs())
                        .unwrap_or(0.0)
                };
                
                // Update state
                {
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.complete(
                            output_path_clone.to_string_lossy().to_string(),
                            duration,
                            file_size,
                        );
                    }
                }
                
                emit_state_change(&app_clone, &RecordingState::Completed {
                    output_path: output_path_clone.to_string_lossy().to_string(),
                    duration_secs: duration,
                    file_size_bytes: file_size,
                });
            }
            Err(e) => {
                // Check if cancelled
                let was_cancelled = RECORDING_CONTROLLER
                    .lock()
                    .map(|c| {
                        c.active.as_ref().map(|a| a.progress.was_cancelled()).unwrap_or(false)
                    })
                    .unwrap_or(false);
                
                if was_cancelled {
                    // Clean up file
                    let _ = std::fs::remove_file(&output_path_clone);
                    
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.reset();
                    }
                    emit_state_change(&app_clone, &RecordingState::Idle);
                } else {
                    if let Ok(mut controller) = RECORDING_CONTROLLER.lock() {
                        controller.set_error(e.clone());
                    }
                    emit_state_change(&app_clone, &RecordingState::Error { message: e });
                }
            }
        }
    });
}

/// Run video (MP4) capture.
fn run_video_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
) -> Result<(), String> {
    // Get capture dimensions based on mode
    let (width, height, capture_settings) = create_capture_settings(settings)?;
    
    let bitrate = settings.calculate_bitrate(width, height);
    let max_duration = settings.max_duration_secs.map(|s| Duration::from_secs(s as u64));
    
    let flags = VideoRecorderFlags {
        width,
        height,
        fps: settings.fps,
        bitrate,
        capture_audio: settings.audio.capture_system_audio || settings.audio.capture_microphone,
        max_duration,
        output_path: output_path.clone(),
        progress,
        command_rx,
        app_handle: app.clone(),
    };
    
    // Start capture with the appropriate settings
    match &settings.mode {
        RecordingMode::Monitor { monitor_index } => {
            let monitors = WgcMonitor::enumerate()
                .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
            
            let monitor = monitors
                .get(*monitor_index)
                .ok_or("Monitor not found")?
                .clone();
            
            let settings = Settings::new(
                monitor,
                if settings.include_cursor {
                    CursorCaptureSettings::WithCursor
                } else {
                    CursorCaptureSettings::WithoutCursor
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            
            VideoRecordingHandler::start(settings)
                .map_err(|e| format!("Failed to start recording: {}", e))
        }
        RecordingMode::Window { window_id } => {
            let window = WgcWindow::from_raw_hwnd(*window_id as isize as *mut std::ffi::c_void);
            
            if !window.is_valid() {
                return Err("Window not found or invalid".to_string());
            }
            
            let settings = Settings::new(
                window,
                if settings.include_cursor {
                    CursorCaptureSettings::WithCursor
                } else {
                    CursorCaptureSettings::WithoutCursor
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            
            VideoRecordingHandler::start(settings)
                .map_err(|e| format!("Failed to start recording: {}", e))
        }
        RecordingMode::AllMonitors => {
            // For all monitors, capture primary and we'll handle stitching separately
            // TODO: Implement multi-monitor stitching
            let monitor = WgcMonitor::primary()
                .map_err(|e| format!("Failed to get primary monitor: {}", e))?;
            
            let settings = Settings::new(
                monitor,
                if settings.include_cursor {
                    CursorCaptureSettings::WithCursor
                } else {
                    CursorCaptureSettings::WithoutCursor
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            
            VideoRecordingHandler::start(settings)
                .map_err(|e| format!("Failed to start recording: {}", e))
        }
        RecordingMode::Region { .. } => {
            // For region capture, we capture the primary monitor and crop
            // The VideoEncoder handles the cropping based on the dimensions we provide
            let monitor = WgcMonitor::primary()
                .map_err(|e| format!("Failed to get primary monitor: {}", e))?;
            
            let settings = Settings::new(
                monitor,
                if settings.include_cursor {
                    CursorCaptureSettings::WithCursor
                } else {
                    CursorCaptureSettings::WithoutCursor
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            
            VideoRecordingHandler::start(settings)
                .map_err(|e| format!("Failed to start recording: {}", e))
        }
    }
}

/// Run GIF capture.
fn run_gif_capture(
    app: &AppHandle,
    settings: &RecordingSettings,
    output_path: &PathBuf,
    progress: Arc<RecordingProgress>,
    command_rx: Receiver<RecorderCommand>,
) -> Result<(), String> {
    let (width, height, _) = create_capture_settings(settings)?;
    
    let max_duration = settings.max_duration_secs.map(|s| Duration::from_secs(s as u64));
    let max_frames = settings.fps as usize * settings.max_duration_secs.unwrap_or(30) as usize;
    
    let flags = GifRecorderFlags {
        width,
        height,
        fps: settings.fps,
        quality: settings.quality,
        max_frames,
        max_duration,
        progress: Arc::clone(&progress),
        command_rx,
        app_handle: app.clone(),
    };
    
    // Capture frames
    let recorder = match &settings.mode {
        RecordingMode::Monitor { monitor_index } => {
            let monitors = WgcMonitor::enumerate()
                .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
            
            let monitor = monitors
                .get(*monitor_index)
                .ok_or("Monitor not found")?
                .clone();
            
            let capture_settings = Settings::new(
                monitor,
                if settings.include_cursor {
                    CursorCaptureSettings::WithCursor
                } else {
                    CursorCaptureSettings::WithoutCursor
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            
            GifRecordingHandler::start(capture_settings)
                .map_err(|e| format!("Failed to start GIF recording: {}", e))
        }
        _ => {
            // Default to primary monitor for now
            let monitor = WgcMonitor::primary()
                .map_err(|e| format!("Failed to get primary monitor: {}", e))?;
            
            let capture_settings = Settings::new(
                monitor,
                if settings.include_cursor {
                    CursorCaptureSettings::WithCursor
                } else {
                    CursorCaptureSettings::WithoutCursor
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            
            GifRecordingHandler::start(capture_settings)
                .map_err(|e| format!("Failed to start GIF recording: {}", e))
        }
    };
    
    // Note: GIF encoding happens in gif_encoder after capture completes
    // The GifRecordingHandler stores frames and encodes on completion
    
    Ok(())
}

/// Create capture settings and get dimensions.
fn create_capture_settings(settings: &RecordingSettings) -> Result<(u32, u32, ()), String> {
    match &settings.mode {
        RecordingMode::Region { width, height, .. } => {
            Ok((*width, *height, ()))
        }
        RecordingMode::Window { window_id } => {
            // Get window dimensions
            let window = WgcWindow::from_raw_hwnd(*window_id as isize as *mut std::ffi::c_void);
            if !window.is_valid() {
                return Err("Window not found".to_string());
            }
            // Default to 1920x1080 if we can't get dimensions
            // The encoder will handle the actual dimensions from the frames
            Ok((1920, 1080, ()))
        }
        RecordingMode::Monitor { monitor_index } => {
            let monitors = WgcMonitor::enumerate()
                .map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
            
            let monitor = monitors
                .get(*monitor_index)
                .ok_or("Monitor not found")?;
            
            Ok((monitor.width().unwrap_or(1920), monitor.height().unwrap_or(1080), ()))
        }
        RecordingMode::AllMonitors => {
            // TODO: Calculate combined dimensions
            Ok((1920, 1080, ()))
        }
    }
}

/// Stop the current recording.
pub async fn stop_recording(app: AppHandle) -> Result<StopRecordingResult, String> {
    let (output_path, format) = {
        let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
        
        if !controller.is_active() {
            return Err("No recording in progress".to_string());
        }
        
        let output_path = controller
            .active
            .as_ref()
            .map(|a| a.output_path.clone())
            .ok_or("No active recording")?;
        
        let format = controller
            .settings
            .as_ref()
            .map(|s| s.format)
            .unwrap_or(RecordingFormat::Mp4);
        
        controller.send_command(RecorderCommand::Stop)?;
        
        (output_path, format)
    };
    
    // Wait for recording to finish (with timeout)
    let start = Instant::now();
    let timeout = Duration::from_secs(30);
    
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        
        let state = {
            RECORDING_CONTROLLER
                .lock()
                .map(|c| c.state.clone())
                .unwrap_or(RecordingState::Idle)
        };
        
        match state {
            RecordingState::Completed {
                output_path,
                duration_secs,
                file_size_bytes,
            } => {
                return Ok(StopRecordingResult {
                    output_path,
                    duration_secs,
                    file_size_bytes,
                    format,
                });
            }
            RecordingState::Error { message } => {
                return Err(message);
            }
            RecordingState::Idle => {
                return Err("Recording was cancelled".to_string());
            }
            _ => {
                if start.elapsed() > timeout {
                    return Err("Timeout waiting for recording to finish".to_string());
                }
            }
        }
    }
}

/// Cancel the current recording.
pub async fn cancel_recording(app: AppHandle) -> Result<(), String> {
    let controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
    
    if !controller.is_active() {
        return Err("No recording in progress".to_string());
    }
    
    controller.send_command(RecorderCommand::Cancel)?;
    
    emit_state_change(&app, &RecordingState::Idle);
    
    Ok(())
}

/// Pause the current recording.
pub async fn pause_recording(app: AppHandle) -> Result<(), String> {
    let mut controller = RECORDING_CONTROLLER.lock().map_err(|e| e.to_string())?;
    
    if !matches!(controller.state, RecordingState::Recording { .. }) {
        return Err("No active recording to pause".to_string());
    }
    
    // Check if format supports pausing
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
