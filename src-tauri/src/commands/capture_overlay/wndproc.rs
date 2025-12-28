//! Win32 window procedure for the overlay.
//!
//! Handles all window messages including mouse input, keyboard input,
//! and cursor management.

use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{BeginPaint, EndPaint, PAINTSTRUCT};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_SHIFT;
use windows::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GetWindowLongPtrW, LoadCursorW, SetCursor, SetWindowPos, GWLP_USERDATA,
    HTCLIENT, HWND_TOPMOST, IDC_CROSS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WM_CREATE,
    WM_DESTROY, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT,
    WM_RBUTTONDOWN, WM_SETCURSOR,
};

use super::input::{get_window_at_point, hit_test_handle};
use super::render;
use super::state::OverlayState;
use super::types::*;

/// Virtual key codes
const VK_ESCAPE: u32 = 0x1B;
const VK_RETURN: u32 = 0x0D;

/// Window procedure for the overlay.
///
/// # Safety
/// This is a Win32 callback and must be marked unsafe.
pub unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;

    match msg {
        WM_CREATE => LRESULT(0),
        WM_DESTROY => LRESULT(0),
        WM_PAINT => handle_paint(hwnd),
        WM_SETCURSOR => handle_set_cursor(state_ptr, lparam),
        WM_LBUTTONDOWN => handle_mouse_down(state_ptr, lparam),
        WM_MOUSEMOVE => handle_mouse_move(state_ptr, lparam),
        WM_LBUTTONUP => handle_mouse_up(state_ptr),
        WM_KEYDOWN => handle_key_down(state_ptr, wparam),
        WM_KEYUP => handle_key_up(state_ptr, wparam),
        WM_RBUTTONDOWN => LRESULT(0), // Ignore right-click
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Handle WM_PAINT - minimal handling since we use DirectComposition
fn handle_paint(hwnd: HWND) -> LRESULT {
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let _hdc = BeginPaint(hwnd, &mut ps);
        let _ = EndPaint(hwnd, &ps);
    }
    LRESULT(0)
}

/// Handle WM_SETCURSOR - set appropriate cursor based on state
fn handle_set_cursor(state_ptr: *mut OverlayState, lparam: LPARAM) -> LRESULT {
    unsafe {
        // Only handle cursor in client area
        if (lparam.0 as u32 & 0xFFFF) != HTCLIENT as u32 {
            return LRESULT(0);
        }

        if state_ptr.is_null() {
            return LRESULT(0);
        }

        let state = &*state_ptr;

        let cursor_id = if state.adjustment.is_active {
            // In adjustment mode - show resize cursor based on handle
            let handle = if state.adjustment.is_dragging {
                state.adjustment.handle
            } else {
                hit_test_handle(
                    state.cursor.position.x,
                    state.cursor.position.y,
                    state.adjustment.bounds,
                )
            };
            handle.cursor_id()
        } else {
            // Normal mode - show crosshair
            IDC_CROSS
        };

        if let Ok(cursor) = LoadCursorW(None, cursor_id) {
            SetCursor(cursor);
            return LRESULT(1);
        }
    }
    LRESULT(0)
}

/// Handle WM_LBUTTONDOWN - start selection or adjustment drag
fn handle_mouse_down(state_ptr: *mut OverlayState, lparam: LPARAM) -> LRESULT {
    unsafe {
        if state_ptr.is_null() {
            return LRESULT(0);
        }

        let state = &mut *state_ptr;
        let (x, y) = mouse_coords(lparam);

        if state.adjustment.is_active {
            // Check if clicking on a handle or inside selection
            let handle = hit_test_handle(x, y, state.adjustment.bounds);
            if handle.is_active() {
                state.adjustment.start_drag(handle, Point::new(x, y));
            }
        } else {
            // Start selection drag
            state.drag.is_active = true;
            state.drag.is_dragging = false;
            state.drag.start = Point::new(x, y);
            state.drag.current = Point::new(x, y);
        }
    }
    LRESULT(0)
}

