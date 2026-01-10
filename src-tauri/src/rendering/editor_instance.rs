//! Editor instance for managing playback state.
//!
//! Each video project gets its own EditorInstance that manages:
//! - Video decoders (screen + optional webcam)
//! - Playback state (playing, paused, current frame)
//! - Frame rendering pipeline
//! - Event emission to frontend

use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::compositor::Compositor;
use super::decoder::VideoDecoder;
use super::renderer::Renderer;
use super::types::{
    BackgroundStyle, EditorInstanceInfo, PlaybackEvent, PlaybackState, RenderOptions, RenderedFrame,
};
use super::zoom::ZoomInterpolator;
use crate::commands::video_recording::video_project::VideoProject;

/// Events sent from playback loop to main thread.
enum PlaybackCommand {
    Play,
    Pause,
    Stop,
    Seek(u64), // timestamp_ms
    SetSpeed(f32),
}

/// Editor instance managing a video project's playback.
pub struct EditorInstance {
    /// Unique instance ID.
    pub id: String,
    /// Video project configuration.
    project: VideoProject,
    /// Screen video decoder.
    screen_decoder: VideoDecoder,
    /// Webcam video decoder (if present).
    webcam_decoder: Option<VideoDecoder>,
    /// GPU renderer.
    renderer: Arc<Renderer>,
    /// Frame compositor.
    compositor: Compositor,
    /// Zoom interpolator.
    zoom: ZoomInterpolator,
    /// Current playback state.
    state: Arc<Mutex<PlaybackStateInner>>,
    /// Channel to send commands to playback loop.
    command_tx: Option<mpsc::Sender<PlaybackCommand>>,
    /// Playback task handle.
    playback_task: Option<tokio::task::JoinHandle<()>>,
}

struct PlaybackStateInner {
    state: PlaybackState,
    current_frame: u32,
    current_timestamp_ms: u64,
    speed: f32,
}

impl EditorInstance {
    /// Create a new editor instance for a video project.
    pub async fn new(project: VideoProject) -> Result<Self, String> {
        let id = uuid::Uuid::new_v4().to_string();

        // Initialize GPU renderer
        let renderer = Arc::new(Renderer::new().await?);

        // Create screen decoder
        let screen_path = Path::new(&project.sources.screen_video);
        log::info!("[GPU_EDITOR] Creating decoder for: {:?}", screen_path);
        let mut screen_decoder = VideoDecoder::new(screen_path)?;
        log::info!("[GPU_EDITOR] Starting decoder...");
        screen_decoder.start()?;

        // Pre-decode frame 0 so it's ready immediately
        log::info!("[GPU_EDITOR] Pre-decoding frame 0...");
        match screen_decoder.seek(0).await {
            Ok(_) => log::info!("[GPU_EDITOR] Frame 0 pre-decoded successfully"),
            Err(e) => log::warn!("[GPU_EDITOR] Failed to pre-decode frame 0: {}", e),
        }

        // Create webcam decoder if present
        let webcam_decoder = if let Some(webcam_path) = &project.sources.webcam_video {
            let path = Path::new(webcam_path);
            if path.exists() {
                let mut decoder = VideoDecoder::new(path)?;
                decoder.start()?;
                Some(decoder)
            } else {
                None
            }
        } else {
            None
        };

        // Create compositor
        let compositor = Compositor::new(&renderer);

        // Create zoom interpolator
        let zoom = ZoomInterpolator::new(&project.zoom);

        let state = Arc::new(Mutex::new(PlaybackStateInner {
            state: PlaybackState::Stopped,
            current_frame: 0,
            current_timestamp_ms: 0,
            speed: project.timeline.speed,
        }));

        Ok(Self {
            id,
            project,
            screen_decoder,
            webcam_decoder,
            renderer,
            compositor,
            zoom,
            state,
            command_tx: None,
            playback_task: None,
        })
    }

    /// Get instance info for the frontend.
    pub fn info(&self) -> EditorInstanceInfo {
        EditorInstanceInfo {
            instance_id: self.id.clone(),
            width: self.screen_decoder.width(),
            height: self.screen_decoder.height(),
            duration_ms: self.screen_decoder.duration_ms(),
            fps: self.screen_decoder.fps() as u32,
            frame_count: self.screen_decoder.frame_count(),
            has_webcam: self.webcam_decoder.is_some(),
            has_cursor: self.project.sources.cursor_data.is_some(),
        }
    }

    /// Start playback loop.
    pub fn start_playback(&mut self, app_handle: AppHandle) -> Result<(), String> {
        if self.command_tx.is_some() {
            // Already running
            return Ok(());
        }

        let (tx, rx) = mpsc::channel(32);
        self.command_tx = Some(tx.clone());

        let state = Arc::clone(&self.state);
        let fps = self.screen_decoder.fps();
        let frame_count = self.screen_decoder.frame_count();
        let duration_ms = self.screen_decoder.duration_ms();
        let instance_id = self.id.clone();

        let handle = tokio::spawn(async move {
            playback_loop(
                rx,
                state,
                fps,
                frame_count,
                duration_ms,
                instance_id,
                app_handle,
            )
            .await;
        });

        self.playback_task = Some(handle);
        Ok(())
    }

