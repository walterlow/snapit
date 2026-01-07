//! Click highlight animation for video editor.
//!
//! Renders visual effects (ripple, spotlight, ring) at click locations
//! during video export. Based on cursor events from CursorRecording.
//!
//! **DEPRECATED**: Click highlights are now rendered in the frontend.
//! Kept for reference and potential fallback.

#![allow(dead_code)]

use super::events::{CursorEvent, CursorEventType};
use crate::commands::video_recording::video_project::{ClickHighlightConfig, ClickHighlightStyle};

/// Render a click highlight onto a frame buffer.
///
/// # Arguments
/// * `frame` - Mutable BGRA frame buffer
/// * `frame_width` - Frame width in pixels
/// * `frame_height` - Frame height in pixels
/// * `x` - Click X position (relative to frame)
/// * `y` - Click Y position (relative to frame)
/// * `progress` - Animation progress (0.0 = start, 1.0 = end)
/// * `config` - Highlight configuration (style, color, radius, etc.)
pub fn render_click_highlight(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    x: i32,
    y: i32,
    progress: f32,
    config: &ClickHighlightConfig,
) {
    if !config.enabled || progress < 0.0 || progress > 1.0 {
        return;
    }

    // Parse color from CSS string (supports #RRGGBB and rgba(r,g,b,a))
    let (r, g, b, base_alpha) = parse_color(&config.color).unwrap_or((255, 107, 107, 0.5));

    match config.style {
        ClickHighlightStyle::Ripple => {
            render_ripple(
                frame,
                frame_width,
                frame_height,
                x,
                y,
                progress,
                config.radius,
                r,
                g,
                b,
                base_alpha,
            );
        },
        ClickHighlightStyle::Spotlight => {
            render_spotlight(
                frame,
                frame_width,
                frame_height,
                x,
                y,
                progress,
                config.radius,
                r,
                g,
                b,
                base_alpha,
            );
        },
        ClickHighlightStyle::Ring => {
            render_ring(
                frame,
                frame_width,
                frame_height,
                x,
                y,
                progress,
                config.radius,
                r,
                g,
                b,
                base_alpha,
            );
        },
    }
}

/// Find active click events for a given timestamp and compute their animation progress.
///
/// Returns a list of (x, y, progress) tuples for active click highlights.
/// x, y are pixel coordinates in the frame.
///
/// # Arguments
/// * `events` - Cursor events with normalized (0.0-1.0) coordinates
/// * `current_time_ms` - Current playback time
/// * `duration_ms` - Click highlight animation duration
/// * `frame_width` - Output frame width in pixels
/// * `frame_height` - Output frame height in pixels
pub fn get_active_clicks(
    events: &[CursorEvent],
    current_time_ms: u64,
    duration_ms: u32,
    frame_width: u32,
    frame_height: u32,
) -> Vec<(i32, i32, f32)> {
    let mut active = Vec::new();

    for event in events {
        // Only process click-down events (not releases)
        let is_click_down = matches!(
            &event.event_type,
            CursorEventType::LeftClick { pressed: true }
                | CursorEventType::RightClick { pressed: true }
                | CursorEventType::MiddleClick { pressed: true }
        );

        if !is_click_down {
            continue;
        }

        // Check if this click is within the animation window
        let click_time = event.timestamp_ms;
        if current_time_ms < click_time {
            continue; // Click hasn't happened yet
        }

        let elapsed = current_time_ms - click_time;
        if elapsed > duration_ms as u64 {
            continue; // Animation already finished
        }

        // Calculate animation progress
        let progress = elapsed as f32 / duration_ms as f32;

        // Convert normalized coordinates to frame pixels
        let frame_x = (event.x * frame_width as f64) as i32;
        let frame_y = (event.y * frame_height as f64) as i32;

        active.push((frame_x, frame_y, progress));
    }

    active
}

