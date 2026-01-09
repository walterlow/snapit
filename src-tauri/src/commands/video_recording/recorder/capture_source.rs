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
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        log::info!(
            "[CAPTURE] Creating D3D capture for window {} (cursor={})",
            window_id,
            include_cursor
        );

        let mut d3d = D3DVideoCapture::new_window(window_id as isize, 60, include_cursor)?;
        d3d.start()?;

        Ok(CaptureSource { d3d })
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
