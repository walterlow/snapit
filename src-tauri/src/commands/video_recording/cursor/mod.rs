//! Cursor capture and compositing for video recording.
//!
//! DXGI Duplication API doesn't capture the hardware cursor by default.
//! This module extracts cursor bitmaps via Windows API and composites
//! them onto each captured frame.

mod capture;
mod composite;

pub use capture::CursorCapture;
pub use composite::composite_cursor;

use std::collections::HashMap;

/// Captured cursor state for a single frame.
#[derive(Clone)]
pub struct CursorState {
    /// Cursor is visible and should be drawn.
    pub visible: bool,
    /// Screen X position (in pixels).
    pub screen_x: i32,
    /// Screen Y position (in pixels).
    pub screen_y: i32,
    /// Hotspot X offset within cursor bitmap.
    pub hotspot_x: i32,
    /// Hotspot Y offset within cursor bitmap.
    pub hotspot_y: i32,
    /// Cursor bitmap width.
    pub width: u32,
    /// Cursor bitmap height.
    pub height: u32,
    /// BGRA pixel data (ready for blending).
    pub bgra_data: Vec<u8>,
}

impl Default for CursorState {
    fn default() -> Self {
        Self {
            visible: false,
            screen_x: 0,
            screen_y: 0,
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            bgra_data: Vec::new(),
        }
    }
}

/// Cached cursor bitmap data.
#[derive(Clone)]
pub(crate) struct CachedCursor {
    pub width: u32,
    pub height: u32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub bgra_data: Vec<u8>,
}

/// Cursor capture manager with bitmap caching.
///
/// Caches cursor bitmaps by HCURSOR handle to avoid expensive
/// GetDIBits calls every frame. The cache is invalidated when
/// the cursor handle changes (e.g., switching from arrow to I-beam).
pub struct CursorCaptureManager {
    /// Cache of cursor bitmaps by HCURSOR handle.
    pub(crate) cache: HashMap<isize, CachedCursor>,
    /// Last known cursor handle for cache lookup.
    pub(crate) last_cursor_handle: isize,
}

impl CursorCaptureManager {
    /// Create a new cursor capture manager.
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
            last_cursor_handle: 0,
        }
    }

    /// Clear the cursor bitmap cache.
    /// Useful for animated cursors where the bitmap changes.
    pub fn clear_cache(&mut self) {
        self.cache.clear();
        self.last_cursor_handle = 0;
    }
}

impl Default for CursorCaptureManager {
    fn default() -> Self {
        Self::new()
    }
}
