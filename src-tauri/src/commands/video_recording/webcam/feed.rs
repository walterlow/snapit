//! Camera feed with broadcast pattern using nokhwa (working capture backend).
//!
//! Architecture:
//! - CameraFeed owns the camera hardware via nokhwa
//! - Multiple subscribers can register to receive frames
//! - Frames are broadcast to all subscribers via try_send (non-blocking)
//! - Slow subscribers drop frames independently
//!
//! This allows preview and recording to receive the same frames
//! with the same timestamps, ensuring perfect sync.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use flume::{Receiver, Sender};
use parking_lot::{Mutex, RwLock};

use super::native_frame::NativeCameraFrame;

/// A subscriber to the camera feed.
struct Subscriber {
    /// Channel sender for this subscriber.
    sender: Sender<NativeCameraFrame>,
    /// Name for debugging.
    name: String,
    /// ID for removal.
    id: u64,
}

/// Camera feed that broadcasts frames to multiple subscribers.
pub struct CameraFeed {
    /// Device index being captured.
    device_index: usize,
    /// List of active subscribers.
    subscribers: Arc<RwLock<Vec<Subscriber>>>,
    /// Next subscriber ID.
    next_subscriber_id: AtomicU64,
    /// Signal to stop capture.
    stop_signal: Arc<AtomicBool>,
    /// Capture thread handle.
    thread: Option<JoinHandle<Result<(), String>>>,
    /// Whether feed is currently running (capture active and producing frames).
    is_running: Arc<AtomicBool>,
    /// Whether feed is starting (thread spawned, initializing camera).
    is_starting: Arc<AtomicBool>,
    /// Current frame dimensions.
    dimensions: Arc<RwLock<(u32, u32)>>,
}

/// Handle returned when subscribing - used to receive frames.
pub struct Subscription {
    /// Receiver for frames.
    pub receiver: Receiver<NativeCameraFrame>,
    /// Subscriber ID (for unsubscribe).
    id: u64,
    /// Reference to subscribers list (for unsubscribe).
    subscribers: Arc<RwLock<Vec<Subscriber>>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // Auto-unsubscribe when dropped
        let mut subs = self.subscribers.write();
        subs.retain(|s| s.id != self.id);
        log::debug!(
            "[CAMERA_FEED] Subscriber {} dropped, {} remaining",
            self.id,
            subs.len()
        );
    }
}

impl Subscription {
    /// Try to receive a frame without blocking.
    pub fn try_recv(&self) -> Option<NativeCameraFrame> {
        self.receiver.try_recv().ok()
    }

    /// Receive a frame, blocking until available.
    pub fn recv(&self) -> Option<NativeCameraFrame> {
        self.receiver.recv().ok()
    }

    /// Receive with timeout.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<NativeCameraFrame> {
        self.receiver.recv_timeout(timeout).ok()
    }
}

impl CameraFeed {
    /// Create a new camera feed for the given device.
    /// Does NOT start capture - call `start()` to begin.
    pub fn new(device_index: usize) -> Self {
        Self {
            device_index,
            subscribers: Arc::new(RwLock::new(Vec::new())),
            next_subscriber_id: AtomicU64::new(1),
            stop_signal: Arc::new(AtomicBool::new(false)),
            thread: None,
            is_running: Arc::new(AtomicBool::new(false)),
            is_starting: Arc::new(AtomicBool::new(false)),
            dimensions: Arc::new(RwLock::new((0, 0))),
        }
    }

    /// Check if feed is starting (thread spawned but not yet producing frames).
    pub fn is_starting(&self) -> bool {
        self.is_starting.load(Ordering::SeqCst)
    }

    /// Start capturing frames.
    pub fn start(&mut self) -> Result<(), String> {
        if self.is_running.load(Ordering::SeqCst) || self.is_starting.load(Ordering::SeqCst) {
            return Ok(()); // Already running or starting
        }

        self.stop_signal.store(false, Ordering::SeqCst);
        self.is_starting.store(true, Ordering::SeqCst); // Mark as starting BEFORE spawning

        let device_index = self.device_index;
        let subscribers = Arc::clone(&self.subscribers);
        let stop_signal = Arc::clone(&self.stop_signal);
        let is_running = Arc::clone(&self.is_running);
        let is_starting = Arc::clone(&self.is_starting);
        let dimensions = Arc::clone(&self.dimensions);

        let thread = std::thread::Builder::new()
            .name("camera-feed".to_string())
            .spawn(move || {
                let result = Self::capture_loop_nokhwa(
                    device_index,
                    subscribers,
                    stop_signal,
                    is_running.clone(),
                    is_starting.clone(),
                    dimensions,
                );
                is_running.store(false, Ordering::SeqCst);
                is_starting.store(false, Ordering::SeqCst);
                result
            })
            .map_err(|e| format!("Failed to spawn capture thread: {}", e))?;

        self.thread = Some(thread);
        Ok(())
    }

