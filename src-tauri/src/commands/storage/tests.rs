//! Unit tests for the storage module.
//!
//! These tests focus on pure logic and serialization without I/O dependencies.

use chrono::Utc;

use super::ffmpeg::THUMBNAIL_SIZE;
use super::generate_id;
use super::types::*;

#[test]
fn test_generate_id_format() {
    let id = generate_id();

    // ID should be non-empty
    assert!(!id.is_empty());

    // ID should be hexadecimal (contains only 0-9, a-f)
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));

    // ID should be reasonably long (timestamp + random)
    assert!(id.len() >= 12, "ID too short: {}", id);
}

#[test]
fn test_generate_id_uniqueness() {
    let mut ids = std::collections::HashSet::new();
    for _ in 0..100 {
        let id = generate_id();
        assert!(ids.insert(id.clone()), "Duplicate ID generated: {}", id);
    }
}

#[test]
fn test_thumbnail_size_constant() {
    assert_eq!(THUMBNAIL_SIZE, 400);
}

#[test]
fn test_capture_source_serialization() {
    let source = CaptureSource {
        monitor: Some(0),
        window_id: Some(12345),
        window_title: Some("Test Window".to_string()),
        region: Some(Region {
            x: 100,
            y: 200,
            width: 800,
            height: 600,
        }),
    };

    // Serialize to JSON
    let json = serde_json::to_string(&source).expect("Failed to serialize");

    // Deserialize back
    let restored: CaptureSource = serde_json::from_str(&json).expect("Failed to deserialize");

    assert_eq!(restored.monitor, Some(0));
    assert_eq!(restored.window_id, Some(12345));
    assert_eq!(restored.window_title, Some("Test Window".to_string()));
    assert!(restored.region.is_some());
    let region = restored.region.unwrap();
    assert_eq!(region.x, 100);
    assert_eq!(region.y, 200);
    assert_eq!(region.width, 800);
    assert_eq!(region.height, 600);
}

#[test]
fn test_capture_source_with_nulls() {
    let source = CaptureSource {
        monitor: None,
        window_id: None,
        window_title: None,
        region: None,
    };

    let json = serde_json::to_string(&source).expect("Failed to serialize");
    let restored: CaptureSource = serde_json::from_str(&json).expect("Failed to deserialize");

    assert!(restored.monitor.is_none());
    assert!(restored.window_id.is_none());
    assert!(restored.window_title.is_none());
    assert!(restored.region.is_none());
}

#[test]
fn test_dimensions_serialization() {
    let dims = Dimensions {
        width: 1920,
        height: 1080,
    };

    let json = serde_json::to_string(&dims).expect("Failed to serialize");
    assert!(json.contains("1920"));
    assert!(json.contains("1080"));

    let restored: Dimensions = serde_json::from_str(&json).expect("Failed to deserialize");
    assert_eq!(restored.width, 1920);
    assert_eq!(restored.height, 1080);
}

#[test]
fn test_annotation_serialization() {
    let annotation = Annotation {
        id: "test-annotation-1".to_string(),
        annotation_type: "rectangle".to_string(),
        properties: serde_json::json!({
            "x": 100,
            "y": 200,
            "width": 300,
            "height": 150,
            "color": "#ff0000"
        }),
    };

    let json = serde_json::to_string(&annotation).expect("Failed to serialize");

    // Check that "type" is renamed from "annotation_type"
    assert!(json.contains("\"type\":"));
    assert!(!json.contains("\"annotation_type\":"));

    let restored: Annotation = serde_json::from_str(&json).expect("Failed to deserialize");
    assert_eq!(restored.id, "test-annotation-1");
    assert_eq!(restored.annotation_type, "rectangle");
}

#[test]
fn test_capture_project_serialization() {
    use chrono::TimeZone;

    let now = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();

    let project = CaptureProject {
        id: "test-project-1".to_string(),
        created_at: now,
        updated_at: now,
        capture_type: "region".to_string(),
        source: CaptureSource {
            monitor: Some(0),
            window_id: None,
            window_title: None,
            region: Some(Region {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }),
        },
        original_image: "image.png".to_string(),
        dimensions: Dimensions {
            width: 1920,
            height: 1080,
        },
        annotations: vec![],
        tags: vec!["screenshot".to_string(), "test".to_string()],
        favorite: true,
    };

    let json = serde_json::to_string_pretty(&project).expect("Failed to serialize");

    // Verify key fields are present
    assert!(json.contains("test-project-1"));
    assert!(json.contains("region"));
    assert!(json.contains("1920"));
    assert!(json.contains("screenshot"));
    assert!(json.contains("\"favorite\": true"));

    // Round-trip
    let restored: CaptureProject = serde_json::from_str(&json).expect("Failed to deserialize");
    assert_eq!(restored.id, "test-project-1");
    assert_eq!(restored.capture_type, "region");
    assert_eq!(restored.dimensions.width, 1920);
    assert_eq!(restored.tags.len(), 2);
    assert!(restored.favorite);
}

#[test]
fn test_capture_list_item_serialization() {
    use chrono::TimeZone;

    let now = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();

    let item = CaptureListItem {
        id: "list-item-1".to_string(),
        created_at: now,
        updated_at: now,
        capture_type: "fullscreen".to_string(),
        dimensions: Dimensions {
            width: 2560,
            height: 1440,
        },
        thumbnail_path: "/path/to/thumbnail.png".to_string(),
        image_path: "/path/to/image.png".to_string(),
        has_annotations: false,
        tags: vec![],
        favorite: false,
        is_missing: false,
    };

    let json = serde_json::to_string(&item).expect("Failed to serialize");

    let restored: CaptureListItem = serde_json::from_str(&json).expect("Failed to deserialize");
    assert_eq!(restored.id, "list-item-1");
    assert_eq!(restored.capture_type, "fullscreen");
    assert_eq!(restored.dimensions.width, 2560);
    assert!(!restored.has_annotations);
    assert!(!restored.is_missing);
}

#[test]
fn test_storage_stats_serialization() {
    let stats = StorageStats {
        total_size_bytes: 1_073_741_824, // 1 GB
        total_size_mb: 1024.0,
        capture_count: 150,
        storage_path: "/Users/test/Pictures/SnapIt".to_string(),
    };

    let json = serde_json::to_string(&stats).expect("Failed to serialize");

    assert!(json.contains("1073741824"));
    assert!(json.contains("1024"));
    assert!(json.contains("150"));
}

#[test]
fn test_save_capture_request_serialization() {
    let request = SaveCaptureRequest {
        image_data: "base64encodeddata...".to_string(),
        capture_type: "window".to_string(),
        source: CaptureSource {
            monitor: None,
            window_id: Some(54321),
            window_title: Some("Chrome".to_string()),
            region: None,
        },
    };

    let json = serde_json::to_string(&request).expect("Failed to serialize");

    let restored: SaveCaptureRequest = serde_json::from_str(&json).expect("Failed to deserialize");
    assert_eq!(restored.capture_type, "window");
    assert_eq!(restored.source.window_id, Some(54321));
}

#[test]
fn test_region_boundary_values() {
    // Test with edge case values
    let region = Region {
        x: i32::MIN,
        y: i32::MAX,
        width: 0,
        height: u32::MAX,
    };

    let json = serde_json::to_string(&region).expect("Failed to serialize");
    let restored: Region = serde_json::from_str(&json).expect("Failed to deserialize");

    assert_eq!(restored.x, i32::MIN);
    assert_eq!(restored.y, i32::MAX);
    assert_eq!(restored.width, 0);
    assert_eq!(restored.height, u32::MAX);
}