/// Handle WM_MOUSEMOVE - update selection, adjustment, or cursor position
fn handle_mouse_move(state_ptr: *mut OverlayState, lparam: LPARAM) -> LRESULT {
    unsafe {
        if state_ptr.is_null() {
            return LRESULT(0);
        }

        let state = &mut *state_ptr;
        let (x, y) = mouse_coords(lparam);

        state.cursor.set_position(x, y);

        if state.adjustment.is_active {
            if state.adjustment.is_dragging {
                // Calculate delta from drag start
                let dx = x - state.adjustment.drag_start.x;
                let dy = y - state.adjustment.drag_start.y;
                state.adjustment.apply_delta(dx, dy);

                // Emit dimension updates to toolbar (throttled)
                if state.should_emit(50) {
                    state.mark_emitted();
                    emit_dimensions_update(state);
                }
            }
        } else if state.drag.is_active {
            state.drag.current = Point::new(x, y);

            // Check if we've dragged enough to enter region selection mode
            if !state.drag.is_dragging && state.drag.exceeds_threshold() {
                state.drag.is_dragging = true;
                state.cursor.clear_hovered(); // Clear window detection when dragging
            }
        } else {
            // Window detection mode - find window under cursor
            let screen_x = state.monitor.x + x;
            let screen_y = state.monitor.y + y;
            state.cursor.hovered_window = get_window_at_point(screen_x, screen_y, state.hwnd);
        }

        let _ = render::render(state);
    }
    LRESULT(0)
}

/// Handle WM_LBUTTONUP - finalize selection
fn handle_mouse_up(state_ptr: *mut OverlayState) -> LRESULT {
    unsafe {
        if state_ptr.is_null() {
            return LRESULT(0);
        }

        let state = &mut *state_ptr;

        if state.adjustment.is_active {
            // End adjustment drag
            if state.adjustment.is_dragging {
                emit_final_selection(state);
            }
            state.adjustment.end_drag();
            let _ = render::render(state);
        } else if state.drag.is_active {
            state.drag.is_active = false;

            if state.drag.is_dragging {
                // Region selection completed
                handle_region_selection_complete(state);
            } else if let Some(ref win) = state.cursor.hovered_window {
                // Window selection - pass hwnd for window capture (isize for 64-bit safety)
                let hwnd = win.hwnd.0 as isize;
                handle_window_selection(state, win.bounds, hwnd);
            } else {
                // Click on empty area - select the monitor under cursor
                handle_monitor_selection(state);
            }
        }

        // Bring webcam preview to front after any mouse interaction
        bring_webcam_preview_to_front(state);
    }
    LRESULT(0)
}

/// Handle region selection completion.
fn handle_region_selection_complete(state: &mut OverlayState) {
    let local_bounds = state.drag.selection_rect();

    if local_bounds.width() > 10 && local_bounds.height() > 10 {
        let screen_bounds = state.monitor.local_rect_to_screen(local_bounds);

        if state.capture_type == CaptureType::Screenshot {
            // For screenshots, capture immediately without adjustment mode
            state.result.confirm(screen_bounds, OverlayAction::CaptureScreenshot);
            state.should_close = true;
        } else {
            // For video/gif, enter adjustment mode
            state.enter_adjustment_mode(local_bounds);
            emit_adjustment_ready(state, screen_bounds);
            show_toolbar(state, screen_bounds);
        }
    }

    state.drag.is_dragging = false;
    let _ = render::render(state);
}

/// Handle window selection.
fn handle_window_selection(state: &mut OverlayState, window_bounds: Rect, window_id: isize) {
    // Get window title for debugging
    let title = unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowTextLengthW};
        let hwnd = HWND(window_id as *mut std::ffi::c_void);
        let len = GetWindowTextLengthW(hwnd);
        if len > 0 {
            let mut buf = vec![0u16; (len + 1) as usize];
            GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::from("(no title)")
        }
    };
    println!("[OVERLAY] Window selected: hwnd={}, title='{}', bounds={}x{}", window_id, title, window_bounds.width(), window_bounds.height());
    if state.capture_type == CaptureType::Screenshot {
        // For screenshots, capture immediately using window capture
        state.result.confirm_window(window_bounds, OverlayAction::CaptureScreenshot, window_id);
        state.should_close = true;
    } else {
        // For video/gif, enter adjustment mode (uses region, not window capture)
        let local_bounds = state.monitor.screen_rect_to_local(window_bounds);
        state.enter_adjustment_mode(local_bounds);
        emit_adjustment_ready(state, window_bounds);
        show_toolbar(state, window_bounds);
    }
    let _ = render::render(state);
}

/// Handle monitor selection (click on empty area).
fn handle_monitor_selection(state: &mut OverlayState) {
    let screen_x = state.monitor.x + state.drag.start.x;
    let screen_y = state.monitor.y + state.drag.start.y;

    if let Ok(monitors) = xcap::Monitor::all() {
        if let Some(mon) = monitors.iter().find(|m| {
            let mx = m.x().unwrap_or(0);
            let my = m.y().unwrap_or(0);
            let mw = m.width().unwrap_or(1920) as i32;
            let mh = m.height().unwrap_or(1080) as i32;
            screen_x >= mx && screen_x < mx + mw && screen_y >= my && screen_y < my + mh
        }) {
            let mon_x = mon.x().unwrap_or(0);
            let mon_y = mon.y().unwrap_or(0);
            let mon_w = mon.width().unwrap_or(1920);
            let mon_h = mon.height().unwrap_or(1080);

            let screen_bounds = Rect::from_xywh(mon_x, mon_y, mon_w, mon_h);

            if state.capture_type == CaptureType::Screenshot {
                state.result.confirm(screen_bounds, OverlayAction::CaptureScreenshot);
                state.should_close = true;
            } else {
                let local_bounds = state.monitor.screen_rect_to_local(screen_bounds);
                state.enter_adjustment_mode(local_bounds);
                emit_adjustment_ready(state, screen_bounds);
                show_toolbar(state, screen_bounds);
            }
            let _ = render::render(state);
        }
    }
}

