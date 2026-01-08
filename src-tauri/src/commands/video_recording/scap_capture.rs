//! Scap-based video capture with built-in crop support.
//!
//! Uses the scap crate which provides native screen capture with crop_area support.
//! This ensures that cursor coordinates and video frames are in the same coordinate space,
//! avoiding the offset issues that occur when cropping is done separately.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use scap::capturer::{Area, Capturer, Options, Point, Resolution, Size};
use scap::frame::{Frame, FrameType, VideoFrame};
use scap::Target;

/// A video frame captured via scap.
pub struct ScapFrame {
    /// BGRA pixel data
    pub data: Vec<u8>,
    /// Frame width in pixels
    pub width: u32,
    /// Frame height in pixels
    pub height: u32,
    /// Timestamp in 100-nanosecond units since UNIX_EPOCH.
    /// This is converted from SystemTime for compatibility with WGC timestamps.
    pub timestamp_100ns: i64,
}

/// Scap-based video capture session with built-in crop support.
pub struct ScapVideoCapture {
    /// Receiver for captured frames
    frame_rx: Receiver<ScapFrame>,
    /// Signal to stop capture
    should_stop: Arc<AtomicBool>,
    /// Capture thread handle
    _thread_handle: JoinHandle<()>,
    /// Capture dimensions (after crop)
    width: u32,
    height: u32,
}

impl ScapVideoCapture {
    /// Create a new scap video capture session for a full monitor.
    ///
    /// # Arguments
    /// * `monitor_index` - Index of the monitor to capture
    /// * `include_cursor` - Whether to include the cursor in capture
    pub fn new_monitor(monitor_index: usize, include_cursor: bool) -> Result<Self, String> {
        // Full monitor capture = region capture with no crop
        Self::new_region(monitor_index, None, (0, 0), 60, include_cursor)
    }

    /// Create a new scap video capture session for a window.
    ///
    /// # Arguments
    /// * `window_id` - Window handle (HWND on Windows)
    /// * `include_cursor` - Whether to include the cursor in capture
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        // Check platform support
        if !scap::is_supported() {
            return Err("Scap is not supported on this platform".to_string());
        }

        // Check permissions
        if !scap::has_permission() {
            log::info!("[SCAP] Requesting screen capture permission");
            if !scap::request_permission() {
                return Err("Screen capture permission denied".to_string());
            }
        }

        // Window dimensions will be determined from first frame
        let width = 1920;
        let height = 1080;

        // Create channel for frames
        let (tx, rx) = mpsc::sync_channel::<ScapFrame>(60);
        let should_stop = Arc::new(AtomicBool::new(false));
        let should_stop_clone = Arc::clone(&should_stop);

        log::info!(
            "[SCAP] Creating window capturer: hwnd={}, cursor={}",
            window_id,
            include_cursor
        );

        // Start capture in background thread
        let handle = std::thread::spawn(move || {
            // Find window target
            let targets = scap::get_all_targets();
            let window_target = targets.into_iter().find_map(|t| {
                if let Target::Window(w) = t {
                    // Compare window handles
                    if w.raw_handle.0 as u32 == window_id {
                        Some(Target::Window(w))
                    } else {
                        None
                    }
                } else {
                    None
                }
            });

            let target = match window_target {
                Some(t) => t,
                None => {
                    log::error!("[SCAP] Window {} not found", window_id);
                    return;
                },
            };

            let options = Options {
                fps: 60,
                target: Some(target),
                show_cursor: include_cursor,
                show_highlight: false,
                excluded_targets: None,
                output_type: FrameType::BGRAFrame,
                output_resolution: Resolution::Captured,
                crop_area: None,
                ..Default::default()
            };

            let mut capturer = match Capturer::build(options) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[SCAP] Failed to build window capturer: {:?}", e);
                    return;
                },
            };

            capturer.start_capture();
            log::info!("[SCAP] Window capture started");