/// Render expanding ripple effect.
fn render_ripple(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cx: i32,
    cy: i32,
    progress: f32,
    max_radius: u32,
    r: u8,
    g: u8,
    b: u8,
    base_alpha: f32,
) {
    // Ripple expands from 0 to max_radius
    let current_radius = (max_radius as f32 * progress) as i32;

    // Fade out as ripple expands
    let alpha = base_alpha * (1.0 - progress);

    if current_radius <= 0 || alpha <= 0.0 {
        return;
    }

    // Draw a filled circle with soft edges
    let radius_sq = (current_radius * current_radius) as f32;
    let inner_radius = (current_radius as f32 * 0.7).max(0.0);
    let inner_radius_sq = inner_radius * inner_radius;

    let min_x = (cx - current_radius).max(0) as u32;
    let max_x = (cx + current_radius).min(frame_width as i32 - 1) as u32;
    let min_y = (cy - current_radius).max(0) as u32;
    let max_y = (cy + current_radius).min(frame_height as i32 - 1) as u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as i32 - cx;
            let dy = y as i32 - cy;
            let dist_sq = (dx * dx + dy * dy) as f32;

            if dist_sq > radius_sq {
                continue;
            }

            // Soft edge falloff
            let edge_alpha = if dist_sq < inner_radius_sq {
                alpha
            } else {
                let edge_progress = (dist_sq - inner_radius_sq) / (radius_sq - inner_radius_sq);
                alpha * (1.0 - edge_progress)
            };

            if edge_alpha > 0.01 {
                blend_pixel(frame, frame_width, x, y, r, g, b, edge_alpha);
            }
        }
    }
}

/// Render static spotlight/glow effect.
fn render_spotlight(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cx: i32,
    cy: i32,
    progress: f32,
    max_radius: u32,
    r: u8,
    g: u8,
    b: u8,
    base_alpha: f32,
) {
    // Spotlight stays same size but fades out
    let alpha = base_alpha * (1.0 - progress);

    if alpha <= 0.0 {
        return;
    }

    let radius = max_radius as i32;
    let radius_sq = (radius * radius) as f32;

    let min_x = (cx - radius).max(0) as u32;
    let max_x = (cx + radius).min(frame_width as i32 - 1) as u32;
    let min_y = (cy - radius).max(0) as u32;
    let max_y = (cy + radius).min(frame_height as i32 - 1) as u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as i32 - cx;
            let dy = y as i32 - cy;
            let dist_sq = (dx * dx + dy * dy) as f32;

            if dist_sq > radius_sq {
                continue;
            }

            // Gaussian-like falloff from center
            let dist_factor = 1.0 - (dist_sq / radius_sq);
            let pixel_alpha = alpha * dist_factor * dist_factor; // Quadratic falloff

            if pixel_alpha > 0.01 {
                blend_pixel(frame, frame_width, x, y, r, g, b, pixel_alpha);
            }
        }
    }
}

/// Render expanding ring effect.
fn render_ring(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cx: i32,
    cy: i32,
    progress: f32,
    max_radius: u32,
    r: u8,
    g: u8,
    b: u8,
    base_alpha: f32,
) {
    // Ring expands from 0 to max_radius
    let current_radius = (max_radius as f32 * progress) as i32;

    // Fade out as ring expands
    let alpha = base_alpha * (1.0 - progress);

    if current_radius <= 0 || alpha <= 0.0 {
        return;
    }

    // Ring thickness (proportional to radius, but with minimum)
    let ring_thickness = ((current_radius as f32) * 0.15).max(2.0);
    let outer_radius = current_radius as f32;
    let inner_radius = (outer_radius - ring_thickness).max(0.0);

    let outer_radius_sq = outer_radius * outer_radius;
    let inner_radius_sq = inner_radius * inner_radius;

    let min_x = (cx - current_radius - 1).max(0) as u32;
    let max_x = (cx + current_radius + 1).min(frame_width as i32 - 1) as u32;
    let min_y = (cy - current_radius - 1).max(0) as u32;
    let max_y = (cy + current_radius + 1).min(frame_height as i32 - 1) as u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as i32 - cx;
            let dy = y as i32 - cy;
            let dist_sq = (dx * dx + dy * dy) as f32;

            // Only draw within the ring band
            if dist_sq > outer_radius_sq || dist_sq < inner_radius_sq {
                continue;
            }

            // Anti-alias edges
            let outer_edge = (outer_radius_sq - dist_sq).sqrt().min(1.0);
            let inner_edge = (dist_sq - inner_radius_sq).sqrt().min(1.0);
            let edge_alpha = alpha * outer_edge.min(inner_edge);

            if edge_alpha > 0.01 {
                blend_pixel(frame, frame_width, x, y, r, g, b, edge_alpha);
            }
        }
    }
}

