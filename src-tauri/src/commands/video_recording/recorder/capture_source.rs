//! Unified capture source abstraction for video recording.
//!
//! Uses D3D capture (scap-direct3d) for monitors for reliable frame capture,
//! and Scap for window/region capture.

use super::super::d3d_capture::{D3DCaptureConfig, D3DFrame, D3DVideoCapture};
use super::super::scap_capture::{ScapFrame, ScapVideoCapture};
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

/// Internal capture backend.
enum CaptureBackend {
    D3D(D3DVideoCapture),
    Scap(ScapVideoCapture),
}

/// Unified capture source.
///
/// Uses D3D capture for monitors (more reliable, proper stride handling)
/// and Scap for windows/regions.
pub struct CaptureSource {
    backend: CaptureBackend,
}

impl CaptureSource {
    /// Create a capture source for a monitor (full monitor capture).
    /// Uses D3D capture for reliable frame acquisition.
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

        // Start capture immediately
        d3d.start()?;

        Ok(CaptureSource {
            backend: CaptureBackend::D3D(d3d),
        })
    }

    /// Create a capture source for a window.
    /// Uses Scap for window capture.
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        let scap = ScapVideoCapture::new_window(window_id, include_cursor)?;
        Ok(CaptureSource {
            backend: CaptureBackend::Scap(scap),
        })
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
        // For region capture, use D3D with crop
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

        Ok(CaptureSource {
            backend: CaptureBackend::D3D(d3d),
        })
    }

    /// Get the capture width.
    pub fn width(&self) -> u32 {
        match &self.backend {
            CaptureBackend::D3D(d3d) => d3d.width(),
            CaptureBackend::Scap(scap) => scap.width(),
        }
    }

    /// Get the capture height.
    pub fn height(&self) -> u32 {
        match &self.backend {
            CaptureBackend::D3D(d3d) => d3d.height(),
            CaptureBackend::Scap(scap) => scap.height(),
        }
    }

    /// Wait for first frame and get actual dimensions.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, CapturedFrame)> {
        match &self.backend {
            CaptureBackend::D3D(d3d) => d3d
                .wait_for_first_frame(timeout_ms)
                .map(|(w, h, f)| (w, h, f.into())),
            CaptureBackend::Scap(scap) => scap
                .wait_for_first_frame(timeout_ms)
                .map(|(w, h, f)| (w, h, f.into())),
        }
    }

    /// Get next frame with timeout.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<CapturedFrame> {
        match &self.backend {
            CaptureBackend::D3D(d3d) => d3d.get_frame(timeout_ms).map(|f| f.into()),
            CaptureBackend::Scap(scap) => scap.get_frame(timeout_ms).map(|f| f.into()),
        }
    }

    /// Stop the capture.
    pub fn stop(&mut self) {
        match &mut self.backend {
            CaptureBackend::D3D(d3d) => d3d.stop(),
            CaptureBackend::Scap(scap) => scap.stop(),
        }
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
