//! Native webcam capture with shared frame buffer.
//!
//! Single capture thread owns the hardware, shares frames via Arc for:
//! - Recording encoder (zero-copy Arc clone)
//! - Preview window (reads latest frame)
//!
//! This avoids the "only one app can use camera" issue by having a single
//! capture source that multiple consumers can read from.

use parking_lot::RwLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use lazy_static::lazy_static;

/// Decode MJPEG to BGRA pixels.
fn decode_mjpeg_to_bgra(data: &[u8], _width: u32, _height: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg).ok()?;
    let rgb = img.to_rgb8();

    let mut bgra = Vec::with_capacity(rgb.len() / 3 * 4);
    for pixel in rgb.pixels() {
        bgra.push(pixel[2]); // B
        bgra.push(pixel[1]); // G
        bgra.push(pixel[0]); // R
        bgra.push(255); // A
    }
    Some(bgra)
}

/// Encode BGRA to JPEG bytes.
fn encode_bgra_to_jpeg(bgra: &[u8], width: u32, height: u32, quality: u8) -> Option<Vec<u8>> {
    use image::{ImageBuffer, Rgb};

    // Convert BGRA to RGB
    let mut rgb_data = Vec::with_capacity((width * height * 3) as usize);
    for pixel in bgra.chunks_exact(4) {
        rgb_data.push(pixel[2]); // R
        rgb_data.push(pixel[1]); // G
        rgb_data.push(pixel[0]); // B
    }

    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgb_data)?;

    let mut jpeg_buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, quality);
    encoder.encode_image(&img).ok()?;

    Some(jpeg_buffer)
}

/// A webcam frame with reference-counted pixel data for zero-copy sharing.
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
pub struct WebcamFrameBuffer {
    /// Latest frame (None if no frame captured yet).
    frame: RwLock<Option<SharedFrame>>,
    /// Current frame ID (for change detection).
    frame_id: AtomicU64,
    /// Whether capture is active.
    is_active: AtomicBool,
    /// Capture dimensions.
    dimensions: RwLock<(u32, u32)>,
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
    /// `data` is BGRA pixels, `jpeg_cache` is pre-encoded JPEG for preview.
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

    /// Get frame only if it's newer than the given ID (for efficient polling).
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

/// Webcam capture service that runs in a background thread.
pub struct WebcamCaptureService {
    device_index: usize,
    should_stop: Arc<AtomicBool>,
}

impl WebcamCaptureService {
    /// Create a new capture service.
    pub fn new(device_index: usize) -> Self {
        Self {
            device_index,
            should_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Get stop flag for external control.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.should_stop)
    }

