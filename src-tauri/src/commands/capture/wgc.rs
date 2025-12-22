//! Windows Graphics Capture API implementation.
//!
//! Provides high-quality window capture with full transparency (alpha channel) support.
//! Uses the modern Windows.Graphics.Capture API available on Windows 10 1903+.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// Track consecutive WGC failures for window capture.
/// If too many failures, we skip WGC entirely to save time.
static WGC_WINDOW_CONSECUTIVE_FAILURES: AtomicU32 = AtomicU32::new(0);
static WGC_WINDOW_EVER_SUCCEEDED: AtomicBool = AtomicBool::new(false);
const WGC_MAX_CONSECUTIVE_FAILURES: u32 = 3;

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor as WgcMonitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window as WgcWindow,
};

use super::types::{CaptureError, CaptureResult};

/// Message sent from capture handler to main thread.
type CaptureMessage = Result<(Vec<u8>, u32, u32), String>;

/// Handler for single-frame capture using Windows Graphics Capture API.
struct SingleFrameCapture {
    tx: mpsc::SyncSender<CaptureMessage>,
}

impl GraphicsCaptureApiHandler for SingleFrameCapture {
    type Flags = mpsc::SyncSender<CaptureMessage>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { tx: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Get frame buffer with RGBA data (includes alpha channel)
        let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
        let width = buffer.width();
        let height = buffer.height();

        // Get raw pixel data without padding
        let data = buffer
            .as_nopadding_buffer()
            .map_err(|e| e.to_string())?
            .to_vec();

        // Send result and stop capture
        let _ = self.tx.send(Ok((data, width, height)));
        capture_control.stop();

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Check if captured image is mostly transparent (failed capture of elevated window).
/// Returns true if more than 80% of pixels are fully transparent.
fn is_mostly_transparent(data: &[u8], width: u32, height: u32) -> bool {
    let total_pixels = (width * height) as usize;
    if total_pixels == 0 {
        return true;
    }
    
    // Count fully transparent pixels (alpha = 0)
    let transparent_count = data
        .chunks(4)
        .filter(|pixel| pixel.len() == 4 && pixel[3] == 0)
        .count();
    
    let transparent_ratio = transparent_count as f64 / total_pixels as f64;
    transparent_ratio > 0.8
}

/// Encode RGBA image data to PNG with transparency preserved.
fn encode_rgba_to_png(data: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, CaptureError> {
    let image = RgbaImage::from_raw(width, height, data)
        .ok_or_else(|| CaptureError::EncodingFailed("Failed to create image from buffer".into()))?;

    let dynamic_image = DynamicImage::ImageRgba8(image);

    let mut buffer = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| CaptureError::EncodingFailed(e.to_string()))?;

    Ok(buffer.into_inner())
}

/// Attempt a single WGC capture.
fn try_capture_window(hwnd: isize, timeout: Duration) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let window = WgcWindow::from_raw_hwnd(hwnd as *mut std::ffi::c_void);

    // Validate window
    if !window.is_valid() {
        return Err(CaptureError::WindowNotFound);
    }

    let (tx, rx) = mpsc::sync_channel::<CaptureMessage>(1);

    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        tx,
    );

    // Run capture in a separate thread (WGC may need specific thread requirements)
    let handle = std::thread::spawn(move || {
        SingleFrameCapture::start(settings)
    });

    // Wait for result with shorter timeout (500ms should be plenty for a single frame)
    let result = rx
        .recv_timeout(timeout)
        .map_err(|_| CaptureError::CaptureFailed("Capture timeout".into()))?
        .map_err(|e| CaptureError::CaptureFailed(e))?;

    // Wait for capture thread to finish
    let _ = handle.join();

    Ok(result)
}

/// Capture a window using Windows Graphics Capture API with full transparency support.
/// Includes retry logic for transient failures.
pub fn capture_window(hwnd: isize) -> Result<CaptureResult, CaptureError> {
    let (rgba_data, width, height) = capture_window_raw(hwnd)?;

    // Encode to PNG and base64
    let png_data = encode_rgba_to_png(rgba_data, width, height)?;
    let base64_data = STANDARD.encode(&png_data);

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency: true,
    })
}

