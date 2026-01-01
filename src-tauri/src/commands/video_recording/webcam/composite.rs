//! Webcam frame compositing onto video frame buffer.
//!
//! Alpha blends the webcam frame onto the captured screen frame
//! with support for circular and rectangular shapes.

use super::{compute_webcam_rect, WebcamFrame, WebcamSettings, WebcamShape};

/// Composite webcam frame onto the recording frame buffer.
///
/// # Arguments
/// * `frame` - Mutable BGRA frame buffer (recording output).
/// * `frame_width` - Recording frame width in pixels.
/// * `frame_height` - Recording frame height in pixels.
/// * `webcam` - Webcam frame to composite.
/// * `settings` - Webcam overlay settings (position, size, shape).
pub fn composite_webcam(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    webcam: &WebcamFrame,
    settings: &WebcamSettings,
) {
    if webcam.width == 0 || webcam.height == 0 || webcam.bgra_data.is_empty() {
        return;
    }

    let (pos_x, pos_y, diameter) = compute_webcam_rect(frame_width, frame_height, settings);

    match settings.shape {
        WebcamShape::Circle => {
            composite_circle(
                frame,
                frame_width,
                frame_height,
                webcam,
                pos_x,
                pos_y,
                diameter,
            );
        }
        WebcamShape::Rectangle => {
            composite_rectangle(
                frame,
                frame_width,
                frame_height,
                webcam,
                pos_x,
                pos_y,
                diameter,
                diameter, // Square for now, could support different aspect ratios
            );
        }
    }
}

/// Composite webcam frame as a circle onto the recording frame.
fn composite_circle(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    webcam: &WebcamFrame,
    center_x: i32,
    center_y: i32,
    diameter: u32,
) {
    let radius = diameter as f32 / 2.0;
    let center_offset = radius;

    // Border settings
    let border_width = 3.0_f32;
    let border_color = [60, 60, 60, 255]; // Dark gray border (BGRA)

    // Iterate over the bounding box of the circle
    for dy in 0..diameter {
        for dx in 0..diameter {
            // Calculate position in frame
            let frame_x = center_x + dx as i32;
            let frame_y = center_y + dy as i32;

            // Skip if outside frame bounds
            if frame_x < 0
                || frame_y < 0
                || frame_x >= frame_width as i32
                || frame_y >= frame_height as i32
            {
                continue;
            }

            // Calculate distance from center of circle
            let rel_x = dx as f32 - center_offset;
            let rel_y = dy as f32 - center_offset;
            let distance = (rel_x * rel_x + rel_y * rel_y).sqrt();

            // Skip if outside circle
            if distance > radius {
                continue;
            }

            // Calculate frame buffer index
            let frame_idx = ((frame_y as u32 * frame_width + frame_x as u32) * 4) as usize;
            if frame_idx + 3 >= frame.len() {
                continue;
            }

            // Check if we're in the border region
            if distance > radius - border_width {
                // Draw border with anti-aliasing at the edge
                let _edge_factor = (radius - distance) / border_width;
                let alpha = if distance > radius - 1.0 {
                    // Anti-alias the outer edge
                    (radius - distance).max(0.0)
                } else {
                    1.0
                };

                if alpha > 0.0 {
                    blend_pixel(frame, frame_idx, &border_color, alpha);
                }
                continue;
            }

            // Map to webcam coordinates (scale to fit)
            let webcam_x = (dx as f32 / diameter as f32 * webcam.width as f32) as u32;
            let webcam_y = (dy as f32 / diameter as f32 * webcam.height as f32) as u32;

            // Bounds check for webcam
            if webcam_x >= webcam.width || webcam_y >= webcam.height {
                continue;
            }

            let webcam_idx = ((webcam_y * webcam.width + webcam_x) * 4) as usize;
            if webcam_idx + 3 >= webcam.bgra_data.len() {
                continue;
            }

            // Get webcam pixel (BGRA)
            let src_b = webcam.bgra_data[webcam_idx];
            let src_g = webcam.bgra_data[webcam_idx + 1];
            let src_r = webcam.bgra_data[webcam_idx + 2];
            let src_a = webcam.bgra_data[webcam_idx + 3];

            // Anti-alias the inner edge (near border)
            let inner_edge_distance = (radius - border_width) - distance;
            let alpha_factor = if inner_edge_distance < 1.0 {
                inner_edge_distance.max(0.0)
            } else {
                1.0
            };

            // Blend onto frame
            let final_alpha = (src_a as f32 / 255.0) * alpha_factor;
            if final_alpha > 0.0 {
                blend_pixel(frame, frame_idx, &[src_b, src_g, src_r, 255], final_alpha);
            }
        }
    }
}

