//! Direct2D rendering for the overlay.
//!
//! This module handles all rendering operations:
//! - Dimmed overlay around the selection
//! - Selection border
//! - Crosshair cursor
//! - Size indicator text
//! - Resize handles

use windows::core::Result;
use windows::Win32::Graphics::Direct2D::Common::{D2D1_COLOR_F, D2D_POINT_2F, D2D_RECT_F};
use windows::Win32::Graphics::Direct2D::{
    D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ROUNDED_RECT, ID2D1DeviceContext,
};
use windows::Win32::Graphics::DirectWrite::DWRITE_MEASURING_MODE_NATURAL;
use windows::Win32::Graphics::Dxgi::{IDXGISurface, DXGI_PRESENT};



use super::graphics::d2d::{create_target_bitmap, Brushes, D2DResources};
use super::state::OverlayState;
use super::types::*;

/// Render the overlay to the swap chain.
///
/// This is called after any state change to update the visual.
pub fn render(state: &OverlayState) -> Result<()> {
    let graphics = &state.graphics;
    let d2d = &graphics.d2d;

    unsafe {
        // Get the back buffer
        let surface: IDXGISurface = graphics.swap_chain.GetBuffer(0)?;
        let target_bitmap = create_target_bitmap(&d2d.context, &surface)?;

        d2d.context.SetTarget(&target_bitmap);
        d2d.context.BeginDraw();

        // Clear with fully transparent
        d2d.context.Clear(Some(&D2D1_COLOR_F {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        }));

        // Determine what to render
        let render_info = determine_render_info(state);

        // Draw dimmed overlay around the clear area
        draw_dim_overlay(&d2d.context, &d2d.brushes, render_info.clear_rect, state);

        // Draw selection border
        if render_info.draw_border {
            draw_selection_border(&d2d.context, &d2d.brushes, render_info.clear_rect);
        }

        // Draw crosshair (only when not adjusting)
        if !state.adjustment.is_active {
            draw_crosshair(
                &d2d.context,
                d2d,
                state.cursor.position,
                state,
            );
        }

        // Draw size indicator (when selecting, not adjusting)
        if render_info.draw_border && !state.adjustment.is_active {
            draw_size_indicator(&d2d.context, d2d, render_info.clear_rect, state);
        }

        // Draw resize handles (when adjusting)
        if render_info.draw_handles {
            draw_resize_handles(&d2d.context, &d2d.brushes, render_info.clear_rect);
        }

        d2d.context.EndDraw(None, None)?;

        // Present the frame
        graphics.swap_chain.Present(1, DXGI_PRESENT(0)).ok()?;
        graphics.comp_device.Commit()?;
    }

    Ok(())
}

/// Information about what to render.
struct RenderInfo {
    /// The "clear" area (not dimmed)
    clear_rect: D2D_RECT_F,
    /// Whether to draw a border around the clear area
    draw_border: bool,
    /// Whether to draw resize handles
    draw_handles: bool,
}

/// Determine what should be rendered based on current state.
fn determine_render_info(state: &OverlayState) -> RenderInfo {
    let width = state.monitor.width as f32;
    let height = state.monitor.height as f32;

    if state.adjustment.is_active {
        // Adjustment mode - show the selection with handles
        RenderInfo {
            clear_rect: state.adjustment.bounds.to_d2d_rect(),
            draw_border: true,
            draw_handles: true,
        }
    } else if state.drag.is_dragging {
        // Region selection mode - show selection rectangle
        RenderInfo {
            clear_rect: state.drag.selection_rect().to_d2d_rect(),
            draw_border: true,
            draw_handles: false,
        }
    } else if let Some(ref win) = state.cursor.hovered_window {
        // Window detection mode - show hovered window
        let local_bounds = state.monitor.screen_rect_to_local(win.bounds);

        // Clamp to monitor bounds
        let clear_rect = D2D_RECT_F {
            left: (local_bounds.left as f32).max(0.0),
            top: (local_bounds.top as f32).max(0.0),
            right: (local_bounds.right as f32).min(width),
            bottom: (local_bounds.bottom as f32).min(height),
        };

        RenderInfo {
            clear_rect,
            draw_border: true,
            draw_handles: false,
        }
    } else {
        // No window detected - find the monitor under cursor and highlight it
        let screen_cursor_x = state.monitor.x + state.cursor.position.x;
        let screen_cursor_y = state.monitor.y + state.cursor.position.y;

        if let Ok(monitors) = xcap::Monitor::all() {
            if let Some(mon) = monitors.iter().find(|m| {
                let mx = m.x().unwrap_or(0);
                let my = m.y().unwrap_or(0);
                let mw = m.width().unwrap_or(1920) as i32;
                let mh = m.height().unwrap_or(1080) as i32;
                screen_cursor_x >= mx
                    && screen_cursor_x < mx + mw
                    && screen_cursor_y >= my
                    && screen_cursor_y < my + mh
            }) {
                let mon_x = mon.x().unwrap_or(0);
                let mon_y = mon.y().unwrap_or(0);
                let mon_w = mon.width().unwrap_or(1920) as i32;
                let mon_h = mon.height().unwrap_or(1080) as i32;

                // Convert to local coordinates
                let left = (mon_x - state.monitor.x) as f32;
                let top = (mon_y - state.monitor.y) as f32;
                let right = left + mon_w as f32;
                let bottom = top + mon_h as f32;

                return RenderInfo {
                    clear_rect: D2D_RECT_F {
                        left,
                        top,
                        right,
                        bottom,
                    },
                    draw_border: true,
                    draw_handles: false,
                };
            }
        }

        // Fallback: no dimming, no border
        RenderInfo {
            clear_rect: D2D_RECT_F {
                left: 0.0,
                top: 0.0,
                right: width,
                bottom: height,
            },
            draw_border: false,
            draw_handles: false,
        }
    }
}

