//! Webcam device enumeration using native Windows Media Foundation.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Supported resolution presets that a webcam can handle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct SupportedResolutions {
    /// Whether the webcam supports 4K (3840x2160 or higher).
    pub supports_4k: bool,
    /// Whether the webcam supports 1080p (1920x1080).
    pub supports_1080p: bool,
    /// Whether the webcam supports 720p (1280x720).
    pub supports_720p: bool,
    /// Whether the webcam supports 480p (640x480).
    pub supports_480p: bool,
    /// Maximum resolution width.
    pub max_width: u32,
    /// Maximum resolution height.
    pub max_height: u32,
}

impl Default for SupportedResolutions {
    fn default() -> Self {
        Self {
            supports_4k: false,
            supports_1080p: false,
            supports_720p: true, // Most webcams support at least 720p
            supports_480p: true,
            max_width: 1280,
            max_height: 720,
        }
    }
}

/// Information about an available webcam device.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebcamDevice {
    /// Device index for selection.
    pub index: usize,
    /// Human-readable device name.
    pub name: String,
    /// Device description (if available).
    pub description: Option<String>,
    /// Whether this is a virtual camera (OBS, Snap Camera, etc.).
    pub is_virtual: bool,
    /// Whether this is a capture card (Elgato, etc.).
    pub is_capture_card: bool,
    /// Supported resolution presets for this device.
    pub supported_resolutions: SupportedResolutions,
}

/// Get a list of available webcam devices using native Media Foundation.
pub fn get_webcam_devices() -> Result<Vec<WebcamDevice>, String> {
    let devices = snapit_camera_windows::get_devices()
        .map_err(|e| format!("Failed to enumerate webcam devices: {}", e))?;

    let result: Vec<WebcamDevice> = devices
        .iter()
        .enumerate()
        .map(|(idx, device)| {
            let category = device.category();

            // Query supported resolutions from device formats
            let supported_resolutions = query_supported_resolutions(device);

            WebcamDevice {
                index: idx,
                name: device.name().to_string_lossy().to_string(),
                description: device.model_id().map(String::from),
                is_virtual: category.is_virtual(),
                is_capture_card: category.is_capture_card(),
                supported_resolutions,
            }
        })
        .collect();

    log::info!("[WEBCAM] Enumerated {} devices", result.len());
    Ok(result)
}

/// Query supported resolutions from a device's format list.
fn query_supported_resolutions(
    device: &snapit_camera_windows::VideoDevice,
) -> SupportedResolutions {
    let formats = device.formats();

    if formats.is_empty() {
        log::warn!(
            "[WEBCAM] No formats found for device: {}",
            device.name().to_string_lossy()
        );
        return SupportedResolutions::default();
    }

    // Find max resolution
    let (max_width, max_height) = formats
        .iter()
        .map(|f| (f.width(), f.height()))
        .max_by_key(|(w, h)| (*w as u64) * (*h as u64))
        .unwrap_or((1280, 720));

    // Check for specific resolution support
    // A resolution is "supported" if any format is at least that size
    let supports_4k = formats
        .iter()
        .any(|f| f.width() >= 3840 && f.height() >= 2160);
    let supports_1080p = formats
        .iter()
        .any(|f| f.width() >= 1920 && f.height() >= 1080);
    let supports_720p = formats
        .iter()
        .any(|f| f.width() >= 1280 && f.height() >= 720);
    let supports_480p = formats
        .iter()
        .any(|f| f.width() >= 640 && f.height() >= 480);

    log::debug!(
        "[WEBCAM] Device '{}' resolutions: 4K={} 1080p={} 720p={} 480p={} max={}x{}",
        device.name().to_string_lossy(),
        supports_4k,
        supports_1080p,
        supports_720p,
        supports_480p,
        max_width,
        max_height
    );

    SupportedResolutions {
        supports_4k,
        supports_1080p,
        supports_720p,
        supports_480p,
        max_width,
        max_height,
    }
}

/// Get a specific device by index.
pub fn get_device_by_index(index: usize) -> Result<snapit_camera_windows::VideoDevice, String> {
    let devices = snapit_camera_windows::get_devices()
        .map_err(|e| format!("Failed to enumerate webcam devices: {}", e))?;

    devices
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("Device index {} not found", index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::TS;

    #[test]
    fn export_bindings_webcam_device() {
        WebcamDevice::export_all().unwrap();
    }

    #[test]
    fn export_bindings_supported_resolutions() {
        SupportedResolutions::export_all().unwrap();
    }
}
