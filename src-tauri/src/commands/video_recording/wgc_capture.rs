//! Windows Graphics Capture (WGC) based video capture.
//!
//! Provides an alternative to DXGI Desktop Duplication for monitors that
//! have compatibility issues (non-standard refresh rates, different GPU adapters, etc.).
//!
//! WGC is more robust across different monitor configurations but may have
//! slightly higher latency than DXGI.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

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

/// A video frame captured via WGC.
pub struct WgcFrame {
    /// BGRA pixel data
    pub data: Vec<u8>,
    /// Frame width in pixels
    pub width: u32,
    /// Frame height in pixels
    pub height: u32,
}

/// Message sent from capture handler to receiver.
type FrameMessage = Result<WgcFrame, String>;

/// Flags passed to the capture handler.
struct CaptureFlags {
    tx: SyncSender<FrameMessage>,
    should_stop: Arc<AtomicBool>,
    include_cursor: bool,
}

/// Continuous video capture handler using WGC.
struct VideoCaptureHandler {
    tx: SyncSender<FrameMessage>,
    should_stop: Arc<AtomicBool>,
    frame_count: AtomicU32,
}

impl GraphicsCaptureApiHandler for VideoCaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags.tx,
            should_stop: ctx.flags.should_stop,
            frame_count: AtomicU32::new(0),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Check if we should stop
        if self.should_stop.load(Ordering::SeqCst) {
            capture_control.stop();
            return Ok(());
        }

        let count = self.frame_count.fetch_add(1, Ordering::Relaxed);

        // Get frame dimensions
        let width = frame.width();
        let height = frame.height();

        // Get frame buffer
        let buffer = match frame.buffer() {
            Ok(b) => b,
            Err(e) => {
                log::warn!("[WGC] Failed to get buffer on frame {}: {:?}", count, e);
                return Ok(()); // Skip this frame
            }
        };

        let mut raw_data = Vec::new();
        let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);

        if pixel_data.is_empty() {
            return Ok(()); // Skip empty frames
        }

        // WGC returns BGRA data - keep it as BGRA since the encoder expects BGRA
        let frame_data = WgcFrame {
            data: pixel_data.to_vec(),
            width,
            height,
        };

        // Send frame (drop if channel is full - receiver is behind)
        let _ = self.tx.try_send(Ok(frame_data));

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// WGC-based video capture session.
pub struct WgcVideoCapture {
    /// Receiver for captured frames
    frame_rx: Receiver<FrameMessage>,
    /// Signal to stop capture
    should_stop: Arc<AtomicBool>,
    /// Capture thread handle
    _thread_handle: std::thread::JoinHandle<()>,
    /// Capture dimensions
    width: u32,
    height: u32,
}

impl WgcVideoCapture {
    /// Create a new WGC video capture session for a monitor.
    ///
    /// # Arguments
    /// * `monitor_index` - Index of the monitor to capture
    /// * `include_cursor` - Whether to include the cursor in capture
    pub fn new(monitor_index: usize, include_cursor: bool) -> Result<Self, String> {
        let monitors =
            Monitor::enumerate().map_err(|e| format!("Failed to enumerate monitors: {:?}", e))?;

        let monitor = monitors
            .get(monitor_index)
            .ok_or_else(|| format!("Monitor {} not found", monitor_index))?
            .clone();

        let width = monitor.width().unwrap_or(1920);
        let height = monitor.height().unwrap_or(1080);

        log::debug!(
            "[WGC] Starting monitor capture: index={}, dims={}x{}",
            monitor_index,
            width,
            height
        );

        // Create channel for frames (buffer 1 second at 60 FPS)
        let (tx, rx) = mpsc::sync_channel::<FrameMessage>(60);
        let should_stop = Arc::new(AtomicBool::new(false));
        let should_stop_clone = Arc::clone(&should_stop);

        let cursor_settings = if include_cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };

        let flags = CaptureFlags {
            tx,
            should_stop: should_stop_clone,
            include_cursor,
        };

        let settings = Settings::new(
            monitor,
            cursor_settings,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );

        // Start capture in background thread
        let handle = std::thread::spawn(move || {
            if let Err(e) = VideoCaptureHandler::start(settings) {
                log::error!("[WGC] Capture handler error: {:?}", e);
            }
        });

        // Wait briefly for capture to start
        std::thread::sleep(Duration::from_millis(100));

