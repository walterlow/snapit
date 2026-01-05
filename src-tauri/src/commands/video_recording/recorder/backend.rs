//! Capture backend abstraction.
//!
//! Provides a unified interface for DXGI and WGC capture backends,
//! allowing seamless fallback when GPU device is lost.

use windows_capture::{dxgi_duplication_api::DxgiDuplicationApi, monitor::Monitor};

use super::super::wgc_capture::WgcVideoCapture;

/// Capture backend abstraction.
///
/// Allows switching between DXGI and WGC capture methods.
pub enum CaptureBackend {
    /// DXGI Desktop Duplication (preferred, lower latency)
    Dxgi(DxgiDuplicationApi),
    /// Windows Graphics Capture (fallback, more compatible)
    Wgc(WgcVideoCapture),
}

impl CaptureBackend {
    /// Get the capture width.
    pub fn width(&self) -> u32 {
        match self {
            CaptureBackend::Dxgi(dxgi) => dxgi.width(),
            CaptureBackend::Wgc(wgc) => wgc.width(),
        }
    }

    /// Get the capture height.
    pub fn height(&self) -> u32 {
        match self {
            CaptureBackend::Dxgi(dxgi) => dxgi.height(),
            CaptureBackend::Wgc(wgc) => wgc.height(),
        }
    }

    /// Get the backend name for logging.
    pub fn name(&self) -> &'static str {
        match self {
            CaptureBackend::Dxgi(_) => "DXGI",
            CaptureBackend::Wgc(_) => "WGC",
        }
    }

    /// Create a DXGI backend for the given monitor.
    pub fn new_dxgi(monitor: Monitor) -> Result<Self, String> {
        let dxgi = DxgiDuplicationApi::new(monitor)
            .map_err(|e| format!("Failed to create DXGI duplication: {:?}", e))?;
        Ok(CaptureBackend::Dxgi(dxgi))
    }

    /// Create a WGC backend for the given monitor index.
    pub fn new_wgc(monitor_index: usize, include_cursor: bool) -> Result<Self, String> {
        let wgc = WgcVideoCapture::new(monitor_index, include_cursor)
            .map_err(|e| format!("Failed to create WGC capture: {}", e))?;
        Ok(CaptureBackend::Wgc(wgc))
    }

    /// Create a WGC backend for window capture.
    pub fn new_wgc_window(window_id: u32, include_cursor: bool) -> Result<Self, String> {
        let wgc = WgcVideoCapture::new_window(window_id, include_cursor)
            .map_err(|e| format!("Failed to create WGC window capture: {}", e))?;
        Ok(CaptureBackend::Wgc(wgc))
    }
}

/// Result of trying to acquire a frame from the capture backend.
#[allow(dead_code)]
pub enum FrameAcquireResult {
    /// Successfully acquired a frame
    Frame(Vec<u8>),
    /// No frame available (timeout)
    Timeout,
    /// GPU device was lost - should switch to WGC
    DeviceLost,
    /// Other error
    Error(String),
}

/// Try to switch from DXGI to WGC capture backend.
pub fn switch_to_wgc(monitor_index: usize, include_cursor: bool) -> Result<CaptureBackend, String> {
    log::warn!("[CAPTURE] GPU device lost, switching to WGC fallback");

    let wgc = WgcVideoCapture::new(monitor_index, include_cursor)
        .map_err(|e| format!("Failed to create WGC capture: {}", e))?;

    Ok(CaptureBackend::Wgc(wgc))
}
