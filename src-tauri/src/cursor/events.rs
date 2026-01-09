//! Cursor event types for recording and playback.
//!
//! Mirrors Cap's project/src/cursor.rs event types:
//! - CursorMoveEvent: Mouse position changes (60Hz polling)
//! - CursorClickEvent: Mouse button events
//! - CursorEvents: Container for all cursor events

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use ts_rs::TS;

/// Debounce threshold for short-lived cursor shapes (1 second).
pub const SHORT_CURSOR_SHAPE_DEBOUNCE_MS: f64 = 1000.0;

/// 2D coordinate helper type.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct XY<T> {
    pub x: T,
    pub y: T,
}

impl<T> XY<T> {
    pub fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}

impl<T: Copy> XY<T> {
    pub fn map<U, F: Fn(T) -> U>(&self, f: F) -> XY<U> {
        XY {
            x: f(self.x),
            y: f(self.y),
        }
    }
}

/// Cursor move event with timestamp and normalized position.
///
/// Positions are normalized to 0-1 relative to the capture region.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorMoveEvent {
    /// Active keyboard modifiers (e.g., "Shift", "Ctrl").
    pub active_modifiers: Vec<String>,

    /// ID of the cursor image (references Cursors map).
    pub cursor_id: String,

    /// Timestamp in milliseconds from recording start.
    pub time_ms: f64,

    /// Normalized X position (0.0-1.0).
    pub x: f64,

    /// Normalized Y position (0.0-1.0).
    pub y: f64,
}

impl PartialOrd for CursorMoveEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.time_ms.partial_cmp(&other.time_ms)
    }
}

impl PartialEq for CursorMoveEvent {
    fn eq(&self, other: &Self) -> bool {
        self.time_ms == other.time_ms
    }
}

/// Cursor click event.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorClickEvent {
    /// Active keyboard modifiers.
    pub active_modifiers: Vec<String>,

    /// Mouse button number (0=left, 1=right, 2=middle).
    pub cursor_num: u8,

    /// ID of the cursor image.
    pub cursor_id: String,

    /// Timestamp in milliseconds from recording start.
    pub time_ms: f64,

    /// True if button pressed, false if released.
    pub down: bool,
}

impl PartialOrd for CursorClickEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.time_ms.partial_cmp(&other.time_ms)
    }
}

impl PartialEq for CursorClickEvent {
    fn eq(&self, other: &Self) -> bool {
        self.time_ms == other.time_ms
    }
}

/// Container for cursor events (moves and clicks).
#[derive(Default, Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorEvents {
    /// Click events sorted by timestamp.
    pub clicks: Vec<CursorClickEvent>,

    /// Move events sorted by timestamp.
    pub moves: Vec<CursorMoveEvent>,
}

impl CursorEvents {
    /// Load cursor events from a JSON file.
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {e}"))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {e}"))
    }

    /// Save cursor events to a JSON file.
    pub fn save_to_file(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize cursor data: {e}"))?;
        std::fs::write(path, json).map_err(|e| format!("Failed to write cursor file: {e}"))?;
        Ok(())
    }

    /// Get cursor position at a specific time (in seconds).
    pub fn cursor_position_at(&self, time_secs: f64) -> Option<XY<f64>> {
        let time_ms = time_secs * 1000.0;

        if self.moves.is_empty() {
            return None;
        }

        // Find the most recent move event before or at the given time
        let event = self
            .moves
            .iter()
            .filter(|e| e.time_ms <= time_ms)
            .max_by(|a, b| {
                a.time_ms
                    .partial_cmp(&b.time_ms)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })?;

        Some(XY::new(event.x, event.y))
    }

    /// Stabilize short-lived cursor shapes by replacing them with the dominant cursor.
    ///
    /// This prevents visual flickering when cursor briefly changes shape
    /// (e.g., I-beam cursor appearing briefly when moving over text).
    pub fn stabilize_short_lived_cursor_shapes(
        &mut self,
        pointer_ids: Option<&std::collections::HashSet<String>>,
        threshold_ms: f64,
    ) {
        if self.moves.len() < 2 {
            return;
        }

        // Build segments of consecutive cursor IDs
        let mut segments: Vec<CursorSegment> = Vec::new();
        let mut idx = 0;

        while idx < self.moves.len() {
            let start_index = idx;
            let start_time = self.moves[idx].time_ms;
            let id = self.moves[idx].cursor_id.clone();

            idx += 1;
            while idx < self.moves.len() && self.moves[idx].cursor_id == id {
                idx += 1;
            }

            segments.push(CursorSegment {
                range: start_index..idx,
                start_time,
                end_time: 0.0,
                duration: 0.0,
                id,
            });
        }

        if segments.len() < 2 {
            return;
        }

        // Calculate segment durations
        let last_move_time = self.moves.last().map(|e| e.time_ms).unwrap_or(0.0);

        for i in 0..segments.len() {
            let end_time = if i + 1 < segments.len() {
                segments[i + 1].start_time
            } else {
                last_move_time
            };

            segments[i].duration = (end_time - segments[i].start_time).max(0.0);
            segments[i].end_time = if i + 1 < segments.len() {
                end_time
            } else {
                f64::MAX
            };
        }

        // Calculate total duration per cursor ID
        let mut duration_by_id = HashMap::<String, f64>::new();
        for segment in &segments {
            *duration_by_id.entry(segment.id.clone()).or_default() += segment.duration;
        }

        // Find preferred pointer cursor
        let preferred_pointer = pointer_ids.and_then(|set| {
            segments
                .iter()
                .find(|seg| set.contains(&seg.id))
                .map(|seg| seg.id.clone())
        });

        // Find global fallback (most used cursor)
        let global_fallback = duration_by_id
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| id.clone());

        // Replace short-lived segments
        for i in 0..segments.len() {
            let segment_id = segments[i].id.clone();
            let is_pointer = pointer_ids
                .map(|set| set.contains(&segment_id))
                .unwrap_or(false);

            if segments[i].duration >= threshold_ms || is_pointer {
                continue;
            }

            let replacement = preferred_pointer
                .clone()
                .or_else(|| global_fallback.clone())
                .or_else(|| {
                    if i > 0 {
                        Some(segments[i - 1].id.clone())
                    } else {
                        None
                    }
                })
                .or_else(|| segments.get(i + 1).map(|seg| seg.id.clone()))
                .unwrap_or_else(|| segment_id.clone());

            if replacement == segment_id {
                continue;
            }

            // Update move events in this segment
            for event in &mut self.moves[segments[i].range.clone()] {
                event.cursor_id = replacement.clone();
            }
            segments[i].id = replacement;
        }

        // Update click events to match the cursor at their time
        if self.clicks.is_empty() {
            return;
        }

        let mut segment_index = 0;
        for click in &mut self.clicks {
            while segment_index + 1 < segments.len()
                && click.time_ms >= segments[segment_index].end_time
            {
                segment_index += 1;
            }
            click.cursor_id = segments[segment_index].id.clone();
        }
    }
}