        Ok(Self {
            frame_rx: rx,
            should_stop,
            _thread_handle: handle,
            width,
            height,
        })
    }

    /// Create a new WGC video capture session for a specific window.
    ///
    /// Captures the actual window content even if covered by other windows.
    /// Brings the window to the foreground before starting capture.
    ///
    /// # Arguments
    /// * `window_id` - The HWND of the window to capture
    /// * `include_cursor` - Whether to include the cursor in capture
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        // Create Window from raw HWND
        let window = Window::from_raw_hwnd(window_id as isize as *mut std::ffi::c_void);

        // Validate window is capturable
        if !window.is_valid() {
            return Err(format!("Window {} is not valid for capture", window_id));
        }

        // Bring window to front before capturing
        bring_window_to_front(window_id);

        let title = window.title().unwrap_or_default();

        // Get window dimensions from rect
        let (width, height) = match window.rect() {
            Ok(rect) => (
                (rect.right - rect.left) as u32,
                (rect.bottom - rect.top) as u32,
            ),
            Err(_) => (1920, 1080),
        };

        log::debug!(
            "[WGC] Starting window capture: hwnd={}, title='{}', dims={}x{}",
            window_id,
            title,
            width,
            height
        );

        // Create channel for frames (buffer 1 second at 60 FPS)
        let (tx, rx) = mpsc::sync_channel::<FrameMessage>(60);
        let should_stop = Arc::new(AtomicBool::new(false));
        let should_stop_clone = Arc::clone(&should_stop);

        let cursor_settings = if include_cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };

        let flags = CaptureFlags {
            tx,
            should_stop: should_stop_clone,
            include_cursor,
        };

        let settings = Settings::new(
            window,
            cursor_settings,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );

        // Start capture in background thread
        let handle = std::thread::spawn(move || {
            if let Err(e) = VideoCaptureHandler::start(settings) {
                log::error!("[WGC] Capture handler error: {:?}", e);
            }
        });

        // Wait briefly for capture to start
        std::thread::sleep(Duration::from_millis(100));

        Ok(Self {
            frame_rx: rx,
            should_stop,
            _thread_handle: handle,
            width,
            height,
        })
    }

    /// Get the capture width (initial estimate, may differ from actual frames).
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Get the capture height (initial estimate, may differ from actual frames).
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Wait for frames and return stabilized dimensions.
    ///
    /// WGC may return different dimensions for the first few frames as it initializes,
    /// especially on multi-monitor setups with different DPI scaling. We wait for
    /// dimensions to stabilize (2 consecutive frames with same dimensions) before
    /// returning the actual capture dimensions.
    ///
    /// Returns (width, height, first_usable_frame) or None on timeout/error.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, WgcFrame)> {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut last_dims: Option<(u32, u32)> = None;
        let mut stable_count = 0;

        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                log::warn!("[WGC] Timeout waiting for stable dimensions");
                return None;
            }

            match self.frame_rx.recv_timeout(remaining) {
                Ok(Ok(frame)) => {
                    let dims = (frame.width, frame.height);

                    if let Some(prev) = last_dims {
                        if prev == dims {
                            stable_count += 1;
                            // Wait for 2 consecutive frames with same dimensions
                            if stable_count >= 1 {
                                if dims.0 != self.width || dims.1 != self.height {
                                    log::debug!(
                                        "[WGC] Actual dimensions {}x{} differ from expected {}x{}",
                                        dims.0,
                                        dims.1,
                                        self.width,
                                        self.height
                                    );
                                }
                                return Some((dims.0, dims.1, frame));
                            }
                        } else {
                            stable_count = 0;
                        }
                    }
                    last_dims = Some(dims);
                }
                _ => {
                    log::warn!("[WGC] Error receiving frame while waiting for stable dimensions");
                    return None;
                }
            }
        }
    }

    /// Try to get the next frame (non-blocking).
    ///
    /// Returns `None` if no frame is available.
    pub fn try_get_frame(&self) -> Option<WgcFrame> {
        match self.frame_rx.try_recv() {
            Ok(Ok(frame)) => Some(frame),
            _ => None,
        }
    }

    /// Get the next frame with timeout.
    ///
    /// Returns `None` if timeout expires before a frame is available.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<WgcFrame> {
        match self
            .frame_rx
            .recv_timeout(Duration::from_millis(timeout_ms))
        {
            Ok(Ok(frame)) => Some(frame),
            _ => None,
        }
    }

    /// Stop the capture session.
    pub fn stop(&self) {
        self.should_stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for WgcVideoCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Check if WGC is available on this system.
pub fn is_wgc_available() -> bool {
    Monitor::enumerate().is_ok()
}

/// Bring a window to the foreground.
fn bring_window_to_front(window_id: u32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let hwnd = HWND(window_id as isize as *mut std::ffi::c_void);

    unsafe {
        // If minimized, restore it first
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        // Bring to foreground
        let _ = SetForegroundWindow(hwnd);
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Helper to create a mock WgcFrame with given dimensions.
    fn mock_frame(width: u32, height: u32) -> WgcFrame {
        WgcFrame {
            data: vec![0u8; (width * height * 4) as usize],
            width,
            height,
        }
    }

    /// Simulate dimension stabilization logic used in wait_for_first_frame.
    ///
    /// This is extracted to test the core algorithm without needing actual WGC capture.
    /// Returns (final_width, final_height) once dimensions stabilize, or None on timeout.
    fn simulate_dimension_stabilization(
        frames: Vec<(u32, u32)>,
        required_stable_count: usize,
    ) -> Option<(u32, u32)> {
        let mut last_dims: Option<(u32, u32)> = None;
        let mut stable_count = 0;

        for dims in frames {
            if let Some(prev) = last_dims {
                if prev == dims {
                    stable_count += 1;
                    if stable_count >= required_stable_count {
                        return Some(dims);
                    }
                } else {
                    stable_count = 0;
                }
            }
            last_dims = Some(dims);
        }

        None
    }

    /// Regression test: WGC may return different dimensions for the first few frames
    /// when capturing windows on multi-monitor setups with different DPI scaling.
    ///
    /// Bug: Recording a window on 2nd monitor with different DPI scaling would cause
    /// the encoder to be initialized with wrong dimensions, resulting in sheared/strided video.
    ///
    /// Fix: wait_for_first_frame() now waits for dimensions to stabilize before returning.
    #[test]
    fn test_dimension_stabilization_detects_changing_dimensions() {
        // Simulate WGC returning different dimensions initially, then stabilizing
        // This matches the real-world behavior observed with DPI-scaled windows
        let frames = vec![
            (1936, 1056), // First frame - wrong dimensions due to DPI
            (1920, 1040), // Second frame - correct dimensions
            (1920, 1040), // Third frame - same as second, dimensions stable
        ];

        let result = simulate_dimension_stabilization(frames, 1);
        assert_eq!(result, Some((1920, 1040)));
    }

    #[test]
    fn test_dimension_stabilization_handles_immediate_stability() {
        // Dimensions are stable from the start
        let frames = vec![(1920, 1080), (1920, 1080)];

        let result = simulate_dimension_stabilization(frames, 1);
        assert_eq!(result, Some((1920, 1080)));
    }

    #[test]
    fn test_dimension_stabilization_handles_multiple_changes() {
        // Dimensions change multiple times before stabilizing
        let frames = vec![
            (1936, 1056),
            (1928, 1048),
            (1920, 1040),
            (1920, 1040), // Stabilizes here
        ];

        let result = simulate_dimension_stabilization(frames, 1);
        assert_eq!(result, Some((1920, 1040)));
    }

    #[test]
    fn test_dimension_stabilization_returns_none_if_never_stable() {
        // Dimensions keep changing, never stabilize
        let frames = vec![(1936, 1056), (1920, 1040), (1928, 1048)];

        let result = simulate_dimension_stabilization(frames, 1);
        assert_eq!(result, None);
    }

    #[test]
    fn test_dimension_stabilization_single_frame_not_stable() {
        // Single frame is not enough to determine stability
        let frames = vec![(1920, 1080)];

        let result = simulate_dimension_stabilization(frames, 1);
        assert_eq!(result, None);
    }

    /// Test that WgcFrame correctly stores dimensions with its data.
    #[test]
    fn test_wgc_frame_dimensions() {
        let frame = mock_frame(1920, 1080);
        assert_eq!(frame.width, 1920);
        assert_eq!(frame.height, 1080);
        assert_eq!(frame.data.len(), 1920 * 1080 * 4);
    }

    /// Integration-style test using actual channel (but mocked frames).
    /// This tests the timeout and channel receive behavior.
    #[test]
    fn test_wait_for_stable_dimensions_via_channel() {
        let (tx, rx) = mpsc::sync_channel::<FrameMessage>(10);

        // Send frames with changing then stable dimensions
        tx.send(Ok(mock_frame(1936, 1056))).unwrap();
        tx.send(Ok(mock_frame(1920, 1040))).unwrap();
        tx.send(Ok(mock_frame(1920, 1040))).unwrap();
        drop(tx); // Close channel

        // Simulate the stabilization logic
        let deadline = std::time::Instant::now() + Duration::from_millis(100);
        let mut last_dims: Option<(u32, u32)> = None;
        let mut stable_count = 0;
        let mut result = None;

        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }

            match rx.recv_timeout(remaining) {
                Ok(Ok(frame)) => {
                    let dims = (frame.width, frame.height);
                    if let Some(prev) = last_dims {
                        if prev == dims {
                            stable_count += 1;
                            if stable_count >= 1 {
                                result = Some((dims.0, dims.1, frame));
                                break;
                            }
                        } else {
                            stable_count = 0;
                        }
                    }
                    last_dims = Some(dims);
                }
                _ => break,
            }
        }

        assert!(result.is_some());
        let (w, h, _) = result.unwrap();
        assert_eq!(w, 1920);
        assert_eq!(h, 1040);
    }
}
