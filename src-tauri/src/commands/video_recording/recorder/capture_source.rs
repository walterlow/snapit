//! Unified capture source abstraction for video recording.
//!
//! Provides a common interface for different capture backends:
//! - WGC (Windows Graphics Capture) - for monitor and window capture
//! - Scap - for region capture with built-in crop support

use super::super::scap_capture::{ScapFrame, ScapVideoCapture};
use super::super::wgc_capture::{WgcFrame, WgcVideoCapture};

/// A captured video frame.
pub struct CapturedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl From<WgcFrame> for CapturedFrame {
    fn from(f: WgcFrame) -> Self {
        CapturedFrame {
            data: f.data,
            width: f.width,
            height: f.height,
        }
    }
}

impl From<ScapFrame> for CapturedFrame {
    fn from(f: ScapFrame) -> Self {
        CapturedFrame {
            data: f.data,
            width: f.width,
            height: f.height,
        }
    }
}

/// Unified capture source that can use either WGC or Scap.
pub enum CaptureSource {
    /// WGC-based capture (monitor or window)
    Wgc(WgcVideoCapture),
    /// Scap-based capture (region with built-in crop)
    Scap(ScapVideoCapture),
}

impl CaptureSource {
    /// Create a capture source for a monitor.
    pub fn new_monitor(monitor_index: usize, include_cursor: bool) -> Result<Self, String> {
        let wgc = WgcVideoCapture::new(monitor_index, include_cursor)?;
        Ok(CaptureSource::Wgc(wgc))
    }

    /// Create a capture source for a window.
    pub fn new_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        let wgc = WgcVideoCapture::new_window(window_id, include_cursor)?;
        Ok(CaptureSource::Wgc(wgc))
    }

    /// Create a capture source for a region using scap's built-in crop.
    ///
    /// This uses scap's crop_area feature which handles cropping internally,
    /// ensuring cursor coordinates and video frames are in the same space.
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
        // Debug log
        let debug_info = format!(
            "\n=== USING SCAP FOR REGION CAPTURE ===\nMonitor index: {}\nRegion (screen): ({}, {}) {}x{}\nMonitor offset: ({}, {})\nFPS: {}\nInclude cursor: {}\n",
            monitor_index, region.0, region.1, region.2, region.3, monitor_offset.0, monitor_offset.1, fps, include_cursor
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("T:\\PersonalProjects\\snapit\\ultradebug.log")
        {
            let _ = std::io::Write::write_all(&mut f, debug_info.as_bytes());
        }

        let scap = ScapVideoCapture::new_region(
            monitor_index,
            Some(region),
            monitor_offset,
            fps,
            include_cursor,
        )?;
        Ok(CaptureSource::Scap(scap))
    }

    /// Get the capture width.
    pub fn width(&self) -> u32 {
        match self {
            CaptureSource::Wgc(wgc) => wgc.width(),
            CaptureSource::Scap(scap) => scap.width(),
        }
    }

    /// Get the capture height.
    pub fn height(&self) -> u32 {
        match self {
            CaptureSource::Wgc(wgc) => wgc.height(),
            CaptureSource::Scap(scap) => scap.height(),
        }
    }

    /// Wait for first frame and get actual dimensions.
    pub fn wait_for_first_frame(&self, timeout_ms: u64) -> Option<(u32, u32, CapturedFrame)> {
        match self {
            CaptureSource::Wgc(wgc) => wgc
                .wait_for_first_frame(timeout_ms)
                .map(|(w, h, f)| (w, h, f.into())),
            CaptureSource::Scap(scap) => scap
                .wait_for_first_frame(timeout_ms)
                .map(|(w, h, f)| (w, h, f.into())),
        }
    }

    /// Get next frame with timeout.
    pub fn get_frame(&self, timeout_ms: u64) -> Option<CapturedFrame> {
        match self {
            CaptureSource::Wgc(wgc) => wgc.get_frame(timeout_ms).map(|f| f.into()),
            CaptureSource::Scap(scap) => scap.get_frame(timeout_ms).map(|f| f.into()),
        }
    }

    /// Stop the capture.
    pub fn stop(&self) {
        match self {
            CaptureSource::Wgc(wgc) => wgc.stop(),
            CaptureSource::Scap(scap) => scap.stop(),
        }
    }

    /// Check if this is a scap-based capture (no manual cropping needed).
    pub fn is_scap(&self) -> bool {
        matches!(self, CaptureSource::Scap(_))
    }
}
