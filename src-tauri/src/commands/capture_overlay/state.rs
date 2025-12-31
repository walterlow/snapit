//! Overlay state management with logical sub-structs.
//!
//! This module defines the complete state for the capture overlay, organized
//! into logical sub-structs for clarity and maintainability.
//!
//! # State Organization
//!
//! - `MonitorInfo` - Virtual screen bounds and coordinate conversion
//! - `DragState` - Initial region selection (mouse drag)
//! - `AdjustmentState` - Post-selection resize/move
//! - `CursorState` - Current cursor position and hovered window
//! - `ResultState` - Final selection result
//! - `GraphicsState` - All graphics resources (boxed)
//! - `OverlayState` - Complete overlay state

use std::time::Instant;

use tauri::AppHandle;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::DirectComposition::IDCompositionDevice;
use windows::Win32::Graphics::Dxgi::IDXGISwapChain1;

use super::graphics::{CompositorResources, D2DResources};
use super::types::*;

// ============================================================================
// Monitor Info
// ============================================================================

/// Monitor/virtual screen information for the overlay.
#[derive(Debug, Clone)]
pub struct MonitorInfo {
    /// Screen X coordinate of virtual screen origin
    pub x: i32,
    /// Screen Y coordinate of virtual screen origin
    pub y: i32,
    /// Virtual screen width in pixels
    pub width: u32,
    /// Virtual screen height in pixels
    pub height: u32,
}

impl MonitorInfo {
    /// Create monitor info from bounds
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Get the virtual screen bounds as a Rect
    pub fn bounds(&self) -> Rect {
        Rect::from_xywh(self.x, self.y, self.width, self.height)
    }

    /// Convert screen coordinates to local overlay coordinates
    pub fn screen_to_local(&self, screen_x: i32, screen_y: i32) -> Point {
        Point::new(screen_x - self.x, screen_y - self.y)
    }

    /// Convert local overlay coordinates to screen coordinates
    pub fn local_to_screen(&self, local: Point) -> Point {
        Point::new(local.x + self.x, local.y + self.y)
    }

    /// Convert a local rect to screen coordinates
    pub fn local_rect_to_screen(&self, r: Rect) -> Rect {
        r.offset(self.x, self.y)
    }

    /// Convert a screen rect to local coordinates
    pub fn screen_rect_to_local(&self, r: Rect) -> Rect {
        r.offset(-self.x, -self.y)
    }
}

// ============================================================================
// Drag State (Initial Selection)
// ============================================================================

/// State for initial region selection via mouse drag.
#[derive(Debug, Clone, Default)]
pub struct DragState {
    /// True if mouse button is down
    pub is_active: bool,
    /// True if mouse has been dragged past threshold
    pub is_dragging: bool,
    /// Drag start position (local coords)
    pub start: Point,
    /// Current drag position (local coords)
    pub current: Point,
    /// Shift key held (for square constraint)
    pub shift_held: bool,
}

impl DragState {
    /// Get the selection rectangle from current drag state.
    ///
    /// Normalizes coordinates so left < right and top < bottom.
    /// If shift is held, constrains to a square.
    pub fn selection_rect(&self) -> Rect {
        let mut r = Rect {
            left: self.start.x.min(self.current.x),
            top: self.start.y.min(self.current.y),
            right: self.start.x.max(self.current.x),
            bottom: self.start.y.max(self.current.y),
        };

        if self.shift_held {
            let size = (r.width() as i32).max(r.height() as i32);
            // Expand in the direction of the drag
            if self.current.x >= self.start.x {
                r.right = r.left + size;
            } else {
                r.left = r.right - size;
            }
            if self.current.y >= self.start.y {
                r.bottom = r.top + size;
            } else {
                r.top = r.bottom - size;
            }
        }

        r
    }

    /// Check if the drag distance exceeds the threshold
    pub fn exceeds_threshold(&self) -> bool {
        let dx = (self.current.x - self.start.x).abs();
        let dy = (self.current.y - self.start.y).abs();
        dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD
    }

