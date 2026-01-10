//! Native webcam capture with channel-based frame distribution.
//!
//! Architecture (adapted from Cap):
//! - Single capture thread owns the hardware via Media Foundation
//! - Channel-based frame distribution (flume) for encoder
//! - SharedFrame buffer for preview (backward compatibility)
//! - NativeCameraFrame for zero-copy GPU encoding path

// Allow unused helpers - keeping for potential future use
#![allow(dead_code)]

use parking_lot::RwLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use lazy_static::lazy_static;

use super::native_frame::NativeCameraFrame;
use crate::commands::video_recording::webcam::device::get_device_by_index;

/// Type alias for frame sender (to encoder).
pub type FrameSender = flume::Sender<NativeCameraFrame>;
/// Type alias for frame receiver (for encoder).
pub type FrameReceiver = flume::Receiver<NativeCameraFrame>;

/// A webcam frame with reference-counted pixel data for zero-copy sharing.
/// Used for preview and backward compatibility.
#[allow(dead_code)]
#[derive(Clone)]
pub struct SharedFrame {
    /// Frame data - BGRA pixels for encoder.
    pub data: Arc<Vec<u8>>,
    /// Pre-encoded JPEG for preview (cached to avoid re-encoding).
    pub jpeg_cache: Arc<Vec<u8>>,
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
    /// Monotonic frame ID.
    pub frame_id: u64,
    /// Capture timestamp.
    pub captured_at: Instant,
    /// Whether data is MJPEG compressed (true) or raw BGRA (false).
    pub is_mjpeg: bool,
}

impl SharedFrame {
    /// Decode MJPEG to BGRA if needed. Returns BGRA data.
    pub fn to_bgra(&self) -> Option<Vec<u8>> {
        if !self.is_mjpeg {
            // Already BGRA
            return Some(self.data.as_ref().clone());
        }

        // Decode MJPEG to RGB, then convert to BGRA
        let img = image::load_from_memory_with_format(&self.data, image::ImageFormat::Jpeg).ok()?;
        let rgb = img.to_rgb8();

        let mut bgra = Vec::with_capacity((self.width * self.height * 4) as usize);
        for pixel in rgb.pixels() {
            bgra.push(pixel[2]); // B
            bgra.push(pixel[1]); // G
            bgra.push(pixel[0]); // R
            bgra.push(255); // A
        }
        Some(bgra)
    }
}

/// Global shared frame buffer - single writer (capture), multiple readers.
/// Used for preview; encoder uses channel-based NativeCameraFrame instead.
pub struct WebcamFrameBuffer {
    /// Latest frame (None if no frame captured yet).
    frame: RwLock<Option<SharedFrame>>,
    /// Current frame ID (for change detection).
    frame_id: AtomicU64,
    /// Whether capture is active.
    is_active: AtomicBool,
    /// Capture dimensions.
    pub dimensions: RwLock<(u32, u32)>,
}

impl WebcamFrameBuffer {
    pub const fn new() -> Self {
        Self {
            frame: RwLock::new(None),
            frame_id: AtomicU64::new(0),
            is_active: AtomicBool::new(false),
            dimensions: RwLock::new((0, 0)),
        }
    }

    /// Update the latest frame (called by capture thread).
    pub fn update(
        &self,
        data: Vec<u8>,
        jpeg_cache: Vec<u8>,
        width: u32,
        height: u32,
        is_mjpeg: bool,
    ) {
        let frame_id = self.frame_id.fetch_add(1, Ordering::SeqCst) + 1;

        let frame = SharedFrame {
            data: Arc::new(data),
            jpeg_cache: Arc::new(jpeg_cache),
            width,
            height,
            frame_id,
            captured_at: Instant::now(),
            is_mjpeg,
        };

        *self.frame.write() = Some(frame);
        *self.dimensions.write() = (width, height);
    }

    /// Get the latest frame (zero-copy Arc clone).
    pub fn get(&self) -> Option<SharedFrame> {
        self.frame.read().clone()
    }

    /// Get frame only if it is newer than the given ID (for efficient polling).
    pub fn get_if_newer(&self, last_id: u64) -> Option<SharedFrame> {
        let current_id = self.frame_id.load(Ordering::SeqCst);
        if current_id > last_id {
            self.get()
        } else {
            None
        }
    }

    /// Get current frame ID without reading the frame.
    pub fn current_frame_id(&self) -> u64 {
        self.frame_id.load(Ordering::SeqCst)
    }

    /// Get capture dimensions.
    pub fn dimensions(&self) -> (u32, u32) {
        *self.dimensions.read()
    }

    /// Check if capture is active.
    pub fn is_active(&self) -> bool {
        self.is_active.load(Ordering::SeqCst)
    }

    /// Set capture active state.
    pub fn set_active(&self, active: bool) {
        self.is_active.store(active, Ordering::SeqCst);
    }

    /// Clear the frame buffer.
    pub fn clear(&self) {
        *self.frame.write() = None;
    }
}

lazy_static! {
    /// Global webcam frame buffer - shared between capture, encoder, and preview.
    pub static ref WEBCAM_BUFFER: WebcamFrameBuffer = WebcamFrameBuffer::new();
}

