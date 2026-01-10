//! Unified capture source abstraction for video recording.
//!
//! Uses D3D capture (scap-direct3d) for all capture types for reliable frame capture.

use super::super::d3d_capture::{D3DCaptureConfig, D3DFrame, D3DVideoCapture};
use super::super::timestamp::PerformanceCounterTimestamp;

/// A captured video frame.
pub struct CapturedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Timestamp in 100-nanosecond units since UNIX_EPOCH.
    /// Used for cursor-video synchronization.
    pub timestamp_100ns: i64,
}

impl From<D3DFrame> for CapturedFrame {
    fn from(f: D3DFrame) -> Self {
        CapturedFrame {
            data: f.data,
            width: f.width,
            height: f.height,
            timestamp_100ns: f.timestamp_100ns,
        }
    }
}

/// Unified capture source using D3D capture for all types.
pub struct CaptureSource {
    d3d: D3DVideoCapture,
}

impl CaptureSource {
    /// Create a capture source for a monitor (full monitor capture).
    pub fn new_monitor(monitor_index: usize, include_cursor: bool) -> Result<Self, String> {
        log::info!(
            "[CAPTURE] Creating D3D capture for monitor {} (cursor={})",
            monitor_index,
            include_cursor
        );

        let mut d3d = D3DVideoCapture::new(D3DCaptureConfig {
            display_index: monitor_index,
            fps: 60,
            show_cursor: include_cursor,
            crop: None,
        })?;

        d3d.start()?;

        Ok(CaptureSource { d3d })
    }

    /// Create a capture source for a window.
    ///
    /// Uses display capture + crop instead of WGC window capture to properly
    /// capture WebView2/transparent windows (WGC's CreateForWindow fails for these).
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};

        log::info!(
            "[CAPTURE] Creating D3D capture for window {} via display+crop (cursor={})",
            window_id,
            include_cursor
        );

        let hwnd = HWND(window_id as isize as *mut std::ffi::c_void);

        // Get window bounds using DWM (excludes shadow, accurate for WebView2 windows)
        let mut dwm_rect = RECT::default();
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut dwm_rect as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
        };

        if result.is_err() {
            return Err(format!("Failed to get window bounds: {:?}", result.err()));
        }

        let x = dwm_rect.left;
        let y = dwm_rect.top;
        let width = (dwm_rect.right - dwm_rect.left) as u32;
        let height = (dwm_rect.bottom - dwm_rect.top) as u32;

        if width == 0 || height == 0 {
            return Err("Window has zero dimensions".to_string());
        }

        log::info!(
            "[CAPTURE] Window {} bounds: ({},{}) {}x{}",
            window_id,
            x,
            y,
            width,
            height
        );

        // Find which monitor contains the window center
        let center_x = x + (width as i32 / 2);
        let center_y = y + (height as i32 / 2);

        let displays = scap_targets::Display::list();
        let (monitor_index, mon_x, mon_y) = displays
            .iter()
            .enumerate()
            .filter_map(|(idx, d)| {
                let bounds = d.physical_bounds()?;
                let pos_x = bounds.position().x() as i32;
                let pos_y = bounds.position().y() as i32;
                let size_w = bounds.size().width() as i32;
                let size_h = bounds.size().height() as i32;
                if center_x >= pos_x
                    && center_x < pos_x + size_w
                    && center_y >= pos_y
                    && center_y < pos_y + size_h
                {
                    Some((idx, pos_x, pos_y))
                } else {
                    None
                }
            })
            .next()
            .ok_or_else(|| "Window not on any monitor".to_string())?;

        log::info!(
            "[CAPTURE] Window {} is on monitor {} at ({},{})",
            window_id,
            monitor_index,
            mon_x,
            mon_y
        );

        // Use display capture with crop (same as region mode)
        Self::new_region(
            monitor_index,
            (x, y, width, height),
            (mon_x, mon_y),
            60,
            include_cursor,
        )
    }

    /// Create a capture source for a region.
    ///
    /// # Arguments
    /// * `monitor_index` - Index of the monitor to capture
    /// * `region` - (x, y, width, height) in screen coordinates
    /// * `monitor_offset` - (x, y) offset of the monitor in screen space
    /// * `fps` - Frames per second
    /// * `include_cursor` - Whether to include cursor in capture
    pub fn new_region(
        monitor_index: usize,
        region: (i32, i32, u32, u32),
        monitor_offset: (i32, i32),
        fps: u32,
        include_cursor: bool,
    ) -> Result<Self, String> {
        log::info!(
            "[CAPTURE] Creating D3D capture for region on monitor {} (region={:?}, cursor={})",
            monitor_index,
            region,
            include_cursor
        );

        // Convert region to D3D crop (relative to monitor)
        let (x, y, w, h) = region;
        let (mon_x, mon_y) = monitor_offset;
        let rel_x = (x - mon_x).max(0) as u32;
        let rel_y = (y - mon_y).max(0) as u32;

        let mut d3d = D3DVideoCapture::new(D3DCaptureConfig {
            display_index: monitor_index,
            fps,
            show_cursor: include_cursor,
            crop: Some((rel_x, rel_y, w, h)),
        })?;

        d3d.start()?;

        Ok(CaptureSource { d3d })
    }

    /// Get the capture width.
    pub fn width(&self) -> u32 {
        self.d3d.width()
    }

    /// Get the capture height.
    pub fn height(&self) -> u32 {
        self.d3d.height()
    }

    /// Wait for first frame and get actual dimensions.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, CapturedFrame)> {
        self.d3d
            .wait_for_first_frame(timeout_ms)
            .map(|(w, h, f)| (w, h, f.into()))
    }

    /// Get next frame with timeout.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<CapturedFrame> {
        self.d3d.get_frame(timeout_ms).map(|f| f.into())
    }

    /// Stop the capture.
    pub fn stop(&mut self) {
        self.d3d.stop()
    }

    /// Drain any buffered frames to ensure the next frame is fresh.
    pub fn drain_buffer(&self) -> usize {
        let mut count = 0;
        while self.get_frame(1).is_some() {
            count += 1;
            if count > 120 {
                log::warn!(
                    "[CAPTURE] Drained {} frames, stopping to prevent infinite loop",
                    count
                );
                break;
            }
        }
        if count > 0 {
            log::debug!("[CAPTURE] Drained {} buffered frames", count);
        }
        count
    }

    /// Get the next frame with its receive timestamp.
    pub fn get_frame_with_timestamp(&self, timeout_ms: u64) -> Option<(CapturedFrame, i64)> {
        let frame = self.get_frame(timeout_ms)?;
        let timestamp = PerformanceCounterTimestamp::now().raw();
        Some((frame, timestamp))
    }
}
