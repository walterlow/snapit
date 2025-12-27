//! Webcam capture implementation using nokhwa.
//!
//! Provides threaded webcam capture with frame buffering for PiP overlay.

use super::device::camera_index_from_device;
use super::WebcamFrame;
use nokhwa::pixel_format::RgbAFormat;
use nokhwa::utils::RequestedFormat;
use nokhwa::Camera;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Webcam capture manager.
///
/// Captures frames from a webcam in a background thread and provides
/// the latest frame for compositing onto recorded video.
pub struct WebcamCapture {
    /// Latest captured frame (double-buffered).
    frame_buffer: Arc<Mutex<Option<WebcamFrame>>>,
    /// Signal to stop the capture thread.
    should_stop: Arc<AtomicBool>,
    /// Capture thread handle.
    capture_thread: Option<JoinHandle<()>>,
    /// Device index being captured.
    device_index: usize,
    /// Whether to mirror the image horizontally.
    mirror: bool,
}

impl WebcamCapture {
    /// Create a new webcam capture for the given device.
    ///
    /// # Arguments
    /// * `device_index` - Index of the webcam device to capture.
    /// * `_fps` - Target frames per second (reserved for future use).
    /// * `mirror` - Whether to flip the image horizontally.
    pub fn new(device_index: usize, _fps: u32, mirror: bool) -> Result<Self, String> {
        let frame_buffer = Arc::new(Mutex::new(None));
        let should_stop = Arc::new(AtomicBool::new(false));

        let capture = Self {
            frame_buffer,
            should_stop,
            capture_thread: None,
            device_index,
            mirror,
        };

        Ok(capture)
    }

    /// Start capturing frames in a background thread.
    pub fn start(&mut self) -> Result<(), String> {
        if self.capture_thread.is_some() {
            return Err("Webcam capture already started".to_string());
        }

        let frame_buffer = Arc::clone(&self.frame_buffer);
        let should_stop = Arc::clone(&self.should_stop);
        let device_index = self.device_index;
        let mirror = self.mirror;

        let handle = thread::Builder::new()
            .name("webcam-capture".to_string())
            .spawn(move || {
                if let Err(e) = run_capture_loop(frame_buffer, should_stop, device_index, mirror) {
                    eprintln!("[WEBCAM] Capture thread error: {}", e);
                }
            })
            .map_err(|e| format!("Failed to spawn webcam capture thread: {}", e))?;

        self.capture_thread = Some(handle);
        eprintln!("[WEBCAM] Capture thread started for device {}", device_index);

        Ok(())
    }

    /// Stop the capture thread.
    pub fn stop(&mut self) {
        self.should_stop.store(true, Ordering::SeqCst);

        if let Some(handle) = self.capture_thread.take() {
            eprintln!("[WEBCAM] Stopping capture thread...");
            let _ = handle.join();
            eprintln!("[WEBCAM] Capture thread stopped");
        }
    }

    /// Get the latest captured frame (non-blocking).
    ///
    /// Returns None if no frame is available yet.
    pub fn get_latest_frame(&self) -> Option<WebcamFrame> {
        self.frame_buffer.lock().ok()?.clone()
    }

    /// Check if the capture thread is running.
    pub fn is_running(&self) -> bool {
        self.capture_thread.is_some() && !self.should_stop.load(Ordering::SeqCst)
    }
}

impl Drop for WebcamCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Run the webcam capture loop.
fn run_capture_loop(
    frame_buffer: Arc<Mutex<Option<WebcamFrame>>>,
    should_stop: Arc<AtomicBool>,
    device_index: usize,
    mirror: bool,
) -> Result<(), String> {
    use nokhwa::utils::RequestedFormatType;

    // Initialize the camera
    let index = camera_index_from_device(device_index);

    // Request any format, let nokhwa choose the best available
    let requested = RequestedFormat::new::<RgbAFormat>(RequestedFormatType::None);

    let mut camera = Camera::new(index, requested)
        .map_err(|e| format!("Failed to open webcam: {}", e))?;

    camera.open_stream()
        .map_err(|e| format!("Failed to open webcam stream: {}", e))?;

    eprintln!(
        "[WEBCAM] Camera opened: {} ({}x{})",
        camera.info().human_name(),
        camera.resolution().width(),
        camera.resolution().height()
    );

    let actual_width = camera.resolution().width();
    let actual_height = camera.resolution().height();

    // Capture loop
    while !should_stop.load(Ordering::SeqCst) {
        match camera.frame() {
            Ok(frame) => {
                // Decode frame to RGBA
                let decoded = frame.decode_image::<RgbAFormat>();

                match decoded {
                    Ok(image) => {
                        // Convert to BGRA (our compositing format)
                        let mut bgra_data = rgba_to_bgra(image.as_raw());

                        // Mirror horizontally if requested
                        if mirror {
                            mirror_horizontal(&mut bgra_data, actual_width, actual_height);
                        }

                        let webcam_frame = WebcamFrame {
                            bgra_data,
                            width: actual_width,
                            height: actual_height,
                        };

                        // Update the frame buffer
                        if let Ok(mut buffer) = frame_buffer.lock() {
                            *buffer = Some(webcam_frame);
                        }
                    }
                    Err(e) => {
                        eprintln!("[WEBCAM] Frame decode error: {}", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("[WEBCAM] Frame capture error: {}", e);
                // Brief sleep on error to avoid tight loop
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    // Clean up
    let _ = camera.stop_stream();
    eprintln!("[WEBCAM] Camera stream closed");

    Ok(())
}

/// Convert RGBA to BGRA (swap R and B channels).
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

/// Mirror image horizontally (flip left-right).
fn mirror_horizontal(bgra: &mut [u8], width: u32, height: u32) {
    let row_size = (width * 4) as usize;
    for y in 0..height as usize {
        let row_start = y * row_size;
        let row = &mut bgra[row_start..row_start + row_size];

        // Swap pixels from left and right
        for x in 0..(width / 2) as usize {
            let left_idx = x * 4;
            let right_idx = (width as usize - 1 - x) * 4;

            // Swap 4 bytes (BGRA)
            for i in 0..4 {
                row.swap(left_idx + i, right_idx + i);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rgba_to_bgra() {
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255]; // Red, Green
        let bgra = rgba_to_bgra(&rgba);
        assert_eq!(bgra, vec![0, 0, 255, 255, 0, 255, 0, 255]); // Blue (was red), Green
    }

    #[test]
    fn test_mirror_horizontal() {
        // 2x1 image: pixel A (BGRA) and pixel B (BGRA)
        let mut data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        mirror_horizontal(&mut data, 2, 1);
        assert_eq!(data, vec![5, 6, 7, 8, 1, 2, 3, 4]); // Swapped
    }
}
