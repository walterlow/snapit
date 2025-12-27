//! Cursor compositing onto frame buffer.
//!
//! Alpha blends the cursor bitmap onto the captured frame.

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
    if !cursor.visible || cursor.width == 0 || cursor.height == 0 {
        return;
    }

    // Calculate cursor draw position relative to capture region
    let cursor_draw_x = cursor.screen_x - cursor.hotspot_x - capture_x;
    let cursor_draw_y = cursor.screen_y - cursor.hotspot_y - capture_y;

    // Calculate visible region (clip to frame bounds)
    let clip = match clip_rect(
        cursor_draw_x,
        cursor_draw_y,
        cursor.width,
        cursor.height,
        frame_width,
        frame_height,
    ) {
        Some(c) => {
            // Debug: log on first successful clip
            static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[COMPOSITE] Drawing cursor at draw_pos ({}, {}), clip: src({},{}) dst({},{}) size {}x{}",
                    cursor_draw_x, cursor_draw_y,
                    c.src_x, c.src_y, c.dst_x, c.dst_y, c.width, c.height);
            }
            c
        }
        None => {
            // Debug: cursor outside frame
            static LOGGED_OUTSIDE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !LOGGED_OUTSIDE.swap(true, std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[COMPOSITE] Cursor outside frame: draw_pos ({}, {}), cursor {}x{}, frame {}x{}",
                    cursor_draw_x, cursor_draw_y, cursor.width, cursor.height, frame_width, frame_height);
            }
            return;
        }
    };

    // Blend each visible pixel
    for row in 0..clip.height {
        for col in 0..clip.width {
            let src_x = clip.src_x + col;
            let src_y = clip.src_y + row;
            let dst_x = clip.dst_x + col;
            let dst_y = clip.dst_y + row;

            let src_idx = ((src_y * cursor.width + src_x) * 4) as usize;
            let dst_idx = ((dst_y * frame_width + dst_x) * 4) as usize;

            // Get source (cursor) pixel
            let src_b = cursor.bgra_data.get(src_idx).copied().unwrap_or(0);
            let src_g = cursor.bgra_data.get(src_idx + 1).copied().unwrap_or(0);
            let src_r = cursor.bgra_data.get(src_idx + 2).copied().unwrap_or(0);
            let src_a = cursor.bgra_data.get(src_idx + 3).copied().unwrap_or(0);

            // Skip fully transparent pixels
            if src_a == 0 {
                continue;
            }

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
