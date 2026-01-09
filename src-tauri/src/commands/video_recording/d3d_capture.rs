//! Clean D3D11 video capture implementation using scap-direct3d.
//!
//! This replaces the messy scap_capture.rs with a simpler, more reliable approach
//! based on Cap's capture architecture.

use scap_direct3d::{Capturer, Frame, PixelFormat, Settings};
use scap_targets::Display;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver},
    Arc,
};
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::D3D11_BOX;

/// A captured video frame with metadata.
pub struct D3DFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub timestamp_100ns: i64,
}

/// Configuration for D3D capture.
pub struct D3DCaptureConfig {
    pub display_index: usize,
    pub fps: u32,
    pub show_cursor: bool,
    pub crop: Option<(u32, u32, u32, u32)>, // (x, y, width, height)
}

/// D3D11 video capture using Windows Graphics Capture API.
pub struct D3DVideoCapture {
    frame_rx: Receiver<D3DFrame>,
    stop_flag: Arc<AtomicBool>,
    width: u32,
    height: u32,
    _capturer: Option<Capturer>,
}

impl D3DVideoCapture {
    /// Create a new D3D capture for a display.
    pub fn new(config: D3DCaptureConfig) -> Result<Self, String> {
        let displays = Display::list();
        let display = displays
            .get(config.display_index)
            .ok_or_else(|| format!("Display {} not found", config.display_index))?;

        let capture_item = display
            .raw_handle()
            .try_as_capture_item()
            .map_err(|e| format!("Failed to create capture item: {}", e))?;

        // Get display dimensions
        let (width, height) = if let Some((_, _, w, h)) = config.crop {
            (w, h)
        } else {
            let size = display
                .physical_size()
                .ok_or("Failed to get display size")?;
            (size.width() as u32, size.height() as u32)
        };

        // Build settings
        let mut settings = Settings {
            pixel_format: PixelFormat::B8G8R8A8Unorm, // BGRA for compatibility
            fps: Some(config.fps),
            ..Default::default()
        };

        // Configure border (hide yellow border on Win11+)
        if Settings::can_is_border_required().unwrap_or(false) {
            settings.is_border_required = Some(false);
        }

        // Configure cursor capture
        if Settings::can_is_cursor_capture_enabled().unwrap_or(false) {
            settings.is_cursor_capture_enabled = Some(config.show_cursor);
        }

        // Configure frame rate
        if Settings::can_min_update_interval().unwrap_or(false) {
            settings.min_update_interval = Some(Duration::from_secs_f64(1.0 / config.fps as f64));
        }

        // Configure crop
        if let Some((x, y, w, h)) = config.crop {
            settings.crop = Some(D3D11_BOX {
                left: x,
                top: y,
                right: x + w,
                bottom: y + h,
                front: 0,
                back: 1,
            });
        }

        // Create channel for frames
        let (frame_tx, frame_rx) = mpsc::sync_channel::<D3DFrame>(4);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_callback = stop_flag.clone();

        // Create capturer with frame callback
        let capturer = Capturer::new(
            capture_item,
            settings,
            move |frame: Frame| {
                if stop_flag_callback.load(Ordering::Relaxed) {
                    return Ok(());
                }

                // Get frame buffer and copy data without stride
                let buffer = frame.as_buffer()?;
                let data = buffer.to_vec_no_stride();

                let d3d_frame = D3DFrame {
                    data,
                    width: frame.width(),
                    height: frame.height(),
                    timestamp_100ns: frame.inner().SystemRelativeTime()?.Duration,
                };

                // Non-blocking send - drop frame if channel is full
                let _ = frame_tx.try_send(d3d_frame);
                Ok(())
            },
            || {
                log::debug!("Capture session closed");
                Ok(())
            },
            None, // Let capturer create its own D3D device
        )
        .map_err(|e| format!("Failed to create capturer: {}", e))?;

        Ok(Self {
            frame_rx,
            stop_flag,
            width,
            height,
            _capturer: Some(capturer),
        })
    }

    /// Create capture for primary display.
    pub fn new_primary(fps: u32, show_cursor: bool) -> Result<Self, String> {
        // Find primary display index
        let displays = Display::list();
        let primary = Display::primary();
        let primary_id = primary.id();

        let display_index = displays
            .iter()
            .position(|d| d.id() == primary_id)
            .unwrap_or(0);

        Self::new(D3DCaptureConfig {
            display_index,
            fps,
            show_cursor,
            crop: None,
        })
    }

