//! Tauri commands for GPU-rendered preview.

use crate::commands::video_recording::video_project::VideoProject;
use crate::preview::{create_frame_ws, PreviewRenderer, ShutdownSignal, WSFrame};
use crate::rendering::RendererState;
use std::sync::Arc;
use tauri::{command, State};
use tokio::sync::{watch, RwLock};

/// Global preview state.
pub struct PreviewState {
    /// Preview renderer instance.
    renderer: RwLock<Option<Arc<PreviewRenderer>>>,
    /// WebSocket port for frame streaming.
    ws_port: RwLock<Option<u16>>,
    /// WebSocket shutdown signal.
    ws_shutdown: RwLock<Option<ShutdownSignal>>,
    /// Frame sender for the WebSocket.
    frame_tx: RwLock<Option<watch::Sender<Option<WSFrame>>>>,
}

impl PreviewState {
    pub fn new() -> Self {
        Self {
            renderer: RwLock::new(None),
            ws_port: RwLock::new(None),
            ws_shutdown: RwLock::new(None),
            frame_tx: RwLock::new(None),
        }
    }
}

impl Default for PreviewState {
    fn default() -> Self {
        Self::new()
    }
}

/// Initialize the preview renderer and WebSocket server.
///
/// Returns the WebSocket URL for connecting to the frame stream.
/// If already initialized, returns the existing WebSocket URL.
#[command]
pub async fn init_preview(
    state: State<'_, PreviewState>,
    renderer_state: State<'_, RendererState>,
) -> Result<String, String> {
    // Check if already initialized - return existing URL
    {
        let existing_port = state.ws_port.read().await;
        if let Some(port) = *existing_port {
            log::info!(
                "[Preview] Already initialized, returning existing URL on port {}",
                port
            );
            return Ok(format!("ws://localhost:{}", port));
        }
    }

    // Shutdown any existing state first (cleanup)
    shutdown_preview_internal(&state).await;

    // Get the shared renderer
    let renderer = renderer_state.get_renderer().await?;

    // Create frame channel
    let (frame_tx, frame_rx) = watch::channel(None);

    // Start WebSocket server
    let (ws_port, ws_shutdown) = create_frame_ws(frame_rx).await;

    // Create preview renderer with shared GPU renderer
    let preview_renderer = PreviewRenderer::new(renderer, frame_tx.clone());

    // Store state
    *state.renderer.write().await = Some(Arc::new(preview_renderer));
    *state.ws_port.write().await = Some(ws_port);
    *state.ws_shutdown.write().await = Some(ws_shutdown);
    *state.frame_tx.write().await = Some(frame_tx);

    log::info!("[Preview] Initialized on port {}", ws_port);
    Ok(format!("ws://localhost:{}", ws_port))
}

/// Internal shutdown helper
async fn shutdown_preview_internal(state: &PreviewState) {
    // Signal WebSocket shutdown
    if let Some(shutdown) = state.ws_shutdown.write().await.take() {
        shutdown.shutdown();
    }

    // Clear state
    *state.renderer.write().await = None;
    *state.ws_port.write().await = None;
    *state.frame_tx.write().await = None;
}

/// Set the project for preview rendering.
#[command]
pub async fn set_preview_project(
    state: State<'_, PreviewState>,
    project: VideoProject,
) -> Result<(), String> {
    let renderer = state.renderer.read().await;
    let renderer = renderer
        .as_ref()
        .ok_or_else(|| "Preview not initialized".to_string())?;

    renderer.set_project(project).await
}

/// Render a preview frame at the specified time.
#[command]
pub async fn render_preview_frame(
    state: State<'_, PreviewState>,
    time_ms: u64,
) -> Result<(), String> {
    let renderer = state.renderer.read().await;
    let renderer = renderer
        .as_ref()
        .ok_or_else(|| "Preview not initialized".to_string())?;

    renderer.render_frame(time_ms).await
}

/// Shutdown the preview renderer and WebSocket server.
#[command]
pub async fn shutdown_preview(state: State<'_, PreviewState>) -> Result<(), String> {
    log::info!("[Preview] Shutting down");
    shutdown_preview_internal(&state).await;
    Ok(())
}

/// Get the current WebSocket port (if initialized).
#[command]
pub async fn get_preview_ws_port(state: State<'_, PreviewState>) -> Result<Option<u16>, String> {
    Ok(*state.ws_port.read().await)
}
