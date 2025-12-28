//! Windows Graphics Capture API implementation.
//!
//! Provides high-quality window capture with full transparency (alpha channel) support.
//! Uses the modern Windows.Graphics.Capture API available on Windows 10 1903+.

#![allow(dead_code)]

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// Track consecutive WGC failures for window capture.
/// If too many failures, we skip WGC entirely to save time.
static WGC_WINDOW_CONSECUTIVE_FAILURES: AtomicU32 = AtomicU32::new(0);
static WGC_WINDOW_EVER_SUCCEEDED: AtomicBool = AtomicBool::new(false);
const WGC_MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// Maximum frames to skip before giving up (for WithoutBorder mode)
const MAX_BLANK_FRAMES_TO_SKIP: usize = 10;

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
};

use super::types::{CaptureError, CaptureResult};

/// Message sent from capture handler to main thread.
type CaptureMessage = Result<(Vec<u8>, u32, u32), String>;

/// Check if a frame has valid content (not all transparent or all black).
/// Returns the percentage of non-empty pixels.
fn frame_content_ratio(data: &[u8]) -> f64 {
    let total_pixels = data.len() / 4;
    if total_pixels == 0 {
        return 0.0;
    }

    // Count pixels that have actual content (not black, not transparent)
    let content_pixels = data
        .chunks_exact(4)
        .filter(|p| {
            // Has alpha and has some color
            p[3] > 0 && (p[0] != 0 || p[1] != 0 || p[2] != 0)
        })
        .count();

    content_pixels as f64 / total_pixels as f64
}

/// Handler for single-frame capture using Windows Graphics Capture API.
/// Skips initial blank frames when using WithoutBorder mode.
struct SingleFrameCapture {
    tx: mpsc::SyncSender<CaptureMessage>,
    frame_count: AtomicUsize,
}

impl GraphicsCaptureApiHandler for SingleFrameCapture {
    type Flags = mpsc::SyncSender<CaptureMessage>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags,
            frame_count: AtomicUsize::new(0),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let count = self.frame_count.fetch_add(1, Ordering::Relaxed);

        // Get frame dimensions
        let width = frame.width();
        let height = frame.height();

        // Get frame buffer - use as_nopadding_buffer which handles stride automatically
        let buffer = frame.buffer().map_err(|e| e.to_string())?;
        let mut raw_data = Vec::new();
        let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);

        let expected_size = (width * height * 4) as usize;
        println!("[WGC] Frame {}: buffer={} bytes, expected={} bytes, {}x{}",
            count + 1, pixel_data.len(), expected_size, width, height);

        if pixel_data.is_empty() {
            return Ok(()); // Wait for next frame
        }

        // If buffer size doesn't match, recalculate dimensions from buffer
        let (actual_width, actual_height) = if pixel_data.len() != expected_size && pixel_data.len() % 4 == 0 {
            // Buffer has different size - try to figure out actual dimensions
            // Assume width is correct, calculate actual height
            let actual_h = pixel_data.len() / (width as usize * 4);
            println!("[WGC] Size mismatch! Using actual height: {}", actual_h);
            (width, actual_h as u32)
        } else {
            (width, height)
        };

        // WGC returns BGRA, convert to RGBA
        let rgba_data: Vec<u8> = pixel_data
            .chunks_exact(4)
            .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]])
            .collect();

        // Check if frame has valid content
        let content_ratio = frame_content_ratio(&rgba_data);
        println!("[WGC] Frame {}: {}% content, final size {}x{}",
            count + 1, (content_ratio * 100.0) as i32, actual_width, actual_height);

        if content_ratio > 0.01 {
            // Valid frame - send and stop
            println!("[WGC] Valid frame found at frame {}", count + 1);
            let _ = self.tx.send(Ok((rgba_data, actual_width, actual_height)));
            capture_control.stop();
        } else if count >= MAX_BLANK_FRAMES_TO_SKIP {
            // Too many blank frames - send last frame anyway
            println!("[WGC] Max frames reached, sending frame {}", count + 1);
            let _ = self.tx.send(Ok((rgba_data, actual_width, actual_height)));
            capture_control.stop();
        }
        // Otherwise, continue waiting for next frame (don't stop capture)

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
    let window = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);

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

/// Trim transparent borders from RGBA image data.
/// Returns (trimmed_data, new_width, new_height, left_offset, top_offset)
fn trim_transparent_borders(data: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let w = width as usize;
    let h = height as usize;

    // Find bounds of non-transparent content
    let mut min_x = w;
    let mut max_x = 0;
    let mut min_y = h;
    let mut max_y = 0;

    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) * 4;
            let alpha = data.get(idx + 3).copied().unwrap_or(0);
            if alpha > 0 {
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }

    // If no non-transparent pixels found, return original
    if min_x >= max_x || min_y >= max_y {
        return (data.to_vec(), width, height);
    }

    let new_w = max_x - min_x + 1;
    let new_h = max_y - min_y + 1;

    // Only trim if we're removing more than 2 pixels from any edge
    let left_trim = min_x;
    let top_trim = min_y;
    let right_trim = w - max_x - 1;
    let bottom_trim = h - max_y - 1;

    if left_trim <= 2 && top_trim <= 2 && right_trim <= 2 && bottom_trim <= 2 {
        // Minimal trimming, keep original
        return (data.to_vec(), width, height);
    }

    println!("[WGC] Trimming borders: left={}, top={}, right={}, bottom={}",
        left_trim, top_trim, right_trim, bottom_trim);

    // Extract trimmed region
    let mut trimmed = Vec::with_capacity(new_w * new_h * 4);
    for y in min_y..=max_y {
        let row_start = (y * w + min_x) * 4;
        let row_end = row_start + new_w * 4;
        trimmed.extend_from_slice(&data[row_start..row_end]);
    }

    (trimmed, new_w as u32, new_h as u32)
}

/// Capture a window and return raw RGBA data (skips PNG encoding).
/// This is the fast path for editor display.
pub fn capture_window_raw(hwnd: isize) -> Result<(Vec<u8>, u32, u32), CaptureError> {
    // Skip WGC if it has been consistently failing
    if should_skip_wgc_window_capture() {
        return Err(CaptureError::CaptureFailed("WGC disabled due to repeated failures".into()));
    }

    // Timeout increased to allow for frame skipping when using WithoutBorder mode
    // WGC may return blank initial frames that we need to skip
    match try_capture_window(hwnd, Duration::from_millis(1000)) {
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

            // Trim any transparent borders from window capture
            let (trimmed_data, trimmed_width, trimmed_height) =
                trim_transparent_borders(&rgba_data, width, height);

            Ok((trimmed_data, trimmed_width, trimmed_height))
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
    let monitors = Monitor::enumerate()
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
    Monitor::enumerate().is_ok()
}