/// Blend a single pixel with alpha.
fn blend_pixel(
    frame: &mut [u8],
    frame_width: u32,
    x: u32,
    y: u32,
    r: u8,
    g: u8,
    b: u8,
    alpha: f32,
) {
    let idx = ((y * frame_width + x) * 4) as usize;
    if idx + 3 >= frame.len() {
        return;
    }

    let inv_alpha = 1.0 - alpha;

    // BGRA format
    frame[idx] = (b as f32 * alpha + frame[idx] as f32 * inv_alpha) as u8;
    frame[idx + 1] = (g as f32 * alpha + frame[idx + 1] as f32 * inv_alpha) as u8;
    frame[idx + 2] = (r as f32 * alpha + frame[idx + 2] as f32 * inv_alpha) as u8;
}

/// Parse a CSS color string into (R, G, B, A) tuple.
/// Supports:
/// - #RRGGBB (alpha defaults to 0.5)
/// - #RRGGBBAA
/// - rgba(r, g, b, a)
fn parse_color(color: &str) -> Option<(u8, u8, u8, f32)> {
    let color = color.trim();

    if color.starts_with('#') {
        let hex = &color[1..];
        match hex.len() {
            6 => {
                let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
                let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
                let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
                Some((r, g, b, 0.5))
            },
            8 => {
                let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
                let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
                let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
                let a = u8::from_str_radix(&hex[6..8], 16).ok()?;
                Some((r, g, b, a as f32 / 255.0))
            },
            _ => None,
        }
    } else if color.starts_with("rgba(") && color.ends_with(')') {
        let inner = &color[5..color.len() - 1];
        let parts: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
        if parts.len() == 4 {
            let r: u8 = parts[0].parse().ok()?;
            let g: u8 = parts[1].parse().ok()?;
            let b: u8 = parts[2].parse().ok()?;
            let a: f32 = parts[3].parse().ok()?;
            Some((r, g, b, a))
        } else {
            None
        }
    } else if color.starts_with("rgb(") && color.ends_with(')') {
        let inner = &color[4..color.len() - 1];
        let parts: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
        if parts.len() == 3 {
            let r: u8 = parts[0].parse().ok()?;
            let g: u8 = parts[1].parse().ok()?;
            let b: u8 = parts[2].parse().ok()?;
            Some((r, g, b, 0.5))
        } else {
            None
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_color_hex() {
        let (r, g, b, a) = parse_color("#FF6B6B").unwrap();
        assert_eq!(r, 255);
        assert_eq!(g, 107);
        assert_eq!(b, 107);
        assert!((a - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_parse_color_hex_with_alpha() {
        let (r, g, b, a) = parse_color("#FF6B6B80").unwrap();
        assert_eq!(r, 255);
        assert_eq!(g, 107);
        assert_eq!(b, 107);
        assert!((a - 0.5).abs() < 0.01); // 0x80 = 128 = ~0.5
    }

    #[test]
    fn test_parse_color_rgba() {
        let (r, g, b, a) = parse_color("rgba(255, 107, 107, 0.7)").unwrap();
        assert_eq!(r, 255);
        assert_eq!(g, 107);
        assert_eq!(b, 107);
        assert!((a - 0.7).abs() < 0.01);
    }

    #[test]
    fn test_get_active_clicks() {
        // Coordinates are now normalized (0.0-1.0)
        let events = vec![
            CursorEvent {
                timestamp_ms: 100,
                x: 0.25, // 25% across frame
                y: 0.25,
                event_type: CursorEventType::LeftClick { pressed: true },
                cursor_id: None,
            },
            CursorEvent {
                timestamp_ms: 200,
                x: 0.5,
                y: 0.5,
                event_type: CursorEventType::LeftClick { pressed: false }, // Release - should be ignored
                cursor_id: None,
            },
            CursorEvent {
                timestamp_ms: 500,
                x: 0.75, // 75% across frame
                y: 0.75,
                event_type: CursorEventType::RightClick { pressed: true },
                cursor_id: None,
            },
        ];

        let frame_width = 200u32;
        let frame_height = 200u32;

        // At time 300ms with 400ms duration, first click is still active
        let active = get_active_clicks(&events, 300, 400, frame_width, frame_height);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].0, 50); // 0.25 * 200 = 50
        assert_eq!(active[0].1, 50);
        assert!((active[0].2 - 0.5).abs() < 0.01); // 200ms / 400ms = 0.5

        // At time 700ms, first click is done, second is active
        let active = get_active_clicks(&events, 700, 400, frame_width, frame_height);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].0, 150); // 0.75 * 200 = 150
        assert_eq!(active[0].1, 150);
    }
}
