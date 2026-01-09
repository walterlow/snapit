//! Cursor capture during video recording.
//!
//! Provides position tracking and cursor image capture with:
//! - Physical/logical coordinate handling
//! - Crop bounds for region capture
//! - SHA256-based cursor image deduplication
//! - Background recording actor

mod position;
mod recorder;

pub use position::{
    CursorCropBounds, NormalizedCursorPosition, PhysicalBounds, RawCursorPosition,
    RelativeCursorPosition,
};
pub use recorder::{spawn_cursor_recorder, Cursor, CursorActor, CursorActorResponse, Cursors};