/// Composite webcam frame as a rectangle onto the recording frame.
fn composite_rectangle(
    frame: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    webcam: &WebcamFrame,
    pos_x: i32,
    pos_y: i32,
    width: u32,
    height: u32,
) {
    let corner_radius = 8.0_f32; // Rounded corners
    let border_width = 3.0_f32;
    let border_color = [60, 60, 60, 255]; // Dark gray border (BGRA)

    for dy in 0..height {
        for dx in 0..width {
            let frame_x = pos_x + dx as i32;
            let frame_y = pos_y + dy as i32;

            // Skip if outside frame bounds
            if frame_x < 0
                || frame_y < 0
                || frame_x >= frame_width as i32
                || frame_y >= frame_height as i32
            {
                continue;
            }

            // Check if we're in a corner region that needs rounding
            let in_rounded_corner = is_in_rounded_corner(
                dx as f32,
                dy as f32,
                width as f32,
                height as f32,
                corner_radius,
            );

            if in_rounded_corner.is_none() {
                continue; // Outside rounded corner, skip
            }

            let frame_idx = ((frame_y as u32 * frame_width + frame_x as u32) * 4) as usize;
            if frame_idx + 3 >= frame.len() {
                continue;
            }

            // Check if in border region
            let is_border = dx < border_width as u32
                || dy < border_width as u32
                || dx >= width - border_width as u32
                || dy >= height - border_width as u32;

            if is_border {
                blend_pixel(frame, frame_idx, &border_color, 1.0);
                continue;
            }

            // Map to webcam coordinates
            let webcam_x = (dx as f32 / width as f32 * webcam.width as f32) as u32;
            let webcam_y = (dy as f32 / height as f32 * webcam.height as f32) as u32;

            if webcam_x >= webcam.width || webcam_y >= webcam.height {
                continue;
            }

            let webcam_idx = ((webcam_y * webcam.width + webcam_x) * 4) as usize;
            if webcam_idx + 3 >= webcam.bgra_data.len() {
                continue;
            }

            // Get webcam pixel
            let src_b = webcam.bgra_data[webcam_idx];
            let src_g = webcam.bgra_data[webcam_idx + 1];
            let src_r = webcam.bgra_data[webcam_idx + 2];
            let src_a = webcam.bgra_data[webcam_idx + 3];

            let alpha = src_a as f32 / 255.0;
            if alpha > 0.0 {
                blend_pixel(frame, frame_idx, &[src_b, src_g, src_r, 255], alpha);
            }
        }
    }
}

/// Check if a point is inside or outside the rounded corners.
/// Returns Some(distance_from_edge) if inside, None if outside.
fn is_in_rounded_corner(x: f32, y: f32, width: f32, height: f32, radius: f32) -> Option<f32> {
    // Check each corner
    let corners = [
        (radius, radius),                  // Top-left
        (width - radius, radius),          // Top-right
        (radius, height - radius),         // Bottom-left
        (width - radius, height - radius), // Bottom-right
    ];

    for (cx, cy) in corners {
        // Check if point is in corner quadrant
        let in_corner = (x < radius && y < radius)                              // Top-left
            || (x > width - radius && y < radius)                               // Top-right
            || (x < radius && y > height - radius)                              // Bottom-left
            || (x > width - radius && y > height - radius); // Bottom-right

        if in_corner {
            // Calculate distance from corner center
            let dx = x - cx;
            let dy = y - cy;
            let distance = (dx * dx + dy * dy).sqrt();

            if distance > radius {
                return None; // Outside rounded corner
            }
        }
    }

    Some(0.0) // Inside rectangle (including rounded corners)
}

/// Blend a source pixel onto the frame buffer.
fn blend_pixel(frame: &mut [u8], idx: usize, src: &[u8; 4], alpha: f32) {
    if alpha >= 1.0 {
        // Fully opaque - direct copy
        frame[idx] = src[0]; // B
        frame[idx + 1] = src[1]; // G
        frame[idx + 2] = src[2]; // R
    } else if alpha > 0.0 {
        // Alpha blend
        let inv_alpha = 1.0 - alpha;
        frame[idx] = (src[0] as f32 * alpha + frame[idx] as f32 * inv_alpha) as u8;
        frame[idx + 1] = (src[1] as f32 * alpha + frame[idx + 1] as f32 * inv_alpha) as u8;
        frame[idx + 2] = (src[2] as f32 * alpha + frame[idx + 2] as f32 * inv_alpha) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_webcam_rect_bottom_right() {
        let settings = WebcamSettings {
            enabled: true,
            device_index: 0,
            position: super::super::WebcamPosition::BottomRight,
            size: super::super::WebcamSize::Medium, // 15%
            shape: WebcamShape::Circle,
            mirror: false,
        };

        let (x, y, diameter) = compute_webcam_rect(1920, 1080, &settings);

        // 15% of 1920 = 288
        assert_eq!(diameter, 288);
        // Right edge: 1920 - 288 - 20 = 1612
        assert_eq!(x, 1612);
        // Bottom edge: 1080 - 288 - 20 = 772
        assert_eq!(y, 772);
    }
}
