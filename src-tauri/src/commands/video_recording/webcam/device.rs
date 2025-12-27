//! Webcam device enumeration.
//!
//! Uses nokhwa to query available webcam devices.

use nokhwa::utils::CameraIndex;
use nokhwa::query;
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
}

/// Get a list of available webcam devices.
pub fn get_webcam_devices() -> Result<Vec<WebcamDevice>, String> {
    // Query available cameras using nokhwa
    let cameras = query(nokhwa::native_api_backend().unwrap_or(nokhwa::utils::ApiBackend::Auto))
        .map_err(|e| format!("Failed to query webcam devices: {}", e))?;

    let devices: Vec<WebcamDevice> = cameras
        .iter()
        .enumerate()
        .map(|(idx, info)| WebcamDevice {
            index: idx,
            name: info.human_name().to_string(),
            description: Some(info.description().to_string()),
        })
        .collect();

    Ok(devices)
}

/// Get the camera index for nokhwa from a device index.
pub fn camera_index_from_device(device_index: usize) -> CameraIndex {
    CameraIndex::Index(device_index as u32)
}
