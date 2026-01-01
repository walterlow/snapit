//! Webcam device enumeration using nokhwa.

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

/// Get a list of available webcam devices using nokhwa.
pub fn get_webcam_devices() -> Result<Vec<WebcamDevice>, String> {
    use nokhwa::native_api_backend;
    use nokhwa::query;

    let backend = native_api_backend().ok_or_else(|| "No camera backend available".to_string())?;

    let devices = query(backend).map_err(|e| format!("Failed to query webcam devices: {}", e))?;

    let result: Vec<WebcamDevice> = devices
        .iter()
        .enumerate()
        .map(|(idx, info)| WebcamDevice {
            index: idx,
            name: info.human_name().to_string(),
            description: Some(format!(
                "Index: {}",
                info.index().as_index().unwrap_or(idx as u32)
            )),
        })
        .collect();

    eprintln!("[WEBCAM] Enumerated {} devices", result.len());
    Ok(result)
}
