//! Preview rendering module.
//!
//! Provides GPU-rendered preview frames streamed via WebSocket.
//! This ensures the preview exactly matches the exported video.

mod decoder;
mod frame_ws;

pub use decoder::{spawn_decoder, AsyncVideoDecoderHandle, DecodedFrame as AsyncDecodedFrame};
pub use frame_ws::{create_frame_ws, ShutdownSignal, WSFrame};

use crate::commands::video_recording::video_project::{VideoProject, XY};
use crate::rendering::compositor::Compositor;
use crate::rendering::renderer::Renderer;
use crate::rendering::text::prepare_texts;
use crate::rendering::types::{
    BackgroundStyle, BackgroundType, BorderStyle, CornerStyle, DecodedFrame, RenderOptions,
    ShadowStyle, ZoomState,
};
use log::info;
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
    /// Async video decoder handle.
    decoder: Mutex<Option<AsyncVideoDecoderHandle>>,
    /// Current frame number.
    frame_number: Mutex<u32>,
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
        let video_path = PathBuf::from(&project.sources.screen_video);
        if !video_path.exists() {
            return Err(format!("Video file not found: {:?}", video_path));
        }

        // Spawn async decoder
        let decoder_handle = spawn_decoder(video_path)?;

        info!(
            "Preview decoder ready: {}x{} @ {}fps",
            decoder_handle.width, decoder_handle.height, decoder_handle.fps
        );

        *self.decoder.lock().await = Some(decoder_handle);
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

        // Request frame from async decoder
        let time_secs = time_ms as f32 / 1000.0;
        let async_frame = decoder
            .get_frame(time_secs)
            .await
            .ok_or_else(|| "Failed to decode frame".to_string())?;

        // Convert to rendering DecodedFrame type
        let frame = DecodedFrame {
            frame_number: async_frame.frame_number,
            timestamp_ms: async_frame.timestamp_ms,
            data: async_frame.data,
            width: async_frame.width,
            height: async_frame.height,
        };

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

    /// Render only text overlays (no video decoding).
    /// Much faster than full frame rendering - used during playback.
    pub async fn render_text_only(&self, time_ms: u64) -> Result<(), String> {
        let project = self.project.lock().await;
        let project = project
            .as_ref()
            .ok_or_else(|| "No project set".to_string())?;

        let output_width = project.sources.original_width;
        let output_height = project.sources.original_height;

        // Prepare text overlays
        let output_size = XY::new(output_width, output_height);
        let frame_time_secs = time_ms as f64 / 1000.0;
        let prepared_texts = prepare_texts(output_size, frame_time_secs, &project.text.segments);

        // Render text-only (transparent background)
        // Always send a frame even if no text - this clears any previous text from canvas
        let mut compositor = self.compositor.lock().await;
        let output_texture =
            compositor.composite_text_only(output_width, output_height, &prepared_texts);

        // Read rendered frame back to CPU
        let rgba_data = self
            .renderer
            .read_texture(&output_texture, output_width, output_height)
            .await;

        // Update frame number
        let mut frame_num = self.frame_number.lock().await;
        *frame_num += 1;

        // Send frame to WebSocket
        let ws_frame = WSFrame {
            data: rgba_data,
            width: output_width,
            height: output_height,
            stride: output_width * 4,
            frame_number: *frame_num,
            target_time_ns: time_ms * 1_000_000,
            created_at: Instant::now(),
        };

        self.frame_tx.send(Some(ws_frame)).ok();

        Ok(())
    }

    /// Build render options from project configuration.
    /// For preview, we render at video dimensions (no padding) - CSS handles frame styling.
    fn build_render_options(&self, project: &VideoProject) -> RenderOptions {
        // Preview renders at video dimensions (CSS handles padding/background)
        let output_width = project.sources.original_width;
        let output_height = project.sources.original_height;

        // For preview: minimal styling - just render video content with text overlays
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
