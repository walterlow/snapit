//! WebSocket server for streaming GPU-rendered preview frames.
//!
//! Based on Cap's frame streaming implementation.
//! Streams RGBA-encoded frames to the frontend for display.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    routing::get,
    Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{watch, Notify};

/// Frame data ready for WebSocket transmission.
#[derive(Clone)]
pub struct WSFrame {
    /// Raw RGBA frame data.
    pub data: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Bytes per row (may include padding).
    pub stride: u32,
    /// Frame number for sequencing.
    pub frame_number: u32,
    /// Target display time in nanoseconds.
    pub target_time_ns: u64,
    /// When this frame was created.
    pub created_at: Instant,
}

/// Shutdown signal for the WebSocket server.
pub struct ShutdownSignal {
    notify: Arc<Notify>,
}

impl ShutdownSignal {
    /// Create a new shutdown signal.
    pub fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
        }
    }

    /// Signal shutdown.
    pub fn shutdown(&self) {
        self.notify.notify_one();
    }

    /// Wait for shutdown signal.
    pub async fn wait(&self) {
        self.notify.notified().await;
    }

    /// Clone the internal notify for sharing.
    fn clone_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.notify)
    }
}

impl Clone for ShutdownSignal {
    fn clone(&self) -> Self {
        Self {
            notify: Arc::clone(&self.notify),
        }
    }
}

/// Create a WebSocket server for frame streaming.
///
/// Returns the port number and a shutdown signal.
pub async fn create_frame_ws(frame_rx: watch::Receiver<Option<WSFrame>>) -> (u16, ShutdownSignal) {
    let shutdown = ShutdownSignal::new();
    let shutdown_notify = shutdown.clone_notify();

    // Build router with WebSocket endpoint
    let app = Router::new().route(
        "/",
        get(move |ws: WebSocketUpgrade| {
            let rx = frame_rx.clone();
            async move { ws.on_upgrade(move |socket| handle_socket(socket, rx)) }
        }),
    );

    // Bind to random port on localhost
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Failed to bind WebSocket server");
    let port = listener.local_addr().unwrap().port();

    log::info!("[FrameWS] Started on port {}", port);

    // Spawn server task
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            shutdown_notify.notified().await;
            log::info!("[FrameWS] Shutting down");
        })
        .await
        .ok();
    });

    (port, shutdown)
}

/// Handle a WebSocket connection.
async fn handle_socket(mut socket: WebSocket, mut frame_rx: watch::Receiver<Option<WSFrame>>) {
    log::debug!("[FrameWS] Client connected");

    // Send current frame immediately if available
    // Clone the frame to avoid holding borrow across await
    let initial_msg = {
        let borrowed = frame_rx.borrow();
        borrowed.as_ref().and_then(encode_frame)
    };
    if let Some(msg) = initial_msg {
        if socket.send(msg).await.is_err() {
            return;
        }
    }

    // Stream frames as they arrive
    loop {
        tokio::select! {
            // Handle incoming messages (mainly close)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => {
                        log::debug!("[FrameWS] Client disconnected");
                        break;
                    }
                    _ => {}
                }
            }
            // Send new frames
            result = frame_rx.changed() => {
                if result.is_err() {
                    break;
                }
                // Clone the message before await to avoid holding borrow
                let frame_msg = {
                    let borrowed = frame_rx.borrow_and_update();
                    borrowed.as_ref().and_then(encode_frame)
                };
                if let Some(msg) = frame_msg {
                    if socket.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
}

/// Encode a frame as NV12 with metadata for transmission.
fn encode_frame(frame: &WSFrame) -> Option<Message> {
    // For simplicity, we'll send RGBA directly with metadata
    // A more optimized version would convert to NV12
    let rgba_data = &frame.data;

    // Calculate expected size
    let expected_size = (frame.width * frame.height * 4) as usize;
    if rgba_data.len() < expected_size {
        log::warn!(
            "[FrameWS] Frame data too small: {} < {}",
            rgba_data.len(),
            expected_size
        );
        return None;
    }

    // Pack frame: RGBA data + 28 bytes metadata
    // Metadata: stride(4) + height(4) + width(4) + frame_number(4) + target_time_ns(8) + magic(4)
    let mut packed = Vec::with_capacity(rgba_data.len() + 28);
    packed.extend_from_slice(rgba_data);

    // Append metadata (little-endian)
    packed.extend_from_slice(&frame.stride.to_le_bytes());
    packed.extend_from_slice(&frame.height.to_le_bytes());
    packed.extend_from_slice(&frame.width.to_le_bytes());
    packed.extend_from_slice(&frame.frame_number.to_le_bytes());
    packed.extend_from_slice(&frame.target_time_ns.to_le_bytes());
    packed.extend_from_slice(&RGBA_MAGIC.to_le_bytes());

    Some(Message::Binary(packed))
}

/// RGBA magic number (we use RGBA instead of NV12 for simplicity).
const RGBA_MAGIC: u32 = 0x52474241; // "RGBA" in little-endian
