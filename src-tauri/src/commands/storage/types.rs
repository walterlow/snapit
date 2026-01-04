//! Type definitions for storage operations.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Event emitted when a thumbnail is generated
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailReadyEvent {
    pub capture_id: String,
    pub thumbnail_path: String,
}

/// Region coordinates for capture selection.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Source information for a capture.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CaptureSource {
    pub monitor: Option<u32>,
    pub window_id: Option<u32>,
    pub window_title: Option<String>,
    pub region: Option<Region>,
}

/// Image dimensions.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

/// Annotation on a capture.
/// Note: This type uses serde(flatten) which ts-rs can't handle automatically,
/// so we define the TypeScript type manually in src/types/index.ts.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    #[serde(flatten)]
    pub properties: serde_json::Value,
}

/// Full capture project data.
/// Note: Contains Annotation type with serde(flatten) which ts-rs can't handle.
/// The TypeScript type is manually defined in src/types/index.ts.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureProject {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub capture_type: String,
    pub source: CaptureSource,
    pub original_image: String,
    pub dimensions: Dimensions,
    pub annotations: Vec<Annotation>,
    pub tags: Vec<String>,
    pub favorite: bool,
}

/// Lightweight capture item for list display.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CaptureListItem {
    pub id: String,
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "string")]
    pub updated_at: DateTime<Utc>,
    pub capture_type: String,
    pub dimensions: Dimensions,
    pub thumbnail_path: String,
    pub image_path: String,
    pub has_annotations: bool,
    pub tags: Vec<String>,
    pub favorite: bool,
    /// True if the original image file is missing from disk
    pub is_missing: bool,
}

/// Request to save a new capture.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct SaveCaptureRequest {
    pub image_data: String,
    pub capture_type: String,
    pub source: CaptureSource,
}

/// Response after saving a capture.
/// Note: Contains CaptureProject which has Annotation with serde(flatten).
/// The TypeScript type is manually defined in src/types/index.ts.
#[derive(Debug, Serialize, Deserialize)]
pub struct SaveCaptureResponse {
    pub id: String,
    pub project: CaptureProject,
    pub thumbnail_path: String,
    pub image_path: String,
}

/// Storage statistics.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct StorageStats {
    #[ts(type = "number")]
    pub total_size_bytes: u64,
    pub total_size_mb: f64,
    #[ts(type = "number")]
    pub capture_count: u32,
    pub storage_path: String,
}

/// Result of startup cleanup operation.
#[derive(Debug, Serialize)]
pub struct StartupCleanupResult {
    pub temp_files_cleaned: u32,
    pub thumbnails_regenerated: u32,
}