    /// Run the capture loop (blocking - call from a thread).
    pub fn run(self) -> Result<(), String> {
        use nokhwa::pixel_format::RgbFormat;
        use nokhwa::utils::{
            CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
            Resolution,
        };
        use nokhwa::Camera;

        // Request MJPEG format at 720p for quality recording
        // Using with_formats to prefer MJPEG, falling back to YUYV
        let target_format = CameraFormat::new(Resolution::new(1280, 720), FrameFormat::MJPEG, 30);
        let requested = RequestedFormat::with_formats(
            RequestedFormatType::Closest(target_format),
            &[FrameFormat::MJPEG, FrameFormat::YUYV],
        );

        let index = CameraIndex::Index(self.device_index as u32);

        let mut camera =
            Camera::new(index, requested).map_err(|e| format!("Failed to open webcam: {}", e))?;

        camera
            .open_stream()
            .map_err(|e| format!("Failed to open camera stream: {}", e))?;

        let resolution = camera.resolution();
        let width = resolution.width();
        let height = resolution.height();
        let format = camera.frame_format();

        eprintln!(
            "[WEBCAM] Camera opened: {}x{} format={:?} @ index {}",
            width, height, format, self.device_index
        );

        WEBCAM_BUFFER.set_active(true);

        // Target ~30fps but camera may run at different rate
        let mut frame_count: u64 = 0;

        loop {
            // Check if we should stop
            if self.should_stop.load(Ordering::Relaxed) {
                break;
            }

            // Capture frame - camera.frame() blocks until next frame is ready
            match camera.frame() {
                Ok(buffer) => {
                    let raw_data = buffer.buffer();
                    let pixel_count = (width * height) as usize;

                    // Detect format by checking JPEG magic bytes (0xFF 0xD8)
                    let is_mjpeg =
                        raw_data.len() >= 2 && raw_data[0] == 0xFF && raw_data[1] == 0xD8;

                    // Process frame: produce data (for encoder) and jpeg_cache (for preview)
                    let (frame_data, jpeg_cache) = if is_mjpeg {
                        // MJPEG: use raw for both
                        let data = raw_data.to_vec();
                        (data.clone(), data)
                    } else {
                        // Raw pixel data - convert to BGRA, encode JPEG for preview cache
                        let expected_rgb = pixel_count * 3;
                        let expected_yuyv = pixel_count * 2;

                        let mut bgra = Vec::with_capacity(pixel_count * 4);

                        if raw_data.len() >= expected_rgb {
                            for pixel in raw_data[..expected_rgb].chunks_exact(3) {
                                bgra.push(pixel[2]); // B
                                bgra.push(pixel[1]); // G
                                bgra.push(pixel[0]); // R
                                bgra.push(255); // A
                            }
                        } else if raw_data.len() >= expected_yuyv {
                            for chunk in raw_data[..expected_yuyv].chunks_exact(4) {
                                let y0 = chunk[0] as f32;
                                let u = chunk[1] as f32 - 128.0;
                                let y1 = chunk[2] as f32;
                                let v = chunk[3] as f32 - 128.0;

                                let r0 = (y0 + 1.402 * v).clamp(0.0, 255.0) as u8;
                                let g0 = (y0 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                                let b0 = (y0 + 1.772 * u).clamp(0.0, 255.0) as u8;

                                let r1 = (y1 + 1.402 * v).clamp(0.0, 255.0) as u8;
                                let g1 = (y1 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                                let b1 = (y1 + 1.772 * u).clamp(0.0, 255.0) as u8;

                                bgra.push(b0);
                                bgra.push(g0);
                                bgra.push(r0);
                                bgra.push(255);
                                bgra.push(b1);
                                bgra.push(g1);
                                bgra.push(r1);
                                bgra.push(255);
                            }
                        } else {
                            if frame_count == 0 {
                                eprintln!("[WEBCAM] Unknown format, skipping");
                            }
                            continue;
                        }

                        // Encode JPEG for preview (cached, not per-poll)
                        let jpeg =
                            encode_bgra_to_jpeg(&bgra, width, height, 75).unwrap_or_default();

                        (bgra, jpeg)
                    };

                    // Store data + cached JPEG
                    WEBCAM_BUFFER.update(frame_data, jpeg_cache, width, height, is_mjpeg);
                    frame_count += 1;
                }
                Err(e) => {
                    eprintln!("[WEBCAM] Frame capture error: {}", e);
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        // Cleanup
        WEBCAM_BUFFER.set_active(false);
        WEBCAM_BUFFER.clear();
        let _ = camera.stop_stream();
        Ok(())
    }
}

/// Global capture thread handle.
static CAPTURE_STOP_FLAG: parking_lot::RwLock<Option<Arc<AtomicBool>>> =
    parking_lot::RwLock::new(None);
static CAPTURE_THREAD: parking_lot::Mutex<Option<std::thread::JoinHandle<()>>> =
    parking_lot::Mutex::new(None);
static CAPTURE_DEVICE_INDEX: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(usize::MAX);

/// Start the global webcam capture service.
/// If already running with the same device, this is a no-op.
pub fn start_capture_service(device_index: usize) -> Result<(), String> {
    // Check if already running with same device
    let current_device = CAPTURE_DEVICE_INDEX.load(Ordering::SeqCst);
    if current_device == device_index && is_capture_running() {
        eprintln!(
            "[WEBCAM] Capture already running for device {}, skipping start",
            device_index
        );
        return Ok(());
    }

    // Stop existing capture if any (different device or not running properly)
    stop_capture_service();

    // Store the device index we're starting
    CAPTURE_DEVICE_INDEX.store(device_index, Ordering::SeqCst);

    let service = WebcamCaptureService::new(device_index);
    let stop_flag = service.stop_flag();

    // Store stop flag for later
    *CAPTURE_STOP_FLAG.write() = Some(stop_flag);

    // Spawn capture thread
    let handle = std::thread::Builder::new()
        .name("webcam-capture".to_string())
        .spawn(move || {
            if let Err(e) = service.run() {
                eprintln!("[WEBCAM] Capture service error: {}", e);
            }
        })
        .map_err(|e| format!("Failed to spawn webcam thread: {}", e))?;

    *CAPTURE_THREAD.lock() = Some(handle);

    // Brief delay to let camera thread start - sync is handled by encoder
    std::thread::sleep(std::time::Duration::from_millis(50));
    Ok(())
}

/// Stop the global webcam capture service.
pub fn stop_capture_service() {
    // Reset device index
    CAPTURE_DEVICE_INDEX.store(usize::MAX, Ordering::SeqCst);

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

/// Enumerate available webcam devices.
pub fn enumerate_devices() -> Result<Vec<(usize, String)>, String> {
    use nokhwa::native_api_backend;
    use nokhwa::query;

    let backend = native_api_backend().ok_or_else(|| "No camera backend available".to_string())?;

    let devices = query(backend).map_err(|e| format!("Failed to query devices: {}", e))?;

    let result: Vec<(usize, String)> = devices
        .iter()
        .enumerate()
        .map(|(idx, info)| (idx, info.human_name().to_string()))
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

        // Add a frame (data, jpeg_cache, width, height, is_mjpeg)
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
