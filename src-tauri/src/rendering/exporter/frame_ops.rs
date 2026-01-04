//! Frame manipulation operations.
//!
//! Includes scaling, blending, and cursor drawing.

use super::super::types::DecodedFrame;
use crate::commands::video_recording::video_project::SceneMode;

/// Scale a frame to COVER target dimensions (crop to fill, like CSS object-fit: cover).
/// Used for CameraOnly mode to show webcam fullscreen, matching Cap's approach.
///
/// Unlike FIT (contain), this crops the source to match the output aspect ratio,
/// ensuring the entire output is filled with no black bars.
pub fn scale_frame_to_fill(frame: &DecodedFrame, target_w: u32, target_h: u32) -> DecodedFrame {
    let src_w = frame.width as f32;
    let src_h = frame.height as f32;
    let target_w_f = target_w as f32;
    let target_h_f = target_h as f32;

    let src_aspect = src_w / src_h;
    let target_aspect = target_w_f / target_h_f;

    // Calculate crop bounds to match target aspect ratio (like Cap's camera_only mode)
    // This crops the minimum amount needed to fill the output
    let (crop_x, crop_y, crop_w, crop_h) = if src_aspect > target_aspect {
        // Source is wider than target - crop left and right
        let visible_width = src_h * target_aspect;
        let crop_x = (src_w - visible_width) / 2.0;
        (crop_x, 0.0, visible_width, src_h)
    } else {
        // Source is taller than target - crop top and bottom
        let visible_height = src_w / target_aspect;
        let crop_y = (src_h - visible_height) / 2.0;
        (0.0, crop_y, src_w, visible_height)
    };

    // Create output buffer
    let mut output = vec![0u8; (target_w * target_h * 4) as usize];

    // Scale from cropped region to target
    let scale_x = target_w_f / crop_w;
    let scale_y = target_h_f / crop_h;

    // Simple nearest-neighbor scaling from cropped region
    for dst_y in 0..target_h {
        for dst_x in 0..target_w {
            // Map destination pixel to source pixel (within cropped region)
            let src_x = (crop_x + (dst_x as f32 / scale_x)) as u32;
            let src_y = (crop_y + (dst_y as f32 / scale_y)) as u32;

            if src_x < frame.width && src_y < frame.height {
                let src_idx = ((src_y * frame.width + src_x) * 4) as usize;
                let dst_idx = ((dst_y * target_w + dst_x) * 4) as usize;

                if src_idx + 3 < frame.data.len() && dst_idx + 3 < output.len() {
                    output[dst_idx] = frame.data[src_idx];
                    output[dst_idx + 1] = frame.data[src_idx + 1];
                    output[dst_idx + 2] = frame.data[src_idx + 2];
                    output[dst_idx + 3] = frame.data[src_idx + 3];
                }
            }
        }
    }

    DecodedFrame {
        frame_number: frame.frame_number,
        timestamp_ms: frame.timestamp_ms,
        data: output,
        width: target_w,
        height: target_h,
    }
}

/// Blend source frame over destination with alpha opacity.
/// dest = dest * (1 - alpha) + src * alpha
///
/// Used for smooth scene transitions - blending fullscreen webcam over screen.
pub fn blend_frames_alpha(dest: &mut DecodedFrame, src: &DecodedFrame, alpha: f32) {
    if dest.width != src.width || dest.height != src.height {
        log::warn!(
            "[EXPORT] blend_frames_alpha: size mismatch dest={}x{} src={}x{}",
            dest.width,
            dest.height,
            src.width,
            src.height
        );
        return;
    }

    let inv_alpha = 1.0 - alpha;
    for i in (0..dest.data.len()).step_by(4) {
        if i + 3 < src.data.len() {
            dest.data[i] = ((dest.data[i] as f32 * inv_alpha) + (src.data[i] as f32 * alpha)) as u8;
            dest.data[i + 1] =
                ((dest.data[i + 1] as f32 * inv_alpha) + (src.data[i + 1] as f32 * alpha)) as u8;
            dest.data[i + 2] =
                ((dest.data[i + 2] as f32 * inv_alpha) + (src.data[i + 2] as f32 * alpha)) as u8;
            // Keep dest alpha (index i + 3)
        }
    }
}

