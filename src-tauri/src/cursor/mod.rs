//! Cursor subsystem for SnapIt.
//!
//! This module provides cursor capture, shape detection, and event handling
//! following Cap's architecture:
//!
//! - `capture`: Cursor position capture and recording during video recording
//! - `info`: Cursor shape detection and SVG asset management
//! - `events`: Cursor event types (moves, clicks)

pub mod capture;
pub mod events;
pub mod info;

// Re-export commonly used types
pub use capture::{
    spawn_cursor_recorder, Cursor, CursorActor, CursorActorResponse, CursorCropBounds, Cursors,
    NormalizedCursorPosition, PhysicalBounds, RawCursorPosition, RelativeCursorPosition,
};
pub use events::{CursorClickEvent, CursorEvents, CursorMoveEvent, XY};
pub use info::{CursorShape, CursorShapeWindows, ResolvedCursor};
