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
    window::Window,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
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
        eprintln!("[WGC] VideoCaptureHandler::new() called");
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

        // Log first few frames for debugging
        if count < 3 {
            eprintln!("[WGC] on_frame_arrived called, frame #{}", count);
        }

        // Get frame dimensions
        let width = frame.width();
        let height = frame.height();

        // Get frame buffer
        let buffer = match frame.buffer() {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[WGC] Failed to get buffer on frame {}: {:?}", count, e);
                return Ok(()); // Skip this frame
            }
        };

        let mut raw_data = Vec::new();
        let pixel_data = buffer.as_nopadding_buffer(&mut raw_data);

        if pixel_data.is_empty() {
            if count < 5 {
                eprintln!("[WGC] Empty pixel data on frame {}", count);
            }
            return Ok(()); // Skip empty frames
        }

        if count < 3 {
            eprintln!("[WGC] Frame {} captured: {}x{}, {} bytes", count, width, height, pixel_data.len());
        }

        // WGC returns BGRA data - keep it as BGRA since the encoder expects BGRA
        let frame_data = WgcFrame {
            data: pixel_data.to_vec(),
            width,
            height,
        };

        // Send frame - log if channel is full
        match self.tx.try_send(Ok(frame_data)) {
            Ok(()) => {}
            Err(e) => {
                if count < 5 || count % 100 == 0 {
                    eprintln!("[WGC] Failed to send frame {}: {:?}", count, e);
                }
            }
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        eprintln!("[WGC] Capture session closed");
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
        let monitors = Monitor::enumerate()
            .map_err(|e| format!("Failed to enumerate monitors: {:?}", e))?;

        let monitor = monitors
            .get(monitor_index)
            .ok_or_else(|| format!("Monitor {} not found", monitor_index))?
            .clone();

        let width = monitor.width().unwrap_or(1920);
        let height = monitor.height().unwrap_or(1080);

        eprintln!("[WGC] Starting capture for monitor {} ({}x{})", monitor_index, width, height);

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
            eprintln!("[WGC] Starting VideoCaptureHandler...");
            match VideoCaptureHandler::start(settings) {
                Ok(()) => eprintln!("[WGC] VideoCaptureHandler finished normally"),
                Err(e) => eprintln!("[WGC] VideoCaptureHandler error: {:?}", e),
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
            Ok(rect) => ((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32),
            Err(_) => (1920, 1080),
        };

        eprintln!("[WGC] Starting capture for window {} '{}' ({}x{})", window_id, title, width, height);

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
            eprintln!("[WGC] Starting VideoCaptureHandler...");
            match VideoCaptureHandler::start(settings) {
                Ok(()) => eprintln!("[WGC] VideoCaptureHandler finished normally"),
                Err(e) => eprintln!("[WGC] VideoCaptureHandler error: {:?}", e),
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

    /// Get the capture width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Get the capture height.
    pub fn height(&self) -> u32 {
        self.height
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
        match self.frame_rx.recv_timeout(Duration::from_millis(timeout_ms)) {
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
        SetForegroundWindow, ShowWindow, SW_RESTORE, IsIconic,
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

    eprintln!("[WGC] Brought window {} to foreground", window_id);
}
