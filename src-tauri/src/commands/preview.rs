//! Tauri commands for GPU-rendered preview.

use crate::commands::video_recording::video_project::{TextSegment, VideoProject};
use crate::preview::{
    create_frame_ws, get_preview_instance, remove_preview_instance, PreviewRenderer,
    ShutdownSignal, WSFrame,
};
use crate::rendering::RendererState;
use parking_lot::Mutex as ParkingMutex;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{command, Manager, State, WebviewWindow};
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

/// Render only text overlays (no video decoding).
/// Much faster than full frame rendering - used during playback.
#[command]
pub async fn render_text_only_frame(
    state: State<'_, PreviewState>,
    time_ms: u64,
) -> Result<(), String> {
    let renderer = state.renderer.read().await;
    let renderer = renderer
        .as_ref()
        .ok_or_else(|| "Preview not initialized".to_string())?;

    renderer.render_text_only(time_ms).await
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

/// Render text overlay with segments passed directly.
/// This is the simplest API for text preview - no project setup required.
#[command]
pub async fn render_text_overlay(
    state: State<'_, PreviewState>,
    time_ms: u64,
    width: u32,
    height: u32,
    segments: Vec<TextSegment>,
) -> Result<(), String> {
    let renderer = state.renderer.read().await;
    let renderer = renderer
        .as_ref()
        .ok_or_else(|| "Preview not initialized".to_string())?;

    renderer
        .render_text_with_segments(time_ms, width, height, &segments)
        .await
}

// =============================================================================
// Native Text Preview Commands (zero-latency surface rendering)
// =============================================================================

/// State for native text preview surfaces.
pub struct NativePreviewState {
    /// Preview instances by window label.
    pub instances: ParkingMutex<HashMap<String, Arc<crate::preview::NativeTextPreview>>>,
}

impl NativePreviewState {
    pub fn new() -> Self {
        Self {
            instances: ParkingMutex::new(HashMap::new()),
        }
    }

    /// Get a preview instance by window label.
    pub fn get(&self, label: &str) -> Option<Arc<crate::preview::NativeTextPreview>> {
        self.instances.lock().get(label).cloned()
    }

    /// Insert a preview instance.
    pub fn insert(&self, label: String, preview: Arc<crate::preview::NativeTextPreview>) {
        self.instances.lock().insert(label, preview);
    }

    /// Remove and return a preview instance.
    pub fn remove(&self, label: &str) -> Option<Arc<crate::preview::NativeTextPreview>> {
        self.instances.lock().remove(label)
    }
}

impl Default for NativePreviewState {
    fn default() -> Self {
        Self::new()
    }
}

/// Initialize native text preview surface for a window.
///
/// Creates a child window with wgpu rendering positioned behind the webview.
/// This provides zero-latency text rendering without WebSocket overhead.
///
/// # Arguments
/// * `window` - The Tauri window to attach the preview to
/// * `x` - X position within the window
/// * `y` - Y position within the window
/// * `width` - Preview width in pixels
/// * `height` - Preview height in pixels
#[cfg(windows)]
#[command]
pub async fn init_native_text_preview(
    window: WebviewWindow,
    renderer_state: State<'_, RendererState>,
    native_state: State<'_, NativePreviewState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use raw_window_handle::HasWindowHandle;

    let label = window.label().to_string();
    log::info!(
        "[NativePreview] Initializing for window '{}' at ({}, {}) {}x{}",
        label,
        x,
        y,
        width,
        height
    );

    // Get parent HWND from Tauri window
    let hwnd = {
        let handle = window
            .window_handle()
            .map_err(|e| format!("Failed to get window handle: {}", e))?;
        match handle.as_raw() {
            raw_window_handle::RawWindowHandle::Win32(h) => h.hwnd.get() as isize,
            _ => return Err("Expected Win32 window handle".to_string()),
        }
    };

    // Get shared renderer
    let renderer = renderer_state.get_renderer().await?;

    // Create preview instance
    let preview =
        crate::preview::NativeTextPreview::new(renderer.device().clone(), renderer.queue().clone());

    // Initialize surface
    preview.init_surface(hwnd, x, y, width, height)?;

    // Store instance
    native_state.insert(label.clone(), Arc::new(preview));

    log::info!("[NativePreview] Initialized for window '{}'", label);
    Ok(())
}

#[cfg(not(windows))]
#[command]
pub async fn init_native_text_preview(
    _window: WebviewWindow,
    _renderer_state: State<'_, RendererState>,
    _native_state: State<'_, NativePreviewState>,
    _x: i32,
    _y: i32,
    _width: u32,
    _height: u32,
) -> Result<(), String> {
    Err("Native text preview is only supported on Windows".to_string())
}

/// Resize the native text preview surface.
#[command]
pub async fn resize_native_text_preview(
    window: WebviewWindow,
    native_state: State<'_, NativePreviewState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let label = window.label();

    if let Some(preview) = native_state.get(label) {
        preview.resize(x, y, width, height);
    }

    Ok(())
}

/// Update text segments for the native preview.
#[command]
pub async fn update_native_text_preview(
    window: WebviewWindow,
    native_state: State<'_, NativePreviewState>,
    segments: Vec<TextSegment>,
    time_ms: u64,
) -> Result<(), String> {
    let label = window.label();

    if let Some(preview) = native_state.get(label) {
        preview.update_segments(segments, time_ms);
    }

    Ok(())
}

/// Update just the time for the native preview (for scrubbing).
#[command]
pub async fn scrub_native_text_preview(
    window: WebviewWindow,
    native_state: State<'_, NativePreviewState>,
    time_ms: u64,
) -> Result<(), String> {
    let label = window.label();

    if let Some(preview) = native_state.get(label) {
        preview.update_time(time_ms);
    }

    Ok(())
}

/// Destroy the native text preview for a window.
#[command]
pub async fn destroy_native_text_preview(
    window: WebviewWindow,
    native_state: State<'_, NativePreviewState>,
) -> Result<(), String> {
    let label = window.label().to_string();

    if let Some(preview) = native_state.remove(&label) {
        preview.destroy();
    }

    log::info!("[NativePreview] Destroyed for window '{}'", label);
    Ok(())
}