    /// Stop capturing frames.
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        self.is_starting.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    /// Check if feed is running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    /// Get current frame dimensions.
    pub fn dimensions(&self) -> (u32, u32) {
        *self.dimensions.read()
    }

    /// Subscribe to receive frames.
    ///
    /// # Arguments
    /// * `name` - Name for debugging (e.g., "preview", "recording")
    /// * `buffer_size` - Channel buffer size (frames dropped if full)
    pub fn subscribe(&self, name: &str, buffer_size: usize) -> Subscription {
        let (sender, receiver) = flume::bounded(buffer_size);
        let id = self.next_subscriber_id.fetch_add(1, Ordering::SeqCst);

        let subscriber = Subscriber {
            sender,
            name: name.to_string(),
            id,
        };

        self.subscribers.write().push(subscriber);
        log::info!(
            "[CAMERA_FEED] New subscriber '{}' (id={}, buffer={})",
            name,
            id,
            buffer_size
        );

        Subscription {
            receiver,
            id,
            subscribers: Arc::clone(&self.subscribers),
        }
    }

    /// Number of active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.read().len()
    }

    /// The capture loop using nokhwa (polling-based, known to work).
    fn capture_loop_nokhwa(
        device_index: usize,
        subscribers: Arc<RwLock<Vec<Subscriber>>>,
        stop_signal: Arc<AtomicBool>,
        is_running: Arc<AtomicBool>,
        is_starting: Arc<AtomicBool>,
        dimensions: Arc<RwLock<(u32, u32)>>,
    ) -> Result<(), String> {
        use crate::config::webcam::WEBCAM_CONFIG;
        use nokhwa::utils::{
            CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
            Resolution,
        };
        use nokhwa::Camera;

        log::info!(
            "[CAMERA_FEED] Capture loop starting for device {} (nokhwa)",
            device_index
        );

        // Use configured resolution from settings
        let configured_resolution = WEBCAM_CONFIG.read().resolution;
        let (target_width, target_height) = configured_resolution.to_dimensions();
        log::info!(
            "[CAMERA_FEED] Requesting resolution: {}x{} ({:?})",
            target_width,
            target_height,
            configured_resolution
        );

        // YUYV is used for fast CPU conversion - MJPEG requires expensive JPEG decode.
        let target_format = CameraFormat::new(
            Resolution::new(target_width, target_height),
            FrameFormat::YUYV,
            30,
        );
        let requested = RequestedFormat::with_formats(
            RequestedFormatType::Closest(target_format),
            &[FrameFormat::YUYV, FrameFormat::RAWRGB, FrameFormat::MJPEG],
        );

        let index = CameraIndex::Index(device_index as u32);
        let mut camera =
            Camera::new(index, requested).map_err(|e| format!("Failed to create camera: {}", e))?;

        camera
            .open_stream()
            .map_err(|e| format!("Failed to open camera stream: {}", e))?;

        let resolution = camera.resolution();
        let width = resolution.width();
        let height = resolution.height();
        let format = camera.frame_format();

        log::info!(
            "[CAMERA_FEED] Camera opened: {}x{} format={:?}",
            width,
            height,
            format
        );

        *dimensions.write() = (width, height);
        is_running.store(true, Ordering::SeqCst);
        is_starting.store(false, Ordering::SeqCst);

        let mut frame_id: u64 = 0;
        let pixel_count = (width * height) as usize;

        while !stop_signal.load(Ordering::Relaxed) {
            match camera.frame() {
                Ok(buffer) => {
                    frame_id += 1;
                    let raw_data = buffer.buffer();

                    // Detect MJPEG by checking for JPEG magic bytes (0xFF 0xD8)
                    let is_mjpeg =
                        raw_data.len() >= 2 && raw_data[0] == 0xFF && raw_data[1] == 0xD8;

                    // Create NativeCameraFrame - zero-copy for MJPEG
                    let native_frame = if is_mjpeg {
                        NativeCameraFrame::from_mjpeg(raw_data, width, height, frame_id)
                    } else {
                        NativeCameraFrame::from_rgb_or_yuyv(
                            raw_data,
                            width,
                            height,
                            pixel_count,
                            frame_id,
                        )
                    };

                    let Some(native_frame) = native_frame else {
                        if frame_id <= 3 {
                            log::warn!("[CAMERA_FEED] Failed to create frame {}", frame_id);
                        }
                        continue;
                    };

                    if frame_id <= 3 || frame_id % 300 == 0 {
                        log::debug!(
                            "[CAMERA_FEED] Frame {}: {}x{} {} bytes mjpeg={}",
                            frame_id,
                            width,
                            height,
                            raw_data.len(),
                            is_mjpeg
                        );
                    }

                    // Broadcast to all subscribers
                    broadcast_frame(&subscribers, &native_frame, frame_id);
                },
                Err(e) => {
                    if frame_id == 0 {
                        log::error!("[CAMERA_FEED] Frame capture error: {}", e);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                },
            }
        }

        // Cleanup
        let _ = camera.stop_stream();
        log::info!("[CAMERA_FEED] Capture stopped after {} frames", frame_id);
        Ok(())
    }
}

