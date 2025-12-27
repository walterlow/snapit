//! Webcam preview service - single-source capture for both preview and recording.
//!
//! This service captures webcam frames and can emit them to the frontend for preview
//! while also providing frames for recording. This avoids the hardware conflict
//! where browser's getUserMedia and nokhwa cannot share the webcam simultaneously.

use super::device::camera_index_from_device;
use super::WebcamFrame;
use image::ImageBuffer;
use nokhwa::pixel_format::RgbAFormat;
use nokhwa::utils::{RequestedFormat, RequestedFormatType};
use nokhwa::Camera;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Preview frame rate (lower than recording to save bandwidth)
const PREVIEW_FPS: u32 = 24;

/// Preview JPEG quality (lower = faster encoding, smaller size)
const PREVIEW_JPEG_QUALITY: u8 = 50;

/// Maximum consecutive frame capture errors before giving up.
const MAX_CONSECUTIVE_ERRORS: u32 = 30;

/// Global webcam preview service instance
static PREVIEW_SERVICE: RwLock<Option<WebcamPreviewService>> = RwLock::new(None);

/// Webcam preview frame event payload
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamPreviewFrame {
    /// Base64-encoded JPEG image data
    pub data: String,
    /// Frame width
    pub width: u32,
    /// Frame height
    pub height: u32,
}

/// Webcam preview service that captures frames and emits them to frontend.
pub struct WebcamPreviewService {
    /// Latest captured frame (for recording to use)
    frame_buffer: Arc<Mutex<Option<WebcamFrame>>>,
    /// Signal to stop the capture thread
    should_stop: Arc<AtomicBool>,
    /// Whether capture has encountered a fatal error
    has_error: Arc<AtomicBool>,
    /// Error message if capture failed
    error_message: Arc<Mutex<Option<String>>>,
    /// Consecutive error count
    error_count: Arc<AtomicU32>,
    /// Capture thread handle
    capture_thread: Option<JoinHandle<()>>,
    /// Device index being captured
    device_index: usize,
    /// Whether to mirror the image
    mirror: bool,
    /// Whether preview emission is enabled
    preview_enabled: Arc<AtomicBool>,
}

impl WebcamPreviewService {
    /// Create and start a new webcam preview service.
    fn new(
        app: AppHandle,
        device_index: usize,
        mirror: bool,
    ) -> Result<Self, String> {
        let frame_buffer = Arc::new(Mutex::new(None));
        let should_stop = Arc::new(AtomicBool::new(false));
        let has_error = Arc::new(AtomicBool::new(false));
        let error_message = Arc::new(Mutex::new(None));
        let error_count = Arc::new(AtomicU32::new(0));
        let preview_enabled = Arc::new(AtomicBool::new(true));

        let mut service = Self {
            frame_buffer,
            should_stop,
            has_error,
            error_message,
            error_count,
            capture_thread: None,
            device_index,
            mirror,
            preview_enabled,
        };

        service.start(app)?;
        Ok(service)
    }

    /// Start the capture thread.
    fn start(&mut self, app: AppHandle) -> Result<(), String> {
        if self.capture_thread.is_some() {
            return Err("Webcam preview already started".to_string());
        }

        let frame_buffer = Arc::clone(&self.frame_buffer);
        let should_stop = Arc::clone(&self.should_stop);
        let has_error = Arc::clone(&self.has_error);
        let error_message = Arc::clone(&self.error_message);
        let error_count = Arc::clone(&self.error_count);
        let preview_enabled = Arc::clone(&self.preview_enabled);
        let device_index = self.device_index;
        let mirror = self.mirror;

        let handle = thread::Builder::new()
            .name("webcam-preview".to_string())
            .spawn(move || {
                if let Err(e) = run_preview_loop(
                    app,
                    frame_buffer,
                    should_stop,
                    has_error,
                    error_message,
                    error_count,
                    preview_enabled,
                    device_index,
                    mirror,
                ) {
                    eprintln!("[WEBCAM-PREVIEW] Thread error: {}", e);
                }
            })
            .map_err(|e| format!("Failed to spawn webcam preview thread: {}", e))?;

        self.capture_thread = Some(handle);
        eprintln!("[WEBCAM-PREVIEW] Started for device {}", device_index);

        Ok(())
    }

    /// Stop the capture thread.
    fn stop(&mut self) {
        self.should_stop.store(true, Ordering::SeqCst);

        if let Some(handle) = self.capture_thread.take() {
            eprintln!("[WEBCAM-PREVIEW] Stopping...");
            let _ = handle.join();
            eprintln!("[WEBCAM-PREVIEW] Stopped");
        }
    }

    /// Get the latest captured frame (for recording).
    pub fn get_latest_frame(&self) -> Option<WebcamFrame> {
        self.frame_buffer.lock().ok()?.clone()
    }

    /// Check if the webcam has encountered a fatal error.
    pub fn has_error(&self) -> bool {
        self.has_error.load(Ordering::SeqCst)
    }