/// Draw the dimmed overlay around the clear area.
///
/// Draws 4 rectangles to create the "cutout" effect.
fn draw_dim_overlay(
    context: &ID2D1DeviceContext,
    brushes: &Brushes,
    clear_rect: D2D_RECT_F,
    state: &OverlayState,
) {
    let width = state.monitor.width as f32;
    let height = state.monitor.height as f32;

    unsafe {
        // Top
        if clear_rect.top > 0.0 {
            context.FillRectangle(
                &D2D_RECT_F {
                    left: 0.0,
                    top: 0.0,
                    right: width,
                    bottom: clear_rect.top,
                },
                &brushes.overlay,
            );
        }

        // Bottom
        if clear_rect.bottom < height {
            context.FillRectangle(
                &D2D_RECT_F {
                    left: 0.0,
                    top: clear_rect.bottom,
                    right: width,
                    bottom: height,
                },
                &brushes.overlay,
            );
        }

        // Left
        if clear_rect.left > 0.0 {
            context.FillRectangle(
                &D2D_RECT_F {
                    left: 0.0,
                    top: clear_rect.top,
                    right: clear_rect.left,
                    bottom: clear_rect.bottom,
                },
                &brushes.overlay,
            );
        }

        // Right
        if clear_rect.right < width {
            context.FillRectangle(
                &D2D_RECT_F {
                    left: clear_rect.right,
                    top: clear_rect.top,
                    right: width,
                    bottom: clear_rect.bottom,
                },
                &brushes.overlay,
            );
        }
    }
}

/// Draw the selection border.
fn draw_selection_border(context: &ID2D1DeviceContext, brushes: &Brushes, rect: D2D_RECT_F) {
    unsafe {
        context.DrawRectangle(&rect, &brushes.border, 2.0, None);
    }
}

/// Draw the crosshair cursor.
fn draw_crosshair(
    context: &ID2D1DeviceContext,
    d2d: &D2DResources,
    cursor: Point,
    state: &OverlayState,
) {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::Foundation::POINT;

    let cx = cursor.x as f32;
    let cy = cursor.y as f32;
    let gap = CROSSHAIR_GAP;

    // Get the monitor bounds for the current cursor position
    let screen_x = state.monitor.x + cursor.x;
    let screen_y = state.monitor.y + cursor.y;

    let (mon_left, mon_top, mon_right, mon_bottom) = unsafe {
        let cursor_point = POINT {
            x: screen_x,
            y: screen_y,
        };
        let hmonitor = MonitorFromPoint(cursor_point, MONITOR_DEFAULTTONEAREST);
        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(hmonitor, &mut monitor_info).as_bool() {
            let rc = monitor_info.rcMonitor;
            (
                (rc.left - state.monitor.x) as f32,
                (rc.top - state.monitor.y) as f32,
                (rc.right - state.monitor.x) as f32,
                (rc.bottom - state.monitor.y) as f32,
            )
        } else {
            // Fallback to full overlay
            (
                0.0,
                0.0,
                state.monitor.width as f32,
                state.monitor.height as f32,
            )
        }
    };

    unsafe {
        // Horizontal line (left segment)
        if cx > mon_left + gap {
            context.DrawLine(
                D2D_POINT_2F { x: mon_left, y: cy },
                D2D_POINT_2F { x: cx - gap, y: cy },
                &d2d.brushes.crosshair,
                1.0,
                &d2d.crosshair_stroke,
            );
        }

        // Horizontal line (right segment)
        if cx + gap < mon_right {
            context.DrawLine(
                D2D_POINT_2F { x: cx + gap, y: cy },
                D2D_POINT_2F { x: mon_right, y: cy },
                &d2d.brushes.crosshair,
                1.0,
                &d2d.crosshair_stroke,
            );
        }

        // Vertical line (top segment)
        if cy > mon_top + gap {
            context.DrawLine(
                D2D_POINT_2F { x: cx, y: mon_top },
                D2D_POINT_2F { x: cx, y: cy - gap },
                &d2d.brushes.crosshair,
                1.0,
                &d2d.crosshair_stroke,
            );
        }

        // Vertical line (bottom segment)
        if cy + gap < mon_bottom {
            context.DrawLine(
                D2D_POINT_2F { x: cx, y: cy + gap },
                D2D_POINT_2F { x: cx, y: mon_bottom },
                &d2d.brushes.crosshair,
                1.0,
                &d2d.crosshair_stroke,
            );
        }
    }
}

