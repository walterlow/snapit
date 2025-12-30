//! Webcam device enumeration.
//!
//! Device enumeration is now handled by browser's navigator.mediaDevices.enumerateDevices().
//! This module provides the type definition and a stub function for backwards compatibility.

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
///
/// Returns empty list - browser now handles device enumeration via getUserMedia.
pub fn get_webcam_devices() -> Result<Vec<WebcamDevice>, String> {
    // Browser handles device enumeration via navigator.mediaDevices.enumerateDevices()
    // This is just for backwards compatibility with the command interface
    Ok(Vec::new())
}