/// Global frame receiver for encoder.
static FRAME_RECEIVER: RwLock<Option<FrameReceiver>> = RwLock::new(None);

/// Get the global frame receiver for encoding.
/// Returns None if capture is not running or no receiver was created.
pub fn get_frame_receiver() -> Option<FrameReceiver> {
    FRAME_RECEIVER.read().clone()
}

/// Webcam capture service using native Media Foundation.
pub struct WebcamCaptureService {
    device_index: usize,
    should_stop: Arc<AtomicBool>,
    frame_sender: Option<FrameSender>,
}

impl WebcamCaptureService {
    /// Create a new capture service (preview only, no channel).
    pub fn new(device_index: usize) -> Self {
        Self {
            device_index,
            should_stop: Arc::new(AtomicBool::new(false)),
            frame_sender: None,
        }
    }

    /// Create a new capture service with frame channel for encoder.
    pub fn with_channel(device_index: usize, sender: FrameSender) -> Self {
        Self {
            device_index,
            should_stop: Arc::new(AtomicBool::new(false)),
            frame_sender: Some(sender),
        }
    }

    /// Get stop flag for external control.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.should_stop)
    }

    /// Run the capture loop (blocking - call from a thread).
    pub fn run(self) -> Result<(), String> {
        use crate::config::webcam::WEBCAM_CONFIG;
        use snapit_camera_windows::{FormatPreference, PixelFormat};

        let device = get_device_by_index(self.device_index)?;

        // Get resolution from config
        let (target_width, target_height) = WEBCAM_CONFIG.read().resolution.to_dimensions();

        // Prefer MJPEG for preview - camera does hardware compression, no CPU conversion needed.
        // For recording/encoding, NV12 would be better but preview is the bottleneck.
        let preference = FormatPreference::new(target_width, target_height, 30.0)
            .with_format_priority(vec![
                PixelFormat::MJPEG, // Best for preview - no CPU conversion
                PixelFormat::NV12,  // Good for hardware encoding
                PixelFormat::YUYV422,
                PixelFormat::RGB32,
            ]);

        let format = device
            .find_format_with_fallback(&preference)
            .ok_or_else(|| "No suitable camera format found".to_string())?;

        log::info!(
            "[WEBCAM] Selected format: {}x{} {:?} @ {:.1}fps",
            format.width(),
            format.height(),
            format.pixel_format(),
            format.frame_rate()
        );

        let width = format.width();
        let height = format.height();
        let pixel_format = format.pixel_format();

        // Frame counter for IDs
        let frame_counter = Arc::new(AtomicU64::new(0));
        let frame_counter_clone = Arc::clone(&frame_counter);

        // Stop flag for callback
        let should_stop = Arc::clone(&self.should_stop);
        let should_stop_clone = Arc::clone(&should_stop);

        // Channel sender for encoder
        let frame_sender = self.frame_sender.clone();

        // Start capture with callback
        let _capture_handle = device
            .start_capturing(&format, move |frame| {
                // Check stop flag
                if should_stop_clone.load(Ordering::Relaxed) {
                    return;
                }

                let frame_id = frame_counter_clone.fetch_add(1, Ordering::SeqCst) + 1;

                // Create NativeCameraFrame for encoder channel
                if let Some(ref sender) = frame_sender {
                    if let Some(native_frame) = NativeCameraFrame::from_frame(&frame, frame_id) {
                        // Non-blocking send - drop frames if encoder is backed up
                        let _ = sender.try_send(native_frame.clone());

                        // Also update SharedFrame buffer for preview
                        update_preview_buffer(&native_frame);
                    }
                } else {
                    // No encoder channel - just update preview buffer
                    if let Some(native_frame) = NativeCameraFrame::from_frame(&frame, frame_id) {
                        update_preview_buffer(&native_frame);
                    } else {
                        log::warn!(
                            "[WEBCAM] Failed to create NativeCameraFrame from frame {}",
                            frame_id
                        );
                    }
                }
            })
            .map_err(|e| format!("Failed to start capture: {}", e))?;

        WEBCAM_BUFFER.set_active(true);
        *WEBCAM_BUFFER.dimensions.write() = (width, height);

        log::info!(
            "[WEBCAM] Capture started: {}x{} {:?}",
            width,
            height,
            pixel_format
        );

        // Wait for stop signal
        while !should_stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Cleanup
        WEBCAM_BUFFER.set_active(false);
        WEBCAM_BUFFER.clear();

        log::info!("[WEBCAM] Capture stopped");
        Ok(())
    }
}

