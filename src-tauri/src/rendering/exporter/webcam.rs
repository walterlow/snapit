//! Webcam overlay building and visibility helpers.

use super::super::types::{DecodedFrame, WebcamOverlay, WebcamShape};
use crate::commands::video_recording::video_project::{
    VideoProject, WebcamOverlayPosition, WebcamOverlayShape,
};

/// Build webcam overlay from frame and project settings.
/// Positioning logic matches WebcamOverlay.tsx exactly for WYSIWYG export.
pub fn build_webcam_overlay(
    project: &VideoProject,
    frame: DecodedFrame,
    out_w: u32,
    out_h: u32,
) -> WebcamOverlay {
    // Match preview exactly: 16px margin
    const MARGIN_PX: f32 = 16.0;

    // Calculate webcam aspect ratio from frame
    let webcam_aspect = frame.width as f32 / frame.height as f32;

    // Determine if we should use source aspect ratio (native webcam dimensions)
    let use_source_aspect = matches!(project.webcam.shape, WebcamOverlayShape::Source);

    // Base size (used as height for consistent sizing across shapes)
    let base_size_px = out_w as f32 * project.webcam.size;

    // Calculate webcam dimensions based on shape
    // For Source: preserve native aspect ratio (like Cap)
    // For others: force specific aspect ratios
    let (webcam_width_px, webcam_height_px) = if use_source_aspect {
        // Source shape: preserve native webcam aspect ratio
        // Like Cap: base size is the smaller dimension
        if webcam_aspect >= 1.0 {
            // Landscape webcam: width = base * aspect, height = base
            (base_size_px * webcam_aspect, base_size_px)
        } else {
            // Portrait webcam: width = base, height = base / aspect
            (base_size_px, base_size_px / webcam_aspect)
        }
    } else if matches!(project.webcam.shape, WebcamOverlayShape::Rectangle) {
        // Rectangle: force 16:9 aspect ratio
        (base_size_px * (16.0 / 9.0), base_size_px)
    } else {
        // Circle, RoundedRectangle: force 1:1 square
        (base_size_px, base_size_px)
    };

    // Calculate position in PIXELS first (matching WebcamOverlay.tsx getPositionStyle)
    let (left_px, top_px) = match project.webcam.position {
        WebcamOverlayPosition::TopLeft => (MARGIN_PX, MARGIN_PX),
        WebcamOverlayPosition::TopRight => (out_w as f32 - webcam_width_px - MARGIN_PX, MARGIN_PX),
        WebcamOverlayPosition::BottomLeft => {
            (MARGIN_PX, out_h as f32 - webcam_height_px - MARGIN_PX)
        },
        WebcamOverlayPosition::BottomRight => (
            out_w as f32 - webcam_width_px - MARGIN_PX,
            out_h as f32 - webcam_height_px - MARGIN_PX,
        ),
        WebcamOverlayPosition::Custom => {
            // Custom positioning matches preview logic
            let custom_x = project.webcam.custom_x;
            let custom_y = project.webcam.custom_y;

            let left = if custom_x <= 0.1 {
                MARGIN_PX
            } else if custom_x >= 0.9 {
                out_w as f32 - webcam_width_px - MARGIN_PX
            } else {
                custom_x * out_w as f32 - webcam_width_px / 2.0
            };

            let top = if custom_y <= 0.1 {
                MARGIN_PX
            } else if custom_y >= 0.9 {
                out_h as f32 - webcam_height_px - MARGIN_PX
            } else {
                custom_y * out_h as f32 - webcam_height_px / 2.0
            };

            (left, top)
        },
    };

    // Convert to normalized coordinates (0-1)
    let x_norm = left_px / out_w as f32;
    let y_norm = top_px / out_h as f32;

    // Log for debugging
    eprintln!(
        "[EXPORT] Webcam: {}x{} aspect={:.3}, overlay={}x{}px, pos=({:.0},{:.0})px norm=({:.3},{:.3}), source_aspect={}",
        frame.width,
        frame.height,
        webcam_aspect,
        webcam_width_px,
        webcam_height_px,
        left_px,
        top_px,
        x_norm,
        y_norm,
        use_source_aspect
    );

    let shape = match project.webcam.shape {
        WebcamOverlayShape::Circle => WebcamShape::Circle,
        WebcamOverlayShape::Rectangle => WebcamShape::Rectangle,
        // Use Squircle for both RoundedRectangle and Source (Source = native aspect + squircle)
        WebcamOverlayShape::RoundedRectangle | WebcamOverlayShape::Source => WebcamShape::Squircle,
    };

    // Match preview formula from WebcamOverlay.tsx getShadowFilter():
    // blur = (shadow/100) * minDim * 0.15
    // opacity = (shadow/100) * 0.5
    let strength = project.webcam.shadow / 100.0;
    let shadow = strength; // Pass strength as shadow_strength to shader
    let shadow_size = 0.15; // Matches preview: strength * minDim * 0.15
    let shadow_opacity = strength * 0.5; // Matches preview: max 50% opacity
    let shadow_blur = 0.15; // Same as size for consistent falloff

    WebcamOverlay {
        frame,
        x: x_norm,
        y: y_norm,
        size: project.webcam.size,
        shape,
        mirror: project.webcam.mirror,
        use_source_aspect,
        shadow,
        shadow_size,
        shadow_opacity,
        shadow_blur,
    }
}

/// Check if webcam should be visible at a specific timestamp.
pub fn is_webcam_visible_at(project: &VideoProject, timestamp_ms: u64) -> bool {
    // If webcam is disabled globally, it's not visible
    if !project.webcam.enabled {
        return false;
    }

    // If no visibility segments defined, webcam is always visible
    if project.webcam.visibility_segments.is_empty() {
        return true;
    }

    // Check visibility segments - find the last segment that starts before this timestamp
    let mut is_visible = true; // Default to visible
    for segment in &project.webcam.visibility_segments {
        if timestamp_ms >= segment.start_ms && timestamp_ms < segment.end_ms {
            is_visible = segment.visible;
        }
    }

    is_visible
}
