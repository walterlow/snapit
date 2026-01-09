//! Webcam preview service using the broadcast feed.
//!
//! Subscribes to the camera feed and maintains a JPEG buffer
//! for the browser preview to poll.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use parking_lot::RwLock;

use super::feed::{
    global_feed_dimensions, is_global_feed_running, start_global_feed, stop_global_feed,
    subscribe_global, Subscription,
};

/// Cached preview frame ready for browser consumption.
#[derive(Clone)]
pub struct PreviewFrame {
    /// JPEG-encoded image data.
    pub jpeg_data: Arc<Vec<u8>>,
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
    /// Frame ID for change detection.
    pub frame_id: u64,
    /// When this frame was captured.
    pub captured_at: Instant,
}

/// Thread-safe preview buffer.
pub struct PreviewBuffer {
    frame: RwLock<Option<PreviewFrame>>,
    frame_id: AtomicU64,
}

impl PreviewBuffer {
    pub const fn new() -> Self {
        Self {
            frame: RwLock::new(None),
            frame_id: AtomicU64::new(0),
        }
    }

    /// Update with a new frame.
    pub fn update(&self, jpeg_data: Vec<u8>, width: u32, height: u32) {
        let frame_id = self.frame_id.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = PreviewFrame {
            jpeg_data: Arc::new(jpeg_data),
            width,
            height,
            frame_id,
            captured_at: Instant::now(),
        };
        *self.frame.write() = Some(frame);
    }

    /// Get the latest frame.
    pub fn get(&self) -> Option<PreviewFrame> {
        self.frame.read().clone()
    }

    /// Clear the buffer.
    pub fn clear(&self) {
        *self.frame.write() = None;
    }
}

// Global preview buffer
static PREVIEW_BUFFER: PreviewBuffer = PreviewBuffer::new();

/// Preview service state.
struct PreviewService {
    stop_signal: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

static PREVIEW_SERVICE: parking_lot::Mutex<Option<PreviewService>> = parking_lot::Mutex::new(None);

/// Start the preview service.
///
/// This starts the camera feed (if not already running) and spawns
/// a thread that converts frames to JPEG for browser preview.
pub fn start_preview(device_index: usize) -> Result<(), String> {
    let mut guard = PREVIEW_SERVICE.lock();

    // Check if already running
    if guard.is_some() {
        log::debug!("[PREVIEW] Already running");
        return Ok(());
    }

    // Start the camera feed
    start_global_feed(device_index)?;

    // Subscribe to the feed
    let subscription = subscribe_global("preview", 4)?; // Small buffer, drop frames if slow

    let stop_signal = Arc::new(AtomicBool::new(false));
    let stop_signal_clone = Arc::clone(&stop_signal);

    let thread = std::thread::Builder::new()
        .name("preview-service".to_string())
        .spawn(move || {
            log::info!("[PREVIEW] Thread started");
            if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                preview_loop(subscription, stop_signal_clone);
            })) {
                log::error!("[PREVIEW] Thread panicked: {:?}", e);
            }
            log::info!("[PREVIEW] Thread exiting");
        })
        .map_err(|e| format!("Failed to spawn preview thread: {}", e))?;

    *guard = Some(PreviewService {
        stop_signal,
        thread: Some(thread),
    });

    log::info!("[PREVIEW] Started");
    Ok(())
}

/// Stop the preview service.
pub fn stop_preview() {
    let mut guard = PREVIEW_SERVICE.lock();
    if let Some(mut service) = guard.take() {
        service.stop_signal.store(true, Ordering::SeqCst);
        if let Some(thread) = service.thread.take() {
            let _ = thread.join();
        }
        PREVIEW_BUFFER.clear();
        log::info!("[PREVIEW] Stopped");
    }

    // Also stop the camera feed if no other subscribers
    // (Recording would have its own subscription)
    stop_global_feed();
}

/// Check if preview is running.
pub fn is_preview_running() -> bool {
    PREVIEW_SERVICE.lock().is_some() && is_global_feed_running()
}

/// Get the latest preview frame as base64 JPEG.
pub fn get_preview_jpeg() -> Option<String> {
    let frame = PREVIEW_BUFFER.get()?;
    if frame.jpeg_data.is_empty() {
        return None;
    }
    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        frame.jpeg_data.as_ref(),
    ))
}

/// Get preview dimensions.
pub fn get_preview_dimensions() -> Option<(u32, u32)> {
    global_feed_dimensions()
}

/// The preview loop - converts frames to JPEG.
fn preview_loop(subscription: Subscription, stop_signal: Arc<AtomicBool>) {
    log::info!("[PREVIEW] Loop started, waiting for frames...");
    eprintln!("[PREVIEW_LOOP] Started, waiting for frames...");
    let mut frame_count = 0u64;

    while !stop_signal.load(Ordering::Relaxed) {
        // Wait for next frame with timeout
        let frame = match subscription.recv_timeout(std::time::Duration::from_millis(100)) {
            Some(f) => {
                frame_count += 1;
                if frame_count <= 3 || frame_count % 60 == 0 {
                    eprintln!(
                        "[PREVIEW_LOOP] Received frame #{} (id={}), format={:?}",
                        frame_count, f.frame_id, f.pixel_format
                    );
                }
                f
            },
            None => {
                // Log occasionally to show we're still waiting
                if frame_count == 0 {
                    static WAIT_COUNT: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let count = WAIT_COUNT.fetch_add(1, Ordering::Relaxed);
                    if count % 50 == 0 {
                        eprintln!(
                            "[PREVIEW_LOOP] Still waiting for first frame (waited {}s)",
                            count / 10
                        );
                    }
                }
                continue;
            },
        };

        // Convert to JPEG
        let start = std::time::Instant::now();
        let jpeg_data = if frame.is_mjpeg() {
            // MJPEG: use directly (no conversion needed!)
            frame.bytes().to_vec()
        } else {
            // Other formats: convert to JPEG
            match frame.to_jpeg(75) {
                Some(data) => data,
                None => {
                    eprintln!(
                        "[PREVIEW_LOOP] Failed to convert frame {} to JPEG",
                        frame_count
                    );
                    continue;
                },
            }
        };
        let elapsed = start.elapsed();

        if frame_count <= 3 || frame_count % 60 == 0 {
            eprintln!(
                "[PREVIEW_LOOP] Frame {} converted to JPEG ({} bytes) in {:?}",
                frame_count,
                jpeg_data.len(),
                elapsed
            );
        }

        // Update preview buffer
        PREVIEW_BUFFER.update(jpeg_data, frame.width, frame.height);
    }

    eprintln!("[PREVIEW_LOOP] Stopped");
}