    /// Create capture for a specific display by index.
    pub fn new_display(display_index: usize, fps: u32, show_cursor: bool) -> Result<Self, String> {
        Self::new(D3DCaptureConfig {
            display_index,
            fps,
            show_cursor,
            crop: None,
        })
    }

    /// Create capture for a window by HWND.
    pub fn new_window(window_hwnd: isize, fps: u32, show_cursor: bool) -> Result<Self, String> {
        use windows::Graphics::Capture::GraphicsCaptureItem;
        use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

        let hwnd = HWND(window_hwnd as *mut _);

        // Create capture item from window
        let capture_item: GraphicsCaptureItem = unsafe {
            let interop =
                windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .map_err(|e| format!("Failed to get interop: {}", e))?;
            interop
                .CreateForWindow(hwnd)
                .map_err(|e| format!("Failed to create capture item for window: {}", e))?
        };

        // Get window size
        let size = capture_item
            .Size()
            .map_err(|e| format!("Failed to get window size: {}", e))?;

        let width = size.Width as u32;
        let height = size.Height as u32;

        // Build settings
        let mut settings = Settings {
            pixel_format: PixelFormat::B8G8R8A8Unorm,
            fps: Some(fps),
            ..Default::default()
        };

        // Configure border (hide yellow border on Win11+)
        if Settings::can_is_border_required().unwrap_or(false) {
            settings.is_border_required = Some(false);
        }

        // Configure cursor capture
        if Settings::can_is_cursor_capture_enabled().unwrap_or(false) {
            settings.is_cursor_capture_enabled = Some(show_cursor);
        }

        // Configure frame rate
        if Settings::can_min_update_interval().unwrap_or(false) {
            settings.min_update_interval = Some(Duration::from_secs_f64(1.0 / fps as f64));
        }

        // Create channel for frames
        let (frame_tx, frame_rx) = mpsc::sync_channel::<D3DFrame>(4);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_callback = stop_flag.clone();

        // Create capturer with frame callback
        let capturer = Capturer::new(
            capture_item,
            settings,
            move |frame: Frame| {
                if stop_flag_callback.load(Ordering::Relaxed) {
                    return Ok(());
                }

                let buffer = frame.as_buffer()?;
                let data = buffer.to_vec_no_stride();

                let d3d_frame = D3DFrame {
                    data,
                    width: frame.width(),
                    height: frame.height(),
                    timestamp_100ns: frame.inner().SystemRelativeTime()?.Duration,
                };

                let _ = frame_tx.try_send(d3d_frame);
                Ok(())
            },
            || {
                log::debug!("Window capture session closed");
                Ok(())
            },
            None,
        )
        .map_err(|e| format!("Failed to create window capturer: {}", e))?;

        Ok(Self {
            frame_rx,
            stop_flag,
            width,
            height,
            _capturer: Some(capturer),
        })
    }

    /// Create capture with crop region.
    pub fn new_region(
        display_index: usize,
        crop: (u32, u32, u32, u32),
        fps: u32,
        show_cursor: bool,
    ) -> Result<Self, String> {
        Self::new(D3DCaptureConfig {
            display_index,
            fps,
            show_cursor,
            crop: Some(crop),
        })
    }

    /// Start capturing.
    pub fn start(&mut self) -> Result<(), String> {
        if let Some(ref mut capturer) = self._capturer {
            capturer
                .start()
                .map_err(|e| format!("Failed to start capture: {}", e))?;
        }
        Ok(())
    }

    /// Get the next frame with timeout.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<D3DFrame> {
        self.frame_rx
            .recv_timeout(Duration::from_millis(timeout_ms))
            .ok()
    }

    /// Wait for first frame to get actual dimensions.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, D3DFrame)> {
        let frame = self.get_frame(timeout_ms)?;
        Some((frame.width, frame.height, frame))
    }

    /// Get capture width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Get capture height.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Stop capturing.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(ref mut capturer) = self._capturer {
            let _ = capturer.stop();
        }
    }
}

impl Drop for D3DVideoCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Get display bounds for cursor coordinate mapping.
pub fn get_display_bounds(display_index: usize) -> Option<(i32, i32, u32, u32)> {
    let displays = Display::list();
    let display = displays.get(display_index)?;
    let bounds = display.physical_bounds()?;

    Some((
        bounds.position().x() as i32,
        bounds.position().y() as i32,
        bounds.size().width() as u32,
        bounds.size().height() as u32,
    ))
}

/// Get primary display index.
pub fn get_primary_display_index() -> usize {
    let displays = Display::list();
    let primary = Display::primary();
    let primary_id = primary.id();

    displays
        .iter()
        .position(|d| d.id() == primary_id)
        .unwrap_or(0)
}