/// Broadcast a frame to all subscribers.
fn broadcast_frame(
    subscribers: &Arc<RwLock<Vec<Subscriber>>>,
    frame: &NativeCameraFrame,
    frame_id: u64,
) {
    let mut to_remove = Vec::new();
    {
        let subs = subscribers.read();
        if frame_id <= 3 {
            log::debug!(
                "[CAMERA_FEED] Broadcasting frame {} to {} subscribers",
                frame_id,
                subs.len()
            );
        }
        for (idx, sub) in subs.iter().enumerate() {
            match sub.sender.try_send(frame.clone()) {
                Ok(()) => {
                    if frame_id <= 3 {
                        log::debug!("[CAMERA_FEED] Frame {} sent to '{}'", frame_id, sub.name);
                    }
                },
                Err(flume::TrySendError::Full(_)) => {
                    // Subscriber too slow - drop frame
                    if frame_id % 300 == 1 {
                        log::debug!(
                            "[CAMERA_FEED] Subscriber '{}' slow, dropping frame",
                            sub.name
                        );
                    }
                },
                Err(flume::TrySendError::Disconnected(_)) => {
                    log::info!("[CAMERA_FEED] Subscriber '{}' disconnected", sub.name);
                    to_remove.push(idx);
                },
            }
        }
    }

    // Remove disconnected subscribers
    if !to_remove.is_empty() {
        let mut subs = subscribers.write();
        for idx in to_remove.into_iter().rev() {
            subs.remove(idx);
        }
    }
}

impl Drop for CameraFeed {
    fn drop(&mut self) {
        self.stop();
    }
}

// ============================================================================
// Global Camera Feed (singleton pattern for easy access)
// ============================================================================

use std::sync::OnceLock;

static GLOBAL_FEED: OnceLock<Mutex<Option<CameraFeed>>> = OnceLock::new();

fn global_feed() -> &'static Mutex<Option<CameraFeed>> {
    GLOBAL_FEED.get_or_init(|| Mutex::new(None))
}

/// Start the global camera feed for a device.
pub fn start_global_feed(device_index: usize) -> Result<(), String> {
    let mut guard = global_feed().lock();

    // Check if already running or starting
    if let Some(ref feed) = *guard {
        if feed.is_running() || feed.is_starting() {
            log::info!("[CAMERA_FEED] Feed already running or starting");
            return Ok(());
        }
    }

    // Create and start new feed
    let mut feed = CameraFeed::new(device_index);
    feed.start()?;
    *guard = Some(feed);

    log::info!(
        "[CAMERA_FEED] Global feed started for device {}",
        device_index
    );
    Ok(())
}

/// Stop the global camera feed.
pub fn stop_global_feed() {
    let mut guard = global_feed().lock();
    if let Some(mut feed) = guard.take() {
        feed.stop();
    }
}

/// Subscribe to the global camera feed.
pub fn subscribe_global(name: &str, buffer_size: usize) -> Result<Subscription, String> {
    let guard = global_feed().lock();
    let feed = guard.as_ref().ok_or("Camera feed not started")?;
    Ok(feed.subscribe(name, buffer_size))
}

/// Check if global feed is running.
pub fn is_global_feed_running() -> bool {
    let guard = global_feed().lock();
    guard.as_ref().map(|f| f.is_running()).unwrap_or(false)
}

/// Restart the global camera feed with a new device index.
/// If feed is not running, this does nothing.
/// Returns the device index that was restarted, or None if feed wasn't running.
pub fn restart_global_feed(device_index: usize) -> Result<Option<usize>, String> {
    let mut guard = global_feed().lock();

    // Check if feed is running
    let was_running = guard.as_ref().map(|f| f.is_running()).unwrap_or(false);

    if !was_running {
        log::debug!("[CAMERA_FEED] Feed not running, skip restart");
        return Ok(None);
    }

    // Stop existing feed
    if let Some(mut feed) = guard.take() {
        log::info!("[CAMERA_FEED] Stopping feed for restart...");
        feed.stop();
    }

    // Small delay to let camera release
    drop(guard);
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Start new feed with same device
    let mut guard = global_feed().lock();
    let mut feed = CameraFeed::new(device_index);
    feed.start()?;
    *guard = Some(feed);

    log::info!(
        "[CAMERA_FEED] Feed restarted for device {} with new settings",
        device_index
    );
    Ok(Some(device_index))
}

/// Get global feed dimensions.
pub fn global_feed_dimensions() -> Option<(u32, u32)> {
    let guard = global_feed().lock();
    guard.as_ref().map(|f| f.dimensions())
}