    /// Reset drag state
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// ============================================================================
// Adjustment State (Post-Selection Resize/Move)
// ============================================================================

/// State for adjustment mode (resize/move after initial selection).
#[derive(Debug, Clone, Default)]
pub struct AdjustmentState {
    /// True when in adjustment mode
    pub is_active: bool,
    /// True when selection is locked (display/window mode - no resize/move allowed)
    pub is_locked: bool,
    /// Currently selected handle (if dragging)
    pub handle: HandlePosition,
    /// True when dragging a handle
    pub is_dragging: bool,
    /// Mouse position when drag started
    pub drag_start: Point,
    /// Current selection bounds in local coordinates
    pub bounds: Rect,
    /// Original bounds when drag started (for delta calculation)
    pub original_bounds: Rect,
}

impl AdjustmentState {
    /// Apply a mouse movement delta to the current handle.
    ///
    /// Updates bounds based on which handle is being dragged.
    pub fn apply_delta(&mut self, dx: i32, dy: i32) {
        match self.handle {
            HandlePosition::TopLeft => {
                self.bounds.left = self.original_bounds.left + dx;
                self.bounds.top = self.original_bounds.top + dy;
            }
            HandlePosition::Top => {
                self.bounds.top = self.original_bounds.top + dy;
            }
            HandlePosition::TopRight => {
                self.bounds.right = self.original_bounds.right + dx;
                self.bounds.top = self.original_bounds.top + dy;
            }
            HandlePosition::Right => {
                self.bounds.right = self.original_bounds.right + dx;
            }
            HandlePosition::BottomRight => {
                self.bounds.right = self.original_bounds.right + dx;
                self.bounds.bottom = self.original_bounds.bottom + dy;
            }
            HandlePosition::Bottom => {
                self.bounds.bottom = self.original_bounds.bottom + dy;
            }
            HandlePosition::BottomLeft => {
                self.bounds.left = self.original_bounds.left + dx;
                self.bounds.bottom = self.original_bounds.bottom + dy;
            }
            HandlePosition::Left => {
                self.bounds.left = self.original_bounds.left + dx;
            }
            HandlePosition::Interior => {
                self.bounds = self.original_bounds.offset(dx, dy);
            }
            HandlePosition::None => {}
        }

        // Ensure minimum size
        self.bounds = self.bounds.ensure_min_size(MIN_SELECTION_SIZE);
    }

    /// Start dragging a handle.
    /// Does nothing if the selection is locked (display/window mode).
    pub fn start_drag(&mut self, handle: HandlePosition, mouse: Point) {
        if self.is_locked {
            return; // Don't allow drag when locked
        }
        self.handle = handle;
        self.is_dragging = true;
        self.drag_start = mouse;
        self.original_bounds = self.bounds;
    }

    /// End the current drag operation
    pub fn end_drag(&mut self) {
        self.is_dragging = false;
        self.handle = HandlePosition::None;
    }

    /// Enter adjustment mode with given bounds
    pub fn enter(&mut self, bounds: Rect) {
        self.is_active = true;
        self.is_locked = false;
        self.bounds = bounds;
        self.is_dragging = false;
        self.handle = HandlePosition::None;
    }

    /// Enter adjustment mode with locked bounds (no resize/move allowed).
    /// Used for display and window selection modes.
    pub fn enter_locked(&mut self, bounds: Rect) {
        self.is_active = true;
        self.is_locked = true;
        self.bounds = bounds;
        self.is_dragging = false;
        self.handle = HandlePosition::None;
    }

    /// Exit adjustment mode
    pub fn exit(&mut self) {
        self.is_active = false;
        self.bounds = Rect::default();
        self.is_dragging = false;
        self.handle = HandlePosition::None;
    }

    /// Reset adjustment state
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// ============================================================================
// Cursor State
// ============================================================================

/// Current cursor state.
#[derive(Debug, Clone, Default)]
pub struct CursorState {
    /// Current cursor position in local coordinates
    pub position: Point,
    /// Window currently under cursor (for window selection mode)
    pub hovered_window: Option<DetectedWindow>,
}

impl CursorState {
    /// Update cursor position
    pub fn set_position(&mut self, x: i32, y: i32) {
        self.position = Point::new(x, y);
    }

    /// Clear hovered window
    pub fn clear_hovered(&mut self) {
        self.hovered_window = None;
    }
}

// ============================================================================
// Result State
// ============================================================================

/// Final selection result.
#[derive(Debug, Clone, Default)]
pub struct ResultState {
    /// True if selection was confirmed (not cancelled)
    pub confirmed: bool,
    /// The action to take
    pub action: OverlayAction,
    /// Final selection in screen coordinates
    pub selection: Option<Rect>,
    /// Window ID (HWND) if a window was selected
    pub window_id: Option<isize>,
}

impl ResultState {
    /// Set the result to confirmed with given bounds and action
    pub fn confirm(&mut self, bounds: Rect, action: OverlayAction) {
        self.confirmed = true;
        self.action = action;
        self.selection = Some(bounds);
        self.window_id = None;
    }