    /// Play video.
    pub async fn play(&self) -> Result<(), String> {
        if let Some(tx) = &self.command_tx {
            tx.send(PlaybackCommand::Play)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Pause video.
    pub async fn pause(&self) -> Result<(), String> {
        if let Some(tx) = &self.command_tx {
            tx.send(PlaybackCommand::Pause)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Stop playback.
    pub async fn stop(&mut self) -> Result<(), String> {
        if let Some(tx) = self.command_tx.take() {
            let _ = tx.send(PlaybackCommand::Stop).await;
        }
        if let Some(handle) = self.playback_task.take() {
            let _ = handle.await;
        }
        Ok(())
    }

    /// Seek to timestamp.
    pub async fn seek(&self, timestamp_ms: u64) -> Result<(), String> {
        if let Some(tx) = &self.command_tx {
            tx.send(PlaybackCommand::Seek(timestamp_ms))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Set playback speed.
    pub async fn set_speed(&self, speed: f32) -> Result<(), String> {
        if let Some(tx) = &self.command_tx {
            tx.send(PlaybackCommand::SetSpeed(speed))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Render a single frame at the given timestamp.
    pub async fn render_frame(&mut self, timestamp_ms: u64) -> Result<RenderedFrame, String> {
        let frame_num = self.screen_decoder.timestamp_to_frame(timestamp_ms);
        let frame = self.screen_decoder.seek(frame_num).await?;

        // Get zoom state
        let zoom_state = self.zoom.get_zoom_at(timestamp_ms);

        // Use project's background settings for WYSIWYG preview
        let background_style = BackgroundStyle::from_config(&self.project.export.background);

        // Set up render options
        let options = RenderOptions {
            output_width: self.screen_decoder.width(),
            output_height: self.screen_decoder.height(),
            zoom: zoom_state,
            webcam: None, // TODO: Add webcam overlay
            cursor: None, // TODO: Add cursor overlay
            background: background_style,
        };

        // Composite frame
        let output_texture = self
            .compositor
            .composite(&self.renderer, &frame, &options, timestamp_ms as f32)
            .await;

        // Read back to CPU
        let data = self
            .renderer
            .read_texture(&output_texture, options.output_width, options.output_height)
            .await;

        // Encode as base64
        let data_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);

        Ok(RenderedFrame {
            frame: frame_num,
            timestamp_ms,
            data_base64,
            width: options.output_width,
            height: options.output_height,
        })
    }

    /// Get current playback state.
    pub fn get_state(&self) -> PlaybackState {
        self.state.lock().state
    }

    /// Get current timestamp.
    pub fn get_current_timestamp(&self) -> u64 {
        self.state.lock().current_timestamp_ms
    }
}

/// Background playback loop.
async fn playback_loop(
    mut rx: mpsc::Receiver<PlaybackCommand>,
    state: Arc<Mutex<PlaybackStateInner>>,
    fps: f64,
    frame_count: u32,
    duration_ms: u64,
    instance_id: String,
    app_handle: AppHandle,
) {
    let frame_duration = Duration::from_secs_f64(1.0 / fps);
    let mut last_frame_time = Instant::now();
    let mut playing = false;

    loop {
        // Check for commands (non-blocking when playing)
        let timeout = if playing {
            Duration::from_millis(1)
        } else {
            Duration::from_millis(100)
        };

        match tokio::time::timeout(timeout, rx.recv()).await {
            Ok(Some(cmd)) => match cmd {
                PlaybackCommand::Play => {
                    playing = true;
                    last_frame_time = Instant::now();
                    let mut s = state.lock();
                    s.state = PlaybackState::Playing;
                },
                PlaybackCommand::Pause => {
                    playing = false;
                    let mut s = state.lock();
                    s.state = PlaybackState::Paused;
                },
                PlaybackCommand::Stop => {
                    break;
                },
                PlaybackCommand::Seek(timestamp_ms) => {
                    let mut s = state.lock();
                    s.current_timestamp_ms = timestamp_ms.min(duration_ms);
                    s.current_frame = ((timestamp_ms as f64 / 1000.0) * fps).floor() as u32;
                    s.state = PlaybackState::Seeking;

                    // Emit seek event
                    let event = PlaybackEvent {
                        frame: s.current_frame,
                        timestamp_ms: s.current_timestamp_ms,
                        state: s.state,
                    };
                    let _ = app_handle.emit(&format!("playback:{}", instance_id), event);
                },
                PlaybackCommand::SetSpeed(speed) => {
                    let mut s = state.lock();
                    s.speed = speed.clamp(0.1, 4.0);
                },
            },
            Ok(None) => {
                // Channel closed
                break;
            },
            Err(_) => {
                // Timeout - continue playback if playing
            },
        }

        // Advance playback
        if playing {
            let elapsed = last_frame_time.elapsed();
            let speed = state.lock().speed;
            let effective_frame_duration = frame_duration.div_f32(speed);

            if elapsed >= effective_frame_duration {
                last_frame_time = Instant::now();

                let mut s = state.lock();
                s.current_frame += 1;

                if s.current_frame >= frame_count {
                    // Loop or stop at end
                    s.current_frame = 0;
                    s.current_timestamp_ms = 0;
                    s.state = PlaybackState::Stopped;
                    playing = false;
                } else {
                    s.current_timestamp_ms = ((s.current_frame as f64 / fps) * 1000.0) as u64;
                }

                // Emit playback event
                let event = PlaybackEvent {
                    frame: s.current_frame,
                    timestamp_ms: s.current_timestamp_ms,
                    state: s.state,
                };
                drop(s); // Release lock before emit

                let _ = app_handle.emit(&format!("playback:{}", instance_id), event);
            }
        }
    }
}