/// Draw the size indicator text below the selection.
fn draw_size_indicator(
    context: &ID2D1DeviceContext,
    d2d: &D2DResources,
    clear_rect: D2D_RECT_F,
    state: &OverlayState,
) {
    let width = state.monitor.width as f32;
    let height = state.monitor.height as f32;

    let sel_width = (clear_rect.right - clear_rect.left) as u32;
    let sel_height = (clear_rect.bottom - clear_rect.top) as u32;

    // Format the size text
    let size_text = format!("{} x {}", sel_width, sel_height);
    let size_text_wide: Vec<u16> = size_text.encode_utf16().chain(std::iter::once(0)).collect();

    // Calculate text box dimensions
    let text_width = 100.0_f32;
    let text_height = 24.0_f32;
    let padding = 6.0_f32;
    let margin = 8.0_f32;

    // Position below the selection, centered horizontally
    let box_x = clear_rect.left + (clear_rect.right - clear_rect.left - text_width) / 2.0;
    let mut box_y = clear_rect.bottom + margin;

    // Clamp to screen bounds
    let box_x = box_x.max(padding).min(width - text_width - padding);

    // If below screen, show above selection
    if box_y + text_height + padding > height {
        box_y = clear_rect.top - margin - text_height;
    }
    let box_y = box_y.max(padding);

    let bg_rect = D2D_RECT_F {
        left: box_x,
        top: box_y,
        right: box_x + text_width,
        bottom: box_y + text_height,
    };

    unsafe {
        // Draw background rounded rect
        let rounded_rect = D2D1_ROUNDED_RECT {
            rect: bg_rect,
            radiusX: 4.0,
            radiusY: 4.0,
        };
        context.FillRoundedRectangle(&rounded_rect, &d2d.brushes.text_bg);

        // Draw text
        context.DrawText(
            &size_text_wide[..size_text_wide.len() - 1], // Exclude null terminator
            &d2d.text_format,
            &bg_rect,
            &d2d.brushes.text,
            D2D1_DRAW_TEXT_OPTIONS_NONE,
            DWRITE_MEASURING_MODE_NATURAL,
        );
    }
}

/// Draw the 8 resize handles.
fn draw_resize_handles(context: &ID2D1DeviceContext, brushes: &Brushes, rect: D2D_RECT_F) {
    let hh = HANDLE_HALF as f32;

    let left = rect.left;
    let top = rect.top;
    let right = rect.right;
    let bottom = rect.bottom;
    let cx = (left + right) / 2.0;
    let cy = (top + bottom) / 2.0;

    // Helper to draw a single handle
    let draw_handle = |x: f32, y: f32| {
        let rect = D2D_RECT_F {
            left: x - hh,
            top: y - hh,
            right: x + hh,
            bottom: y + hh,
        };
        unsafe {
            context.FillRectangle(&rect, &brushes.handle_fill);
            context.DrawRectangle(&rect, &brushes.handle_border, 1.0, None);
        }
    };

    // Corners
    draw_handle(left, top); // TopLeft
    draw_handle(right, top); // TopRight
    draw_handle(left, bottom); // BottomLeft
    draw_handle(right, bottom); // BottomRight

    // Edges
    draw_handle(cx, top); // Top
    draw_handle(cx, bottom); // Bottom
    draw_handle(left, cy); // Left
    draw_handle(right, cy); // Right
}