    /// Set the result to confirmed with window capture
    pub fn confirm_window(&mut self, bounds: Rect, action: OverlayAction, window_id: isize) {
        self.confirmed = true;
        self.action = action;
        self.selection = Some(bounds);
        self.window_id = Some(window_id);
    }

    /// Set the result to cancelled
    pub fn cancel(&mut self) {
        self.confirmed = false;
        self.action = OverlayAction::Cancelled;
        self.selection = None;
        self.window_id = None;
    }
}

// ============================================================================
// Graphics State
// ============================================================================

/// All graphics resources for rendering.
///
/// Kept in a separate struct to reduce the size of OverlayState on the stack.
pub struct GraphicsState {
    /// DXGI swap chain for composition
    pub swap_chain: IDXGISwapChain1,
    /// DirectComposition device (needed for Commit)
    pub comp_device: IDCompositionDevice,
    /// DirectComposition resources
    pub compositor: CompositorResources,
    /// Direct2D resources
    pub d2d: D2DResources,
}

// ============================================================================
// Main Overlay State
// ============================================================================

/// Complete overlay state.
///
/// This is the main state struct that holds everything needed for the overlay
/// to function. It's stored in the window's user data and accessed from the
/// window procedure.
pub struct OverlayState {
    // Tauri integration
    /// Tauri app handle for emitting events
    pub app_handle: AppHandle,
    /// Type of capture being performed
    pub capture_type: CaptureType,
    /// Overlay selection mode (display/window/region)
    pub overlay_mode: OverlayMode,

    // Win32 window
    /// Handle to the overlay window
    pub hwnd: HWND,

    // Monitor/screen info
    /// Virtual screen bounds
    pub monitor: MonitorInfo,

    // Selection state
    /// Initial drag selection state
    pub drag: DragState,
    /// Post-selection adjustment state
    pub adjustment: AdjustmentState,
    /// Cursor position and hovered window
    pub cursor: CursorState,
    /// Preselected window HWND (for window capture mode)
    pub preselected_window_id: Option<isize>,
    /// Preselected window title (for window capture mode)
    pub preselected_window_title: Option<String>,
    /// Preselected monitor index (for display capture mode)
    pub preselected_monitor_index: Option<usize>,
    /// Preselected monitor name (for display capture mode)
    pub preselected_monitor_name: Option<String>,

    // Graphics resources (boxed to reduce struct size)
    /// All graphics resources
    pub graphics: Box<GraphicsState>,

    // Control flags
    /// True when overlay should close
    pub should_close: bool,
    /// Last time an event was emitted (for throttling)
    pub last_emit_time: Instant,

    // Result
    /// Final result of the overlay
    pub result: ResultState,
}

impl OverlayState {
    /// Get the current selection bounds in screen coordinates.
    ///
    /// Returns the appropriate selection based on current state:
    /// - If adjusting: the adjustment bounds
    /// - If dragging: the drag selection
    /// - If hovering window: the window bounds
    /// - Otherwise: None
    pub fn get_screen_selection(&self) -> Option<Rect> {
        if self.adjustment.is_active {
            Some(self.monitor.local_rect_to_screen(self.adjustment.bounds))
        } else if self.drag.is_dragging {
            Some(self.monitor.local_rect_to_screen(self.drag.selection_rect()))
        } else if let Some(ref win) = self.cursor.hovered_window {
            Some(win.bounds)
        } else {
            None
        }
    }

    /// Get the current selection bounds in local coordinates.
    pub fn get_local_selection(&self) -> Option<Rect> {
        if self.adjustment.is_active {
            Some(self.adjustment.bounds)
        } else if self.drag.is_dragging {
            Some(self.drag.selection_rect())
        } else if let Some(ref win) = self.cursor.hovered_window {
            Some(self.monitor.screen_rect_to_local(win.bounds))
        } else {
            None
        }
    }

    /// Transition to adjustment mode with the given local bounds.
    pub fn enter_adjustment_mode(&mut self, local_bounds: Rect) {
        self.adjustment.enter(local_bounds);
        self.drag.reset();
        self.cursor.clear_hovered();
    }

