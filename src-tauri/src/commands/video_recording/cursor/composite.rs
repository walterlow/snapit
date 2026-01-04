//! Cursor compositing onto frame buffer.
//!
//! Alpha blends the cursor bitmap onto the captured frame.
//! Supports cursor scaling for video editor cursor size adjustment.
//!
//! **DEPRECATED**: This CPU-based compositing is replaced by GPU rendering
//! in `rendering/cursor.rs`. Kept for reference and potential fallback.

#![allow(dead_code)]

use super::CursorState;

/// Composite cursor onto frame buffer with alpha blending.
///
/// # Arguments
/// * `frame` - Mutable BGRA frame buffer
/// * `frame_width` - Frame width in pixels
/// * `frame_height` - Frame height in pixels
/// * `cursor` - Cursor state with position and bitmap
/// * `capture_x` - Capture region left edge in screen coordinates
/// * `capture_y` - Capture region top edge in screen coordinates
pub fn composite_cursor(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cursor: &CursorState,
    capture_x: i32,
    capture_y: i32,
) {
    // Use default scale (1.0 = native size)
    composite_cursor_scaled(
        frame,
        frame_width,
        frame_height,
        cursor,
        capture_x,
        capture_y,
        1.0,
    );
}

/// Composite cursor onto frame buffer with alpha blending and scaling.
///
/// # Arguments
/// * `frame` - Mutable BGRA frame buffer
/// * `frame_width` - Frame width in pixels
/// * `frame_height` - Frame height in pixels
/// * `cursor` - Cursor state with position and bitmap
/// * `capture_x` - Capture region left edge in screen coordinates
/// * `capture_y` - Capture region top edge in screen coordinates
/// * `scale` - Cursor scale factor (1.0 = native, 2.0 = double size)
pub fn composite_cursor_scaled(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cursor: &CursorState,
    capture_x: i32,
    capture_y: i32,
    scale: f32,
) {
    if !cursor.visible || cursor.width == 0 || cursor.height == 0 {
        return;
    }

    // Clamp scale to reasonable range
    let scale = scale.clamp(0.5, 4.0);

    // Calculate scaled dimensions
    let scaled_width = ((cursor.width as f32) * scale).round() as u32;
    let scaled_height = ((cursor.height as f32) * scale).round() as u32;
    let scaled_hotspot_x = ((cursor.hotspot_x as f32) * scale).round() as i32;
    let scaled_hotspot_y = ((cursor.hotspot_y as f32) * scale).round() as i32;

    // Calculate cursor draw position relative to capture region (using scaled hotspot)
    let cursor_draw_x = cursor.screen_x - scaled_hotspot_x - capture_x;
    let cursor_draw_y = cursor.screen_y - scaled_hotspot_y - capture_y;

    // Calculate visible region (clip to frame bounds) using scaled dimensions
    let clip = match clip_rect(
        cursor_draw_x,
        cursor_draw_y,
        scaled_width,
        scaled_height,
        frame_width,
        frame_height,
    ) {
        Some(c) => {
            // Debug: log on first successful clip
            static LOGGED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[COMPOSITE] Drawing cursor at draw_pos ({}, {}), scale={:.2}, clip: src({},{}) dst({},{}) size {}x{}",
                    cursor_draw_x, cursor_draw_y, scale,
                    c.src_x, c.src_y, c.dst_x, c.dst_y, c.width, c.height);
            }
            c
        },
        None => {
            // Debug: cursor outside frame
            static LOGGED_OUTSIDE: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if !LOGGED_OUTSIDE.swap(true, std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[COMPOSITE] Cursor outside frame: draw_pos ({}, {}), cursor {}x{} (scaled), frame {}x{}",
                    cursor_draw_x, cursor_draw_y, scaled_width, scaled_height, frame_width, frame_height);
            }
            return;
        },
    };

    // Blend each visible pixel with bilinear interpolation for scaling
    let inv_scale = 1.0 / scale;

    for row in 0..clip.height {
        for col in 0..clip.width {
            // Destination position in frame
            let dst_x = clip.dst_x + col;
            let dst_y = clip.dst_y + row;

            // Source position in scaled space
            let scaled_src_x = clip.src_x + col;
            let scaled_src_y = clip.src_y + row;

            // Map back to original cursor bitmap coordinates
            let orig_x = (scaled_src_x as f32) * inv_scale;
            let orig_y = (scaled_src_y as f32) * inv_scale;

            // Get source pixel with bilinear interpolation
            let (src_b, src_g, src_r, src_a) = if scale == 1.0 {
                // No scaling - direct lookup
                let src_idx = ((orig_y as u32) * cursor.width + (orig_x as u32)) * 4;
                let src_idx = src_idx as usize;
                (
                    cursor.bgra_data.get(src_idx).copied().unwrap_or(0),
                    cursor.bgra_data.get(src_idx + 1).copied().unwrap_or(0),
                    cursor.bgra_data.get(src_idx + 2).copied().unwrap_or(0),
                    cursor.bgra_data.get(src_idx + 3).copied().unwrap_or(0),
                )
            } else {
                // Bilinear interpolation for smooth scaling
                sample_bilinear(
                    &cursor.bgra_data,
                    cursor.width,
                    cursor.height,
                    orig_x,
                    orig_y,
                )
            };

            // Skip fully transparent pixels
            if src_a == 0 {
                continue;
            }

            let dst_idx = ((dst_y * frame_width + dst_x) * 4) as usize;

            // Bounds check destination
            if dst_idx + 3 >= frame.len() {
                continue;
            }

            if src_a == 255 {
                // Fully opaque - direct copy
                frame[dst_idx] = src_b;
                frame[dst_idx + 1] = src_g;
                frame[dst_idx + 2] = src_r;
                // Keep destination alpha (should be 255 for opaque frame)
            } else {
                // Alpha blend: dst = src * alpha + dst * (1 - alpha)
                let alpha = src_a as f32 / 255.0;
                let inv_alpha = 1.0 - alpha;

                let dst_b = frame[dst_idx];
                let dst_g = frame[dst_idx + 1];
                let dst_r = frame[dst_idx + 2];

                frame[dst_idx] = (src_b as f32 * alpha + dst_b as f32 * inv_alpha) as u8;
                frame[dst_idx + 1] = (src_g as f32 * alpha + dst_g as f32 * inv_alpha) as u8;
                frame[dst_idx + 2] = (src_r as f32 * alpha + dst_r as f32 * inv_alpha) as u8;
            }
        }
    }
}