/// Check if WGC window capture should be skipped due to repeated failures.
pub fn should_skip_wgc_window_capture() -> bool {
    // If WGC has never succeeded and we've had too many failures, skip it
    let never_succeeded = !WGC_WINDOW_EVER_SUCCEEDED.load(Ordering::Relaxed);
    let too_many_failures = WGC_WINDOW_CONSECUTIVE_FAILURES.load(Ordering::Relaxed) >= WGC_MAX_CONSECUTIVE_FAILURES;
    never_succeeded && too_many_failures
}

/// Capture a window and return raw RGBA data (skips PNG encoding).
/// This is the fast path for editor display.
pub fn capture_window_raw(hwnd: isize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    // Skip WGC if it has been consistently failing
    if should_skip_wgc_window_capture() {
        return Err(CaptureError::CaptureFailed("WGC disabled due to repeated failures".into()));
    }

    // Single attempt with short timeout - WGC either works quickly or doesn't work at all
    // Reduced from 500ms to 150ms since we want to fail fast to xcap fallback
    match try_capture_window(hwnd, Duration::from_millis(150)) {
        Ok((rgba_data, width, height)) => {
            // Validate dimensions are reasonable
            if width == 0 || height == 0 {
                WGC_WINDOW_CONSECUTIVE_FAILURES.fetch_add(1, Ordering::Relaxed);
                return Err(CaptureError::CaptureFailed("Invalid dimensions".into()));
            }

            // Check if capture returned mostly transparent content (elevated window issue)
            if is_mostly_transparent(&rgba_data, width, height) {
                WGC_WINDOW_CONSECUTIVE_FAILURES.fetch_add(1, Ordering::Relaxed);
                return Err(CaptureError::CaptureFailed(
                    "Captured content is mostly transparent (possible elevated window)".into(),
                ));
            }

            // Success! Reset failure count and mark as having succeeded
            WGC_WINDOW_CONSECUTIVE_FAILURES.store(0, Ordering::Relaxed);
            WGC_WINDOW_EVER_SUCCEEDED.store(true, Ordering::Relaxed);
            Ok((rgba_data, width, height))
        }
        Err(e) => {
            WGC_WINDOW_CONSECUTIVE_FAILURES.fetch_add(1, Ordering::Relaxed);
            Err(e)
        }
    }
}

/// Capture a monitor using Windows Graphics Capture API.
pub fn capture_monitor(monitor_index: usize) -> Result<CaptureResult, CaptureError> {
    let (rgba_data, width, height) = capture_monitor_raw(monitor_index)?;

    let png_data = encode_rgba_to_png(rgba_data, width, height)?;
    let base64_data = STANDARD.encode(&png_data);

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency: false, // Monitor captures don't have meaningful transparency
    })
}

/// Capture a monitor and return raw RGBA data (skips PNG encoding).
pub fn capture_monitor_raw(monitor_index: usize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    let monitors = WgcMonitor::enumerate()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to enumerate monitors: {}", e)))?;

    let monitor = monitors
        .get(monitor_index)
        .ok_or(CaptureError::MonitorNotFound)?
        .clone();

    let (tx, rx) = mpsc::sync_channel::<CaptureMessage>(1);

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        tx,
    );

    let handle = std::thread::spawn(move || SingleFrameCapture::start(settings));

    let result = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| CaptureError::CaptureFailed("Capture timeout".into()))?
        .map_err(|e| CaptureError::CaptureFailed(e))?;

    let _ = handle.join();

    Ok(result)
}

/// Check if Windows Graphics Capture API is available.
pub fn is_available() -> bool {
    // WGC requires Windows 10 1903 (build 18362) or later
    // The windows-capture crate handles this internally, but we can do a quick check
    WgcMonitor::enumerate().is_ok()
}
