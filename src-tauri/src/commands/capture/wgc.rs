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

/// Apply rounded corners with anti-aliased transparency.
fn apply_rounded_corners(image: &mut RgbaImage, radius: u32) {
    let width = image.width();
    let height = image.height();
    let radius = radius.min(width / 2).min(height / 2);

    if radius == 0 {
        return;
    }

    let radius_f = radius as f64;

    for y in 0..radius {
        for x in 0..radius {
            let corners = [
                (x, y),                          // Top-left
                (width - 1 - x, y),              // Top-right
                (x, height - 1 - y),             // Bottom-left
                (width - 1 - x, height - 1 - y), // Bottom-right
            ];

            let dx = radius_f - x as f64 - 0.5;
            let dy = radius_f - y as f64 - 0.5;
            let dist = (dx * dx + dy * dy).sqrt();

            let alpha = if dist > radius_f {
                0u8
            } else if dist > radius_f - 1.5 {
                ((radius_f - dist) / 1.5 * 255.0) as u8
            } else {
                255u8
            };

            for (cx, cy) in corners {
                let pixel = image.get_pixel_mut(cx, cy);
                let current_alpha = pixel[3] as u16;
                pixel[3] = ((current_alpha * alpha as u16) / 255) as u8;
            }
        }
    }
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

/// Encode RGBA image data to PNG with rounded corners applied.
fn encode_rgba_to_png_with_corners(
    data: Vec<u8>,
    width: u32,
    height: u32,
    corner_radius: u32,
) -> Result<Vec<u8>, CaptureError> {
    let mut image = RgbaImage::from_raw(width, height, data)
        .ok_or_else(|| CaptureError::EncodingFailed("Failed to create image from buffer".into()))?;

    apply_rounded_corners(&mut image, corner_radius);

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

    // Encode to PNG with rounded corners (Windows 11 style, 8px radius)
    let png_data = encode_rgba_to_png_with_corners(rgba_data, width, height, 8)?;
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
