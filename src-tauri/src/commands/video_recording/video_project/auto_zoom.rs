//! Auto-zoom generation from cursor recording data.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::types::{EasingFunction, VideoProject, ZoomRegion, ZoomRegionMode, ZoomTransition};
use crate::commands::video_recording::cursor::{load_cursor_recording, CursorEventType};

// ============================================================================
// Auto-Zoom Configuration
// ============================================================================

/// Configuration for auto-zoom generation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AutoZoomConfig {
    /// Zoom scale factor (e.g., 2.0 = 2x zoom).
    pub scale: f32,
    /// How long to hold the zoom at the click location (ms).
    pub hold_duration_ms: u32,
    /// Minimum gap between zoom regions (ms). Clicks closer than this are merged.
    pub min_gap_ms: u32,
    /// Transition in duration (ms).
    pub transition_in_ms: u32,
    /// Transition out duration (ms).
    pub transition_out_ms: u32,
    /// Easing function for transitions.
    pub easing: EasingFunction,
    /// Only include left clicks (ignore right/middle clicks).
    pub left_clicks_only: bool,
}

impl Default for AutoZoomConfig {
    fn default() -> Self {
        Self {
            scale: 2.0,
            hold_duration_ms: 1500,
            min_gap_ms: 500,
            transition_in_ms: 300,
            transition_out_ms: 300,
            easing: EasingFunction::EaseInOut,
            left_clicks_only: true,
        }
    }
}

// ============================================================================
// Auto-Zoom Generation
// ============================================================================

/// Generate auto-zoom regions from cursor recording data.
///
/// This function:
/// 1. Loads the cursor recording from the JSON file
/// 2. Filters for click events (left clicks by default)
/// 3. Creates ZoomRegion entries for each click
/// 4. Merges clicks that are too close together
/// 5. Normalizes coordinates to 0-1 range using region dimensions from the recording
///
/// # Arguments
/// * `cursor_data_path` - Path to the cursor recording JSON file
/// * `config` - Auto-zoom configuration settings
///
/// # Returns
/// Vector of ZoomRegion entries sorted by start time
pub fn generate_auto_zoom_regions(
    cursor_data_path: &std::path::Path,
    config: &AutoZoomConfig,
) -> Result<Vec<ZoomRegion>, String> {
    // Load cursor recording
    let recording = load_cursor_recording(cursor_data_path)?;

    // Filter for click events
    let clicks: Vec<_> = recording
        .events
        .iter()
        .filter(|e| match &e.event_type {
            CursorEventType::LeftClick { pressed: true } => true,
            CursorEventType::RightClick { pressed: true } if !config.left_clicks_only => true,
            CursorEventType::MiddleClick { pressed: true } if !config.left_clicks_only => true,
            _ => false,
        })
        .collect();

    if clicks.is_empty() {
        log::info!("[AUTO_ZOOM] No click events found in cursor recording");
        return Ok(Vec::new());
    }

    log::info!(
        "[AUTO_ZOOM] Found {} click events, region: {}x{}",
        clicks.len(),
        recording.width,
        recording.height
    );

    // Generate zoom regions
    let mut regions: Vec<ZoomRegion> = Vec::new();

    for click in clicks {
        // Cursor events already have normalized (0-1) coordinates
        let target_x = (click.x as f32).clamp(0.0, 1.0);
        let target_y = (click.y as f32).clamp(0.0, 1.0);

        // Check if this click is too close to the previous one
        if let Some(last_region) = regions.last_mut() {
            let gap = click.timestamp_ms.saturating_sub(last_region.end_ms);

            if gap < config.min_gap_ms as u64 {
                // Extend the previous region instead of creating a new one
                last_region.end_ms = click.timestamp_ms + config.hold_duration_ms as u64;
                log::debug!(
                    "[AUTO_ZOOM] Extended region {} to {}ms (merged close click)",
                    last_region.id,
                    last_region.end_ms
                );
                continue;
            }
        }

        // Create new zoom region
        let region_id = format!(
            "auto_zoom_{}_{:08x}",
            click.timestamp_ms,
            rand::random::<u32>()
        );

        let region = ZoomRegion {
            id: region_id,
            start_ms: click.timestamp_ms,
            end_ms: click.timestamp_ms + config.hold_duration_ms as u64,
            scale: config.scale,
            target_x,
            target_y,
            mode: ZoomRegionMode::Auto, // Auto-generated zooms follow cursor
            is_auto: true,
            transition: ZoomTransition {
                duration_in_ms: config.transition_in_ms,
                duration_out_ms: config.transition_out_ms,
                easing: config.easing,
            },
        };

        log::debug!(
            "[AUTO_ZOOM] Created region at {}ms, target ({:.2}, {:.2})",
            region.start_ms,
            target_x,
            target_y
        );

        regions.push(region);
    }

    log::info!("[AUTO_ZOOM] Generated {} zoom regions", regions.len());

    Ok(regions)
}

/// Apply auto-zoom to a video project.
///
/// Generates zoom regions from cursor data and adds them to the project.
/// Existing auto-generated regions are removed; manual regions are preserved.
///
/// # Arguments
/// * `project` - The video project to modify
/// * `config` - Auto-zoom configuration settings
///
/// # Returns
/// Updated project with new auto-zoom regions
pub fn apply_auto_zoom_to_project(
    mut project: VideoProject,
    config: &AutoZoomConfig,
) -> Result<VideoProject, String> {
    // Check if cursor data exists
    let cursor_path = match &project.sources.cursor_data {
        Some(path) => std::path::Path::new(path),
        None => return Err("No cursor data available for this project".to_string()),
    };

    if !cursor_path.exists() {
        return Err(format!("Cursor data file not found: {:?}", cursor_path));
    }

    // Generate new auto-zoom regions
    // Uses region dimensions from the cursor recording for coordinate normalization
    let new_regions = generate_auto_zoom_regions(cursor_path, config)?;

    // Remove existing auto-generated regions, keep manual ones
    project.zoom.regions.retain(|r| !r.is_auto);

    // Add new auto-generated regions
    project.zoom.regions.extend(new_regions);

    // Sort all regions by start time
    project.zoom.regions.sort_by_key(|r| r.start_ms);

    // Update timestamp
    project.updated_at = chrono::Utc::now().to_rfc3339();

    Ok(project)
}