/// Sample a BGRA pixel using bilinear interpolation.
///
/// Returns (B, G, R, A) tuple.
fn sample_bilinear(data: &[u8], width: u32, height: u32, x: f32, y: f32) -> (u8, u8, u8, u8) {
    // Clamp coordinates to valid range
    let x = x.clamp(0.0, (width - 1) as f32);
    let y = y.clamp(0.0, (height - 1) as f32);

    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);

    let fx = x - x0 as f32;
    let fy = y - y0 as f32;

    // Get four neighboring pixels
    let idx00 = ((y0 * width + x0) * 4) as usize;
    let idx10 = ((y0 * width + x1) * 4) as usize;
    let idx01 = ((y1 * width + x0) * 4) as usize;
    let idx11 = ((y1 * width + x1) * 4) as usize;

    // Helper to safely get pixel
    let get_pixel = |idx: usize| -> (f32, f32, f32, f32) {
        (
            data.get(idx).copied().unwrap_or(0) as f32,
            data.get(idx + 1).copied().unwrap_or(0) as f32,
            data.get(idx + 2).copied().unwrap_or(0) as f32,
            data.get(idx + 3).copied().unwrap_or(0) as f32,
        )
    };

    let p00 = get_pixel(idx00);
    let p10 = get_pixel(idx10);
    let p01 = get_pixel(idx01);
    let p11 = get_pixel(idx11);

    // Bilinear interpolation for each channel
    let interpolate = |c00: f32, c10: f32, c01: f32, c11: f32| -> u8 {
        let top = c00 * (1.0 - fx) + c10 * fx;
        let bottom = c01 * (1.0 - fx) + c11 * fx;
        let result = top * (1.0 - fy) + bottom * fy;
        result.round() as u8
    };

    (
        interpolate(p00.0, p10.0, p01.0, p11.0), // B
        interpolate(p00.1, p10.1, p01.1, p11.1), // G
        interpolate(p00.2, p10.2, p01.2, p11.2), // R
        interpolate(p00.3, p10.3, p01.3, p11.3), // A
    )
}

