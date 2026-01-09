//! Cursor shape detection and SVG asset management.
//!
//! Mirrors Cap's cursor-info crate:
//! - CursorShape: Platform-agnostic cursor shape enum
//! - CursorShapeWindows: Windows-specific cursor shapes
//! - ResolvedCursor: SVG asset and hotspot information

mod shape;

pub use shape::{CursorShape, CursorShapeWindows, ResolvedCursor};