            loop {
                if should_stop_clone.load(Ordering::SeqCst) {
                    break;
                }

                match capturer.get_next_frame() {
                    Ok(frame) => {
                        let scap_frame = match frame {
                            Frame::Video(VideoFrame::BGRA(bgra_frame)) => {
                                let timestamp_100ns = bgra_frame
                                    .display_time
                                    .duration_since(UNIX_EPOCH)
                                    .map(|d| (d.as_nanos() / 100) as i64)
                                    .unwrap_or(0);

                                ScapFrame {
                                    data: bgra_frame.data,
                                    width: bgra_frame.width as u32,
                                    height: bgra_frame.height as u32,
                                    timestamp_100ns,
                                }
                            },
                            _ => continue,
                        };
                        let _ = tx.try_send(scap_frame);
                    },
                    Err(e) => {
                        if !should_stop_clone.load(Ordering::SeqCst) {
                            log::trace!("[SCAP] Window frame error: {:?}", e);
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    },
                }
            }

            capturer.stop_capture();
            log::debug!("[SCAP] Window capture stopped");
        });

        std::thread::sleep(Duration::from_millis(100));

        Ok(Self {
            frame_rx: rx,
            should_stop,
            _thread_handle: handle,
            width,
            height,
        })
    }

    /// Create a new scap video capture session for a region.
    ///
    /// The crop_area is applied internally by scap, ensuring cursor and video
    /// coordinates are in the same space.
    ///
    /// # Arguments
    /// * `monitor_index` - Index of the monitor to capture
    /// * `crop_region` - Optional (x, y, width, height) region in SCREEN coordinates
    /// * `monitor_offset` - Monitor offset (x, y) to convert screen coords to monitor-local
    /// * `fps` - Frames per second
    /// * `include_cursor` - Whether to include the cursor in capture
    pub fn new_region(
        monitor_index: usize,
        crop_region: Option<(i32, i32, u32, u32)>,
        monitor_offset: (i32, i32),
        fps: u32,
        include_cursor: bool,
    ) -> Result<Self, String> {
        // Check platform support
        if !scap::is_supported() {
            return Err("Scap is not supported on this platform".to_string());
        }

        // Check permissions
        if !scap::has_permission() {
            log::info!("[SCAP] Requesting screen capture permission");
            if !scap::request_permission() {
                return Err("Screen capture permission denied".to_string());
            }
        }

        // Get all targets (monitors)
        let targets = scap::get_all_targets();

        // Verify monitor exists
        let display_count = targets
            .iter()
            .filter(|t| matches!(t, Target::Display(_)))
            .count();

        if monitor_index >= display_count {
            return Err(format!(
                "Monitor {} not found (only {} displays)",
                monitor_index, display_count
            ));
        }

        // Determine output dimensions
        let (width, height) = if let Some((_, _, w, h)) = crop_region {
            (w, h)
        } else {
            // Full monitor - get dimensions from target
            (1920, 1080) // Placeholder, will be updated from first frame
        };

        // Create channel for frames
        let (tx, rx) = mpsc::sync_channel::<ScapFrame>(60);
        let should_stop = Arc::new(AtomicBool::new(false));
        let should_stop_clone = Arc::clone(&should_stop);

        log::info!(
            "[SCAP] Creating capturer: fps={}, cursor={}, crop={:?}",
            fps,
            include_cursor,
            crop_region
        );

        // Start capture in background thread - build Capturer inside thread since Display is not Send
        let handle = std::thread::spawn(move || {
            // Get targets inside thread since Display contains non-Send HMONITOR
            let targets = scap::get_all_targets();
            let display_targets: Vec<_> = targets
                .into_iter()
                .filter_map(|t| {
                    if let Target::Display(d) = t {
                        Some(d)
                    } else {
                        None
                    }
                })
                .collect();

            let target = match display_targets.get(monitor_index).cloned() {
                Some(t) => t,
                None => {
                    log::error!("[SCAP] Monitor {} not found in thread", monitor_index);
                    return;
                },
            };

            // Build crop_area if region is specified
            // IMPORTANT: Convert screen coordinates to monitor-local coordinates
            let crop_area = crop_region.map(|(x, y, w, h)| {
                // Convert screen coords to monitor-local coords
                let local_x = (x - monitor_offset.0).max(0);
                let local_y = (y - monitor_offset.1).max(0);

                Area {
                    origin: Point {
                        x: local_x as f64,
                        y: local_y as f64,
                    },
                    size: Size {
                        width: w as f64,
                        height: h as f64,
                    },
                }
            });

            // Create options inside the thread
            let options = Options {
                fps,
                target: Some(Target::Display(target)),
                show_cursor: include_cursor,
                show_highlight: false,
                excluded_targets: None,
                output_type: FrameType::BGRAFrame,
                output_resolution: Resolution::Captured, // Native resolution
                crop_area,
                ..Default::default()
            };

            // Build capturer inside thread
            let mut capturer = match Capturer::build(options) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[SCAP] Failed to build capturer: {:?}", e);
                    return;
                },
            };

            capturer.start_capture();
            log::info!("[SCAP] Capture started");

            loop {
                if should_stop_clone.load(Ordering::SeqCst) {
                    break;
                }

                // Get next frame (blocking with internal timeout)
                match capturer.get_next_frame() {
                    Ok(frame) => {
                        // Extract BGRA data from frame
                        let scap_frame = match frame {
                            Frame::Video(VideoFrame::BGRA(bgra_frame)) => {
                                // Convert SystemTime to 100ns units since UNIX_EPOCH
                                // This makes it comparable to WGC timestamps (also in 100ns units)
                                let timestamp_100ns = bgra_frame
                                    .display_time
                                    .duration_since(UNIX_EPOCH)
                                    .map(|d| (d.as_nanos() / 100) as i64)
                                    .unwrap_or(0);

                                ScapFrame {
                                    data: bgra_frame.data,
                                    width: bgra_frame.width as u32,
                                    height: bgra_frame.height as u32,
                                    timestamp_100ns,
                                }
                            },
                            _ => {
                                // Skip non-BGRA frames (e.g., audio frames)
                                continue;
                            },
                        };

                        // Send frame (drop if channel is full)
                        let _ = tx.try_send(scap_frame);
                    },
                    Err(e) => {
                        log::warn!("[SCAP] Frame receive error: {:?}", e);
                        // Check if we should stop
                        if should_stop_clone.load(Ordering::SeqCst) {
                            break;
                        }
                    },
                }
            }

            capturer.stop_capture();
            log::debug!("[SCAP] Capture stopped");
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

    /// Wait for the first frame and return actual dimensions.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, ScapFrame)> {
        match self
            .frame_rx
            .recv_timeout(Duration::from_millis(timeout_ms))
        {
            Ok(frame) => {
                let w = frame.width;
                let h = frame.height;
                Some((w, h, frame))
            },
            Err(_) => None,
        }
    }

    /// Try to get the next frame (non-blocking).
    pub fn try_get_frame(&self) -> Option<ScapFrame> {
        self.frame_rx.try_recv().ok()
    }

    /// Get the next frame with timeout.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<ScapFrame> {
        self.frame_rx
            .recv_timeout(Duration::from_millis(timeout_ms))
            .ok()
    }

    /// Stop the capture session.
    pub fn stop(&self) {
        self.should_stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for ScapVideoCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Check if scap is available on this system.
pub fn is_scap_available() -> bool {
    scap::is_supported() && scap::has_permission()
}