    /// Transition to locked adjustment mode (no resize/move allowed).
    /// Used for display and window selection where bounds should not change.
    pub fn enter_adjustment_mode_locked(&mut self, local_bounds: Rect) {
        self.adjustment.enter_locked(local_bounds);
        self.drag.reset();
        self.cursor.clear_hovered();
    }

    /// Confirm the current selection with the given action.
    pub fn confirm(&mut self, action: OverlayAction) {
        if let Some(selection) = self.get_screen_selection() {
            self.result.confirm(selection, action);
            self.should_close = true;
        }
    }

    /// Cancel the overlay and close.
    pub fn cancel(&mut self) {
        self.result.cancel();
        self.should_close = true;
    }

    /// Go back to selection mode (reselect).
    pub fn reselect(&mut self) {
        self.adjustment.reset();
        self.drag.reset();
        self.cursor.clear_hovered();
    }

    /// Check if event emission should be throttled.
    ///
    /// Returns true if enough time has passed since the last emission.
    pub fn should_emit(&self, throttle_ms: u64) -> bool {
        self.last_emit_time.elapsed().as_millis() >= throttle_ms as u128
    }

    /// Update the last emission time to now.
    pub fn mark_emitted(&mut self) {
        self.last_emit_time = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drag_state_selection_rect() {
        let mut state = DragState::default();
        state.start = Point::new(10, 10);
        state.current = Point::new(110, 60);

        let r = state.selection_rect();
        assert_eq!(r.left, 10);
        assert_eq!(r.top, 10);
        assert_eq!(r.right, 110);
        assert_eq!(r.bottom, 60);
    }

    #[test]
    fn test_drag_state_inverted() {
        let mut state = DragState::default();
        state.start = Point::new(100, 100);
        state.current = Point::new(10, 10);

        let r = state.selection_rect();
        assert_eq!(r.left, 10);
        assert_eq!(r.top, 10);
        assert_eq!(r.right, 100);
        assert_eq!(r.bottom, 100);
    }

    #[test]
    fn test_drag_state_square_constraint() {
        let mut state = DragState::default();
        state.start = Point::new(0, 0);
        state.current = Point::new(100, 50);
        state.shift_held = true;

        let r = state.selection_rect();
        assert_eq!(r.width(), r.height());
        assert_eq!(r.width(), 100);
    }

    #[test]
    fn test_adjustment_apply_delta_interior() {
        let mut state = AdjustmentState::default();
        state.bounds = Rect::new(100, 100, 200, 200);
        state.start_drag(HandlePosition::Interior, Point::new(150, 150));
        state.apply_delta(10, 20);

        assert_eq!(state.bounds.left, 110);
        assert_eq!(state.bounds.top, 120);
        assert_eq!(state.bounds.right, 210);
        assert_eq!(state.bounds.bottom, 220);
    }

    #[test]
    fn test_adjustment_apply_delta_corner() {
        let mut state = AdjustmentState::default();
        state.bounds = Rect::new(100, 100, 200, 200);
        state.start_drag(HandlePosition::BottomRight, Point::new(200, 200));
        state.apply_delta(50, 30);

        assert_eq!(state.bounds.left, 100);
        assert_eq!(state.bounds.top, 100);
        assert_eq!(state.bounds.right, 250);
        assert_eq!(state.bounds.bottom, 230);
    }

    #[test]
    fn test_adjustment_min_size() {
        let mut state = AdjustmentState::default();
        state.bounds = Rect::new(100, 100, 150, 150);
        state.start_drag(HandlePosition::Right, Point::new(150, 125));
        state.apply_delta(-100, 0); // Try to make width negative

        assert!(state.bounds.width() >= MIN_SELECTION_SIZE as u32);
    }

    #[test]
    fn test_monitor_coordinate_conversion() {
        let monitor = MonitorInfo::new(-1920, 0, 1920, 1080);

        // Screen to local
        let local = monitor.screen_to_local(-1000, 500);
        assert_eq!(local.x, 920); // -1000 - (-1920) = 920
        assert_eq!(local.y, 500);

        // Local to screen
        let screen = monitor.local_to_screen(Point::new(100, 200));
        assert_eq!(screen.x, -1820); // 100 + (-1920) = -1820
        assert_eq!(screen.y, 200);
    }
}
