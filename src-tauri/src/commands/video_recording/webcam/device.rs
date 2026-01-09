//! Webcam device enumeration using native Windows Media Foundation.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
            WebcamDevice {
                index: idx,
                name: device.name().to_string_lossy().to_string(),
                description: device.model_id().map(String::from),
                is_virtual: category.is_virtual(),
                is_capture_card: category.is_capture_card(),
            }
        })
        .collect();

    log::info!("[WEBCAM] Enumerated {} devices", result.len());
    Ok(result)
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