/// Helper struct for cursor shape stabilization.
#[derive(Clone)]
struct CursorSegment {
    range: std::ops::Range<usize>,
    start_time: f64,
    end_time: f64,
    duration: f64,
    id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn move_event(time_ms: f64, cursor_id: &str) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: cursor_id.to_string(),
            time_ms,
            x: 0.5,
            y: 0.5,
        }
    }

    fn click_event(time_ms: f64, cursor_id: &str) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_id: cursor_id.to_string(),
            cursor_num: 0,
            down: true,
            time_ms,
        }
    }

    #[test]
    fn test_cursor_position_at() {
        let events = CursorEvents {
            moves: vec![
                CursorMoveEvent {
                    active_modifiers: vec![],
                    cursor_id: "0".to_string(),
                    time_ms: 0.0,
                    x: 0.1,
                    y: 0.2,
                },
                CursorMoveEvent {
                    active_modifiers: vec![],
                    cursor_id: "0".to_string(),
                    time_ms: 100.0,
                    x: 0.5,
                    y: 0.6,
                },
            ],
            clicks: vec![],
        };

        let pos = events.cursor_position_at(0.05).unwrap(); // 50ms
        assert_eq!(pos.x, 0.1);
        assert_eq!(pos.y, 0.2);

        let pos = events.cursor_position_at(0.15).unwrap(); // 150ms
        assert_eq!(pos.x, 0.5);
        assert_eq!(pos.y, 0.6);
    }

    #[test]
    fn test_stabilize_short_lived_cursors() {
        use std::collections::HashSet;

        let mut pointer_ids = HashSet::new();
        pointer_ids.insert("pointer".to_string());

        let mut events = CursorEvents {
            moves: vec![
                move_event(0.0, "pointer"),
                move_event(200.0, "ibeam"),
                move_event(400.0, "pointer"),
                move_event(900.0, "pointer"),
            ],
            clicks: vec![click_event(250.0, "ibeam")],
        };

        events.stabilize_short_lived_cursor_shapes(
            Some(&pointer_ids),
            SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
        );

        // All should be replaced with pointer
        assert!(events.moves.iter().all(|e| e.cursor_id == "pointer"));
        assert!(events.clicks.iter().all(|e| e.cursor_id == "pointer"));
    }

    #[test]
    fn export_bindings_xy() {
        XY::<f64>::export_all().unwrap();
    }

    #[test]
    fn export_bindings_cursormoveevent() {
        CursorMoveEvent::export_all().unwrap();
    }

    #[test]
    fn export_bindings_cursorclickevent() {
        CursorClickEvent::export_all().unwrap();
    }

    #[test]
    fn export_bindings_cursorevents() {
        CursorEvents::export_all().unwrap();
    }
}
