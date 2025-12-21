//! Windows Graphics Capture API implementation.
//!
//! Provides high-quality window capture with full transparency (alpha channel) support.
//! Uses the modern Windows.Graphics.Capture API available on Windows 10 1903+.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use std::sync::mpsc;
use std::time::Duration;

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

/// Capture a window using Windows Graphics Capture API with full transparency support.
pub fn capture_window(hwnd: isize) -> Result<CaptureResult, CaptureError> {
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
        ColorFormat::Rgba8, // Full alpha channel support
        tx,
    );

    // Run capture in a separate thread (WGC may need specific thread requirements)
    let handle = std::thread::spawn(move || SingleFrameCapture::start(settings));

    // Wait for result with timeout
    let result = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| CaptureError::CaptureFailed("Capture timeout".into()))?
        .map_err(|e| CaptureError::CaptureFailed(e))?;

    // Wait for capture thread to finish
    let _ = handle.join();

    let (rgba_data, width, height) = result;

    // Check if capture returned mostly transparent content (elevated window issue)
    if is_mostly_transparent(&rgba_data, width, height) {
        return Err(CaptureError::CaptureFailed(
            "Captured content is mostly transparent (possible elevated window)".into(),
        ));
    }

    // Note: Rounded corners are handled by the compositor/editor, not here
    let png_data = encode_rgba_to_png(rgba_data, width, height)?;
    let base64_data = STANDARD.encode(&png_data);

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency: true,
    })
}

/// Capture a monitor using Windows Graphics Capture API.
pub fn capture_monitor(monitor_index: usize) -> Result<CaptureResult, CaptureError> {
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

    let (rgba_data, width, height) = result;

    let png_data = encode_rgba_to_png(rgba_data, width, height)?;
    let base64_data = STANDARD.encode(&png_data);

    Ok(CaptureResult {
        image_data: base64_data,
        width,
        height,
        has_transparency: false, // Monitor captures don't have meaningful transparency
    })
}

/// Check if Windows Graphics Capture API is available.
pub fn is_available() -> bool {
    // WGC requires Windows 10 1903 (build 18362) or later
    // The windows-capture crate handles this internally, but we can do a quick check
    WgcMonitor::enumerate().is_ok()
}