/// Update the preview buffer from a NativeCameraFrame.
fn update_preview_buffer(frame: &NativeCameraFrame) {
    // For MJPEG, pass directly without conversion - huge performance win
    if frame.is_mjpeg() {
        let jpeg_data = frame.bytes().to_vec();
        log::debug!(
            "[WEBCAM] MJPEG frame: {}x{} {} bytes",
            frame.width,
            frame.height,
            jpeg_data.len()
        );
        WEBCAM_BUFFER.update(
            Vec::new(), // No BGRA data needed for MJPEG
            jpeg_data,
            frame.width,
            frame.height,
            true, // is_mjpeg
        );
        return;
    }

    // For other formats, convert to BGRA then JPEG
    let bgra = match frame.to_bgra() {
        Some(data) => data,
        None => return,
    };

    // Encode JPEG for preview cache
    let jpeg_cache = frame.to_jpeg(75).unwrap_or_default();

    WEBCAM_BUFFER.update(bgra, jpeg_cache, frame.width, frame.height, false);
}

/// Global capture thread handle.
static CAPTURE_STOP_FLAG: RwLock<Option<Arc<AtomicBool>>> = RwLock::new(None);
static CAPTURE_THREAD: parking_lot::Mutex<Option<std::thread::JoinHandle<()>>> =
    parking_lot::Mutex::new(None);
static CAPTURE_DEVICE_INDEX: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(usize::MAX);

/// Start the global webcam capture service (preview only).
/// If already running with the same device, this is a no-op.
pub fn start_capture_service(device_index: usize) -> Result<(), String> {
    start_capture_service_internal(device_index, None)
}

/// Start the global webcam capture service with a frame channel for encoding.
/// Returns a receiver for frames.
pub fn start_capture_with_receiver(
    device_index: usize,
    buffer_size: usize,
) -> Result<FrameReceiver, String> {
    let (sender, receiver) = flume::bounded(buffer_size);

    // Store receiver globally for encoder access
    *FRAME_RECEIVER.write() = Some(receiver.clone());

    start_capture_service_internal(device_index, Some(sender))?;
    Ok(receiver)
}

/// Internal capture service start.
fn start_capture_service_internal(
    device_index: usize,
    sender: Option<FrameSender>,
) -> Result<(), String> {
    // Check if already running with same device
    let current_device = CAPTURE_DEVICE_INDEX.load(Ordering::SeqCst);
    if current_device == device_index && is_capture_running() {
        log::info!(
            "[WEBCAM] Capture already running for device {}, skipping start",
            device_index
        );
        return Ok(());
    }

    // Stop existing capture if any
    stop_capture_service();

    // Store the device index
    CAPTURE_DEVICE_INDEX.store(device_index, Ordering::SeqCst);

    let service = match sender {
        Some(s) => WebcamCaptureService::with_channel(device_index, s),
        None => WebcamCaptureService::new(device_index),
    };

    let stop_flag = service.stop_flag();

    // Store stop flag
    *CAPTURE_STOP_FLAG.write() = Some(stop_flag);

    // Spawn capture thread
    let handle = std::thread::Builder::new()
        .name("webcam-capture".to_string())
        .spawn(move || {
            if let Err(e) = service.run() {
                log::error!("[WEBCAM] Capture service error: {}", e);
            }
        })
        .map_err(|e| format!("Failed to spawn webcam thread: {}", e))?;

    *CAPTURE_THREAD.lock() = Some(handle);

    // Brief delay to let camera thread start
    std::thread::sleep(std::time::Duration::from_millis(100));
    Ok(())
}

/// Stop the global webcam capture service.
pub fn stop_capture_service() {
    // Reset device index
    CAPTURE_DEVICE_INDEX.store(usize::MAX, Ordering::SeqCst);

    // Clear frame receiver
    *FRAME_RECEIVER.write() = None;

    // Signal stop
    if let Some(stop_flag) = CAPTURE_STOP_FLAG.write().take() {
        stop_flag.store(true, Ordering::SeqCst);
    }

    // Wait for thread to finish
    if let Some(handle) = CAPTURE_THREAD.lock().take() {
        let _ = handle.join();
    }

    WEBCAM_BUFFER.clear();
}

/// Check if capture service is running.
pub fn is_capture_running() -> bool {
    WEBCAM_BUFFER.is_active()
}

/// Enumerate available webcam devices using native API.
pub fn enumerate_devices() -> Result<Vec<(usize, String)>, String> {
    let devices = snapit_camera_windows::get_devices()
        .map_err(|e| format!("Failed to enumerate devices: {}", e))?;

    let result: Vec<(usize, String)> = devices
        .iter()
        .enumerate()
        .map(|(idx, device)| (idx, device.name().to_string_lossy().to_string()))
        .collect();

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frame_buffer() {
        let buffer = WebcamFrameBuffer::new();

        // Initially empty
        assert!(buffer.get().is_none());
        assert_eq!(buffer.current_frame_id(), 0);

        // Add a frame
        buffer.update(vec![0u8; 400], vec![0u8; 100], 10, 10, false);
        assert!(buffer.get().is_some());
        assert_eq!(buffer.current_frame_id(), 1);

        // Get if newer
        assert!(buffer.get_if_newer(0).is_some());
        assert!(buffer.get_if_newer(1).is_none());

        // Verify frame contents
        let frame = buffer.get().unwrap();
        assert_eq!(frame.width, 10);
        assert_eq!(frame.height, 10);
        assert_eq!(frame.jpeg_cache.len(), 100);
    }
}
