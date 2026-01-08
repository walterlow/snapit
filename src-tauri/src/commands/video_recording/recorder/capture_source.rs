//! Unified capture source abstraction for video recording.
//!
//! Uses Scap for all capture types (monitor, window, region) for:
//! - Consistent timestamp handling via SystemTime
//! - Native crop support for region capture
//! - Unified API across capture modes

use super::super::scap_capture::{ScapFrame, ScapVideoCapture};
use super::super::timestamp::PerformanceCounterTimestamp;

/// A captured video frame.
pub struct CapturedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Timestamp in 100-nanosecond units since UNIX_EPOCH (from Scap's SystemTime).
    /// Used for cursor-video synchronization.
    pub timestamp_100ns: i64,
}

impl From<ScapFrame> for CapturedFrame {
    fn from(f: ScapFrame) -> Self {
        CapturedFrame {
            data: f.data,
            width: f.width,
            height: f.height,
            timestamp_100ns: f.timestamp_100ns,
        }
    }
}

/// Unified capture source using Scap for all capture types.
pub struct CaptureSource {
    scap: ScapVideoCapture,
}

impl CaptureSource {
    /// Create a capture source for a monitor (full monitor capture).
    pub fn new_monitor(monitor_index: usize, include_cursor: bool) -> Result<Self, String> {
        // Use Scap with no crop region for full monitor capture
        let scap = ScapVideoCapture::new_monitor(monitor_index, include_cursor)?;
        Ok(CaptureSource { scap })
    }

    /// Create a capture source for a window.
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        let scap = ScapVideoCapture::new_window(window_id, include_cursor)?;
        Ok(CaptureSource { scap })
    }

    /// Create a capture source for a region using Scap's built-in crop.
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
        let scap = ScapVideoCapture::new_region(
            monitor_index,
            Some(region),
            monitor_offset,
            fps,
            include_cursor,
        )?;
        Ok(CaptureSource { scap })
    }

    /// Get the capture width.
    pub fn width(&self) -> u32 {
        self.scap.width()
    }

    /// Get the capture height.
    pub fn height(&self) -> u32 {
        self.scap.height()
    }

    /// Wait for first frame and get actual dimensions.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, CapturedFrame)> {
        self.scap
            .wait_for_first_frame(timeout_ms)
            .map(|(w, h, f)| (w, h, f.into()))
    }

    /// Get next frame with timeout.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<CapturedFrame> {
        self.scap.get_frame(timeout_ms).map(|f| f.into())
    }

    /// Stop the capture.
    pub fn stop(&self) {
        self.scap.stop();
    }

    /// Drain any buffered frames to ensure the next frame is fresh.
    ///
    /// Returns the number of frames drained.
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