    /// Get the error message if capture failed.
    pub fn get_error_message(&self) -> Option<String> {
        if self.has_error.load(Ordering::SeqCst) {
            self.error_message.lock().ok()?.clone()
        } else {
            None
        }
    }

    /// Enable or disable preview frame emission (recording can disable to save CPU).
    pub fn set_preview_enabled(&self, enabled: bool) {
        self.preview_enabled.store(enabled, Ordering::SeqCst);
    }
}

impl Drop for WebcamPreviewService {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Run the webcam capture and preview loop.
fn run_preview_loop(
    app: AppHandle,
    frame_buffer: Arc<Mutex<Option<WebcamFrame>>>,
    should_stop: Arc<AtomicBool>,
    has_error: Arc<AtomicBool>,
    error_message: Arc<Mutex<Option<String>>>,
    error_count: Arc<AtomicU32>,
    preview_enabled: Arc<AtomicBool>,
    device_index: usize,
    mirror: bool,
) -> Result<(), String> {
    // Initialize the camera - use default resolution for recording quality
    // The webcam overlay is composited onto recordings at this resolution
    let index = camera_index_from_device(device_index);
    let requested = RequestedFormat::new::<RgbAFormat>(RequestedFormatType::None);

    let mut camera = Camera::new(index, requested).map_err(|e| {
        let msg = format!("Failed to open webcam: {}", e);
        set_error(&has_error, &error_message, &msg);
        // Emit error to frontend
        let _ = app.emit("webcam-preview-error", serde_json::json!({ "message": msg }));
        msg
    })?;

    camera.open_stream().map_err(|e| {
        let msg = format!("Failed to open webcam stream: {}", e);
        set_error(&has_error, &error_message, &msg);
        let _ = app.emit("webcam-preview-error", serde_json::json!({ "message": msg }));
        msg
    })?;

    let width = camera.resolution().width();
    let height = camera.resolution().height();

    eprintln!(
        "[WEBCAM-PREVIEW] Camera opened: {} ({}x{})",
        camera.info().human_name(),
        width,
        height
    );

    // Emit ready event with dimensions
    let _ = app.emit(
        "webcam-preview-ready",
        serde_json::json!({ "width": width, "height": height }),
    );

    let frame_interval = Duration::from_millis(1000 / PREVIEW_FPS as u64);
    let mut last_preview_emit = Instant::now();

    // Capture loop
    while !should_stop.load(Ordering::SeqCst) && !has_error.load(Ordering::SeqCst) {
        match camera.frame() {
            Ok(frame) => {
                // Reset error count on success
                error_count.store(0, Ordering::SeqCst);

                // Decode frame to RGBA
                let decoded = frame.decode_image::<RgbAFormat>();

                match decoded {
                    Ok(image) => {
                        // Convert to BGRA for compositing
                        let mut bgra_data = rgba_to_bgra(image.as_raw());

                        // Mirror if requested
                        if mirror {
                            mirror_horizontal(&mut bgra_data, width, height);
                        }

                        let webcam_frame = WebcamFrame {
                            bgra_data: bgra_data.clone(),
                            width,
                            height,
                        };

                        // Update frame buffer (for recording)
                        if let Ok(mut buffer) = frame_buffer.lock() {
                            *buffer = Some(webcam_frame);
                        }

                        // Emit preview frame at reduced rate
                        if preview_enabled.load(Ordering::SeqCst)
                            && last_preview_emit.elapsed() >= frame_interval
                        {
                            last_preview_emit = Instant::now();

                            // Convert BGRA to JPEG and base64 encode
                            if let Some(jpeg_base64) = encode_frame_as_jpeg(&bgra_data, width, height) {
                                let preview_frame = WebcamPreviewFrame {
                                    data: jpeg_base64,
                                    width,
                                    height,
                                };
                                let _ = app.emit("webcam-preview-frame", preview_frame);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[WEBCAM-PREVIEW] Frame decode error: {}", e);
                    }
                }
            }
            Err(e) => {
                let current_errors = error_count.fetch_add(1, Ordering::SeqCst) + 1;

                if current_errors >= MAX_CONSECUTIVE_ERRORS {
                    let msg = format!(
                        "Webcam capture failed after {} errors. Last: {}",
                        current_errors, e
                    );
                    eprintln!("[WEBCAM-PREVIEW] FATAL: {}", msg);
                    set_error(&has_error, &error_message, &msg);
                    let _ = app.emit("webcam-preview-error", serde_json::json!({ "message": msg }));
                    break;
                } else if current_errors == 1 || current_errors % 10 == 0 {
                    eprintln!(
                        "[WEBCAM-PREVIEW] Frame error ({}/{}): {}",
                        current_errors, MAX_CONSECUTIVE_ERRORS, e
                    );
                }

                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    // Clean up
    let _ = camera.stop_stream();
    eprintln!("[WEBCAM-PREVIEW] Camera stream closed");

    Ok(())
}

/// Set error state.
fn set_error(
    has_error: &Arc<AtomicBool>,
    error_message: &Arc<Mutex<Option<String>>>,
    message: &str,
) {
    has_error.store(true, Ordering::SeqCst);
    if let Ok(mut msg) = error_message.lock() {
        *msg = Some(message.to_string());
    }
}

/// Convert RGBA to BGRA.
fn rgba_to_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut bgra = Vec::with_capacity(rgba.len());
    for chunk in rgba.chunks_exact(4) {
        bgra.push(chunk[2]); // B <- R
        bgra.push(chunk[1]); // G
        bgra.push(chunk[0]); // R <- B
        bgra.push(chunk[3]); // A
    }
    bgra
}

/// Mirror image horizontally.
fn mirror_horizontal(bgra: &mut [u8], width: u32, height: u32) {
    let row_size = (width * 4) as usize;
    for y in 0..height as usize {
        let row_start = y * row_size;
        let row = &mut bgra[row_start..row_start + row_size];
        for x in 0..(width / 2) as usize {
            let left_idx = x * 4;
            let right_idx = (width as usize - 1 - x) * 4;
            for i in 0..4 {
                row.swap(left_idx + i, right_idx + i);
            }
        }
    }
}

/// Maximum dimension for preview encoding (downsample large frames for speed)
const PREVIEW_MAX_DIM: u32 = 320;

/// Encode BGRA frame as JPEG and return base64 string.
/// Downsamples large frames for faster encoding.
fn encode_frame_as_jpeg(bgra: &[u8], width: u32, height: u32) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;

    // Convert BGRA to RGB (skip alpha - JPEG doesn't need it)
    let mut rgb = Vec::with_capacity((bgra.len() / 4) * 3);
    for chunk in bgra.chunks_exact(4) {
        rgb.push(chunk[2]); // R <- B
        rgb.push(chunk[1]); // G
        rgb.push(chunk[0]); // B <- R
    }

    let img: ImageBuffer<image::Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgb)?;

    // Downsample if larger than preview max dimension
    let img = if width > PREVIEW_MAX_DIM || height > PREVIEW_MAX_DIM {
        let scale = PREVIEW_MAX_DIM as f32 / width.max(height) as f32;
        let new_w = (width as f32 * scale) as u32;
        let new_h = (height as f32 * scale) as u32;
        image::imageops::resize(&img, new_w, new_h, FilterType::Nearest)
    } else {
        img
    };

    // Encode as JPEG with lower quality for speed
    let mut jpeg_data = Cursor::new(Vec::with_capacity(8192));
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_data, PREVIEW_JPEG_QUALITY);
    encoder.encode_image(&img).ok()?;

    // Base64 encode
    let base64_str = STANDARD.encode(jpeg_data.into_inner());
    Some(format!("data:image/jpeg;base64,{}", base64_str))
}

// ============================================================================
// Public API - Global preview service management
// ============================================================================

/// Start the webcam preview service.
pub fn start_preview_service(
    app: AppHandle,
    device_index: usize,
    mirror: bool,
) -> Result<(), String> {
    let mut guard = PREVIEW_SERVICE.write().map_err(|e| e.to_string())?;

    // Stop existing service if any
    if let Some(mut service) = guard.take() {
        service.stop();
    }

    // Start new service
    let service = WebcamPreviewService::new(app, device_index, mirror)?;
    *guard = Some(service);

    Ok(())
}

/// Stop the webcam preview service.
pub fn stop_preview_service() {
    if let Ok(mut guard) = PREVIEW_SERVICE.write() {
        if let Some(mut service) = guard.take() {
            service.stop();
        }
    }
}

/// Get the latest frame from the preview service (for recording).
pub fn get_preview_frame() -> Option<WebcamFrame> {
    let guard = PREVIEW_SERVICE.read().ok()?;
    guard.as_ref()?.get_latest_frame()
}

/// Check if preview service has an error.
pub fn preview_has_error() -> bool {
    if let Ok(guard) = PREVIEW_SERVICE.read() {
        if let Some(service) = guard.as_ref() {
            return service.has_error();
        }
    }
    false
}

/// Get preview service error message.
pub fn get_preview_error() -> Option<String> {
    let guard = PREVIEW_SERVICE.read().ok()?;
    guard.as_ref()?.get_error_message()
}

/// Check if preview service is running.
pub fn is_preview_running() -> bool {
    if let Ok(guard) = PREVIEW_SERVICE.read() {
        return guard.is_some();
    }
    false
}

/// Enable or disable preview frame emission.
pub fn set_preview_emission_enabled(enabled: bool) {
    if let Ok(guard) = PREVIEW_SERVICE.read() {
        if let Some(service) = guard.as_ref() {
            service.set_preview_enabled(enabled);
        }
    }
}