/// Display implementation for SceneMode for logging.
impl std::fmt::Display for SceneMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneMode::Default => write!(f, "Default"),
            SceneMode::CameraOnly => write!(f, "CameraOnly"),
            SceneMode::ScreenOnly => write!(f, "ScreenOnly"),
        }
    }
}

/// Draw a cursor circle indicator at the given position.
///
/// Draws a white circle with semi-transparent fill and a darker border
/// to indicate cursor position when actual cursor images aren't available.
pub fn draw_cursor_circle(
    frame_data: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cursor_x: f32, // normalized 0-1
    cursor_y: f32, // normalized 0-1
    scale: f32,
) {
    // Circle parameters
    let base_radius = 12.0; // Base radius in pixels
    let radius = base_radius * scale;
    let border_width = 2.0 * scale;

    // Convert normalized position to pixel position
    let center_x = cursor_x * frame_width as f32;
    let center_y = cursor_y * frame_height as f32;

    // Bounding box for the circle
    let min_x = ((center_x - radius - border_width).floor() as i32).max(0);
    let max_x = ((center_x + radius + border_width).ceil() as i32).min(frame_width as i32 - 1);
    let min_y = ((center_y - radius - border_width).floor() as i32).max(0);
    let max_y = ((center_y + radius + border_width).ceil() as i32).min(frame_height as i32 - 1);

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f32 - center_x;
            let dy = y as f32 - center_y;
            let dist = (dx * dx + dy * dy).sqrt();

            let idx = ((y as u32 * frame_width + x as u32) * 4) as usize;
            if idx + 3 >= frame_data.len() {
                continue;
            }

            // Determine what to draw based on distance from center
            let inner_radius = radius - border_width;

            if dist <= inner_radius {
                // Inside the circle - semi-transparent white fill
                let alpha = 0.5;
                let fill_r = 255u8;
                let fill_g = 255u8;
                let fill_b = 255u8;

                // Smooth edge using anti-aliasing
                let edge_dist = inner_radius - dist;
                let edge_alpha = if edge_dist < 1.0 {
                    edge_dist * alpha
                } else {
                    alpha
                };
                let inv_alpha = 1.0 - edge_alpha;

                frame_data[idx] =
                    ((fill_r as f32 * edge_alpha) + (frame_data[idx] as f32 * inv_alpha)) as u8;
                frame_data[idx + 1] =
                    ((fill_g as f32 * edge_alpha) + (frame_data[idx + 1] as f32 * inv_alpha)) as u8;
                frame_data[idx + 2] =
                    ((fill_b as f32 * edge_alpha) + (frame_data[idx + 2] as f32 * inv_alpha)) as u8;
            } else if dist <= radius {
                // On the border - darker semi-transparent ring
                let alpha = 0.7;
                let border_r = 50u8;
                let border_g = 50u8;
                let border_b = 50u8;

                // Smooth edges
                let outer_edge = radius - dist;
                let inner_edge = dist - inner_radius;
                let edge_alpha = if outer_edge < 1.0 {
                    outer_edge * alpha
                } else if inner_edge < 1.0 {
                    inner_edge * alpha
                } else {
                    alpha
                };
                let inv_alpha = 1.0 - edge_alpha;

                frame_data[idx] =
                    ((border_r as f32 * edge_alpha) + (frame_data[idx] as f32 * inv_alpha)) as u8;
                frame_data[idx + 1] = ((border_g as f32 * edge_alpha)
                    + (frame_data[idx + 1] as f32 * inv_alpha))
                    as u8;
                frame_data[idx + 2] = ((border_b as f32 * edge_alpha)
                    + (frame_data[idx + 2] as f32 * inv_alpha))
                    as u8;
            }
        }
    }
}