/// Clipped rectangle for cursor compositing.
struct ClipRect {
    /// Source X offset within cursor bitmap
    src_x: u32,
    /// Source Y offset within cursor bitmap
    src_y: u32,
    /// Destination X in frame buffer
    dst_x: u32,
    /// Destination Y in frame buffer
    dst_y: u32,
    /// Width of visible region
    width: u32,
    /// Height of visible region
    height: u32,
}

/// Calculate clipped rectangle when cursor is partially outside frame.
///
/// Returns None if cursor is completely outside frame bounds.
fn clip_rect(
    cursor_x: i32,
    cursor_y: i32,
    cursor_w: u32,
    cursor_h: u32,
    frame_w: u32,
    frame_h: u32,
) -> Option<ClipRect> {
    // Calculate source offset (for when cursor is partially off left/top edge)
    let src_x = if cursor_x < 0 { (-cursor_x) as u32 } else { 0 };
    let src_y = if cursor_y < 0 { (-cursor_y) as u32 } else { 0 };

    // Calculate destination position (clamped to 0)
    let dst_x = cursor_x.max(0) as u32;
    let dst_y = cursor_y.max(0) as u32;

    // Calculate visible width/height
    let remaining_cursor_w = cursor_w.saturating_sub(src_x);
    let remaining_cursor_h = cursor_h.saturating_sub(src_y);

    let remaining_frame_w = frame_w.saturating_sub(dst_x);
    let remaining_frame_h = frame_h.saturating_sub(dst_y);

    let width = remaining_cursor_w.min(remaining_frame_w);
    let height = remaining_cursor_h.min(remaining_frame_h);

    if width == 0 || height == 0 {
        return None;
    }

    Some(ClipRect {
        src_x,
        src_y,
        dst_x,
        dst_y,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clip_rect_inside_frame() {
        let clip = clip_rect(10, 20, 32, 32, 100, 100).unwrap();
        assert_eq!(clip.src_x, 0);
        assert_eq!(clip.src_y, 0);
        assert_eq!(clip.dst_x, 10);
        assert_eq!(clip.dst_y, 20);
        assert_eq!(clip.width, 32);
        assert_eq!(clip.height, 32);
    }

    #[test]
    fn test_clip_rect_partial_left() {
        let clip = clip_rect(-10, 20, 32, 32, 100, 100).unwrap();
        assert_eq!(clip.src_x, 10);
        assert_eq!(clip.src_y, 0);
        assert_eq!(clip.dst_x, 0);
        assert_eq!(clip.dst_y, 20);
        assert_eq!(clip.width, 22);
        assert_eq!(clip.height, 32);
    }

    #[test]
    fn test_clip_rect_partial_right() {
        let clip = clip_rect(80, 20, 32, 32, 100, 100).unwrap();
        assert_eq!(clip.src_x, 0);
        assert_eq!(clip.src_y, 0);
        assert_eq!(clip.dst_x, 80);
        assert_eq!(clip.dst_y, 20);
        assert_eq!(clip.width, 20); // Clipped to frame edge
        assert_eq!(clip.height, 32);
    }

    #[test]
    fn test_clip_rect_outside_frame() {
        assert!(clip_rect(-50, 20, 32, 32, 100, 100).is_none());
        assert!(clip_rect(20, -50, 32, 32, 100, 100).is_none());
        assert!(clip_rect(150, 20, 32, 32, 100, 100).is_none());
        assert!(clip_rect(20, 150, 32, 32, 100, 100).is_none());
    }
}
