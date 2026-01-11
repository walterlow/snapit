//! Preview rendering module.
//!
//! Provides GPU-rendered preview frames streamed via WebSocket.
//! This ensures the preview exactly matches the exported video.

mod frame_ws;

pub use frame_ws::{create_frame_ws, ShutdownSignal, WSFrame};

use crate::commands::video_recording::video_project::{VideoProject, XY};
use crate::rendering::compositor::Compositor;
use crate::rendering::renderer::Renderer;
use crate::rendering::text::prepare_texts;
use crate::rendering::types::{
    BackgroundStyle, BackgroundType, BorderStyle, CornerStyle, DecodedFrame, RenderOptions,
    ShadowStyle, ZoomState,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{watch, Mutex};

/// Preview renderer state.
pub struct PreviewRenderer {
    /// GPU renderer (shared with EditorInstance and Export).
    renderer: Arc<Renderer>,
    /// Frame compositor.
    compositor: Mutex<Compositor>,
    /// Frame sender for WebSocket.
    frame_tx: watch::Sender<Option<WSFrame>>,
    /// Current project configuration.
    project: Mutex<Option<VideoProject>>,
    /// Video decoder for frames.
    decoder: Mutex<Option<VideoDecoder>>,
    /// Current frame number.
    frame_number: Mutex<u32>,
}

/// Simple video decoder wrapper.
struct VideoDecoder {
    path: PathBuf,
    width: u32,
    height: u32,
    duration_ms: u64,
    fps: f64,
}

impl PreviewRenderer {
    /// Create a new preview renderer.
    ///
    /// `renderer` is the shared GPU renderer from RendererState.
    pub fn new(renderer: Arc<Renderer>, frame_tx: watch::Sender<Option<WSFrame>>) -> Self {
        let compositor = Compositor::new(&renderer);

        Self {
            renderer,
            compositor: Mutex::new(compositor),
            frame_tx,
            project: Mutex::new(None),
            decoder: Mutex::new(None),
            frame_number: Mutex::new(0),
        }
    }

    /// Set the project for rendering.
    pub async fn set_project(&self, project: VideoProject) -> Result<(), String> {
        // Initialize decoder with video path
        let video_path = PathBuf::from(&project.sources.screen_video);
        if !video_path.exists() {
            return Err(format!("Video file not found: {:?}", video_path));
        }

        let decoder = VideoDecoder {
            path: video_path,
            width: project.sources.original_width,
            height: project.sources.original_height,
            duration_ms: project.timeline.duration_ms,
            fps: 30.0, // Default, could be read from video metadata
        };

        *self.decoder.lock().await = Some(decoder);
        *self.project.lock().await = Some(project);
        Ok(())
    }

    /// Render a single frame at the given time.
    pub async fn render_frame(&self, time_ms: u64) -> Result<(), String> {
        let project = self.project.lock().await;
        let project = project
            .as_ref()
            .ok_or_else(|| "No project set".to_string())?;

        let decoder = self.decoder.lock().await;
        let decoder = decoder
            .as_ref()
            .ok_or_else(|| "No decoder initialized".to_string())?;

        // Decode video frame at time_ms
        let frame = self
            .decode_frame(&decoder.path, time_ms, decoder.width, decoder.height)
            .await?;

        // Build render options from project
        let render_options = self.build_render_options(project);

        // Prepare text overlays
        let output_size = XY::new(render_options.output_width, render_options.output_height);
        let frame_time_secs = time_ms as f64 / 1000.0;
        let prepared_texts = prepare_texts(output_size, frame_time_secs, &project.text.segments);

        // Render frame with compositor
        let mut compositor = self.compositor.lock().await;
        let output_texture = compositor
            .composite_with_text(
                &self.renderer,
                &frame,
                &render_options,
                time_ms as f32,
                &prepared_texts,
            )
            .await;

        // Read rendered frame back to CPU
        let rgba_data = self
            .renderer
            .read_texture(
                &output_texture,
                render_options.output_width,
                render_options.output_height,
            )
            .await;

        // Update frame number
        let mut frame_num = self.frame_number.lock().await;
        *frame_num += 1;

        // Send frame to WebSocket
        let ws_frame = WSFrame {
            data: rgba_data,
            width: render_options.output_width,
            height: render_options.output_height,
            stride: render_options.output_width * 4,
            frame_number: *frame_num,
            target_time_ns: time_ms * 1_000_000,
            created_at: Instant::now(),
        };

        self.frame_tx.send(Some(ws_frame)).ok();

        Ok(())
    }

    /// Decode a video frame using ffmpeg.
    async fn decode_frame(
        &self,
        video_path: &PathBuf,
        time_ms: u64,
        width: u32,
        height: u32,
    ) -> Result<DecodedFrame, String> {
        use std::process::Command;

        let time_secs = time_ms as f64 / 1000.0;

        // Use ffmpeg to extract frame
        let output = Command::new("ffmpeg")
            .args([
                "-ss",
                &format!("{:.3}", time_secs),
                "-i",
                video_path.to_str().unwrap_or(""),
                "-vframes",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-",
            ])
            .output()
            .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "ffmpeg failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let expected_size = (width * height * 4) as usize;
        if output.stdout.len() != expected_size {
            return Err(format!(
                "Unexpected frame size: {} != {}",
                output.stdout.len(),
                expected_size
            ));
        }

        Ok(DecodedFrame {
            frame_number: (time_ms / 33) as u32, // Approximate frame number at ~30fps
            timestamp_ms: time_ms,
            data: output.stdout,
            width,
            height,
        })
    }

    /// Build render options from project configuration.
    /// For preview, we render at video dimensions (no padding) - CSS handles frame styling.
    fn build_render_options(&self, project: &VideoProject) -> RenderOptions {
        // Preview renders at video dimensions (CSS handles padding/background)
        // Export pipeline will include padding, backgrounds, rounding, etc.
        let output_width = project.sources.original_width;
        let output_height = project.sources.original_height;

        // For preview: minimal styling - just render video content with text overlays
        // CSS in frontend handles padding, background, rounding, shadow, border
        let background = BackgroundStyle {
            background_type: BackgroundType::None,
            blur: 0.0,
            padding: 0.0,
            inset: 0,
            rounding: 0.0,
            rounding_type: CornerStyle::Rounded,
            shadow: ShadowStyle {
                enabled: false,
                strength: 0.0,
                size: 0.0,
                opacity: 0.0,
                blur: 0.0,
            },
            border: BorderStyle {
                enabled: false,
                width: 0.0,
                color: [0.0, 0.0, 0.0, 0.0],
                opacity: 0.0,
            },
        };

        RenderOptions {
            output_width,
            output_height,
            zoom: ZoomState::default(),
            webcam: None,
            cursor: None,
            background,
        }
    }
}