/// Handle WM_KEYDOWN
fn handle_key_down(state_ptr: *mut OverlayState, wparam: WPARAM) -> LRESULT {
    unsafe {
        if state_ptr.is_null() {
            return LRESULT(0);
        }

        let state = &mut *state_ptr;
        let key = wparam.0 as u32;

        match key {
            VK_ESCAPE => {
                if state.adjustment.is_active {
                    state.adjustment.reset();
                }
                state.cancel();
            }
            VK_RETURN => {
                if state.adjustment.is_active {
                    // Confirm with recording action (Enter in adjustment mode starts recording)
                    if let Some(selection) = state.get_screen_selection() {
                        if selection.width() > 10 && selection.height() > 10 {
                            state.confirm(OverlayAction::StartRecording);
                        }
                    }
                }
            }
            k if k == VK_SHIFT.0 as u32 => {
                state.drag.shift_held = true;
                let _ = render::render(state);
            }
            _ => {}
        }
    }
    LRESULT(0)
}

/// Handle WM_KEYUP
fn handle_key_up(state_ptr: *mut OverlayState, wparam: WPARAM) -> LRESULT {
    unsafe {
        if state_ptr.is_null() {
            return LRESULT(0);
        }

        let state = &mut *state_ptr;
        let key = wparam.0 as u32;

        if key == VK_SHIFT.0 as u32 {
            state.drag.shift_held = false;
            let _ = render::render(state);
        }
    }
    LRESULT(0)
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Extract mouse coordinates from LPARAM
fn mouse_coords(lparam: LPARAM) -> (i32, i32) {
    let x = (lparam.0 & 0xFFFF) as i16 as i32;
    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
    (x, y)
}

/// Emit adjustment ready event to show the toolbar
fn emit_adjustment_ready(state: &OverlayState, bounds: Rect) {
    let event = SelectionEvent::from(bounds);
    let _ = state.app_handle.emit("capture-overlay-adjustment-ready", event);
}

/// Emit dimensions update during adjustment drag
fn emit_dimensions_update(state: &OverlayState) {
    let screen_bounds = state.monitor.local_rect_to_screen(state.adjustment.bounds);

    // Emit globally so both capture-toolbar and webcam-preview receive it
    let _ = state.app_handle.emit("selection-updated", serde_json::json!({
        "x": screen_bounds.left,
        "y": screen_bounds.top,
        "width": screen_bounds.width(),
        "height": screen_bounds.height()
    }));
}

/// Emit final selection when adjustment drag ends
fn emit_final_selection(state: &OverlayState) {
    let screen_bounds = state.monitor.local_rect_to_screen(state.adjustment.bounds);

    // Emit globally so both capture-toolbar and webcam-preview receive it
    let _ = state.app_handle.emit("selection-updated", serde_json::json!({
        "x": screen_bounds.left,
        "y": screen_bounds.top,
        "width": screen_bounds.width(),
        "height": screen_bounds.height()
    }));

    // Bring toolbar window to front
    if let Some(win) = state.app_handle.get_webview_window("capture-toolbar") {
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                let _ = SetWindowPos(
                    HWND(hwnd.0),
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
}

/// Emit event to create capture toolbar window from frontend
/// Frontend has full control over sizing/positioning without hardcoded dimensions
fn show_toolbar(state: &OverlayState, screen_bounds: Rect) {
    let _ = state.app_handle.emit("create-capture-toolbar", serde_json::json!({
        "x": screen_bounds.left,
        "y": screen_bounds.top,
        "width": screen_bounds.width(),
        "height": screen_bounds.height()
    }));
}

/// Bring the webcam preview window to front (above D2D overlay)
fn bring_webcam_preview_to_front(state: &OverlayState) {
    if let Some(win) = state.app_handle.get_webview_window("webcam-preview") {
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SetForegroundWindow};
                let hwnd = HWND(hwnd.0);
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                let _ = BringWindowToTop(hwnd);
            }
        }
    }
}
