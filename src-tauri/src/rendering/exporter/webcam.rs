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
    // Match preview exactly: 16px margin, square pixels
    const MARGIN_PX: f32 = 16.0;

    // Webcam overlay is square in PIXELS (same as preview)
    let webcam_size_px = out_w as f32 * project.webcam.size;

    // Calculate position in PIXELS first (matching WebcamOverlay.tsx getPositionStyle)
    let (left_px, top_px) = match project.webcam.position {
        WebcamOverlayPosition::TopLeft => (MARGIN_PX, MARGIN_PX),
        WebcamOverlayPosition::TopRight => (out_w as f32 - webcam_size_px - MARGIN_PX, MARGIN_PX),
        WebcamOverlayPosition::BottomLeft => (MARGIN_PX, out_h as f32 - webcam_size_px - MARGIN_PX),
        WebcamOverlayPosition::BottomRight => (
            out_w as f32 - webcam_size_px - MARGIN_PX,
            out_h as f32 - webcam_size_px - MARGIN_PX,
        ),
        WebcamOverlayPosition::Custom => {
            // Custom positioning matches preview logic
            let custom_x = project.webcam.custom_x;
            let custom_y = project.webcam.custom_y;

            let left = if custom_x <= 0.1 {
                MARGIN_PX
            } else if custom_x >= 0.9 {
                out_w as f32 - webcam_size_px - MARGIN_PX
            } else {
                custom_x * out_w as f32 - webcam_size_px / 2.0
            };

            let top = if custom_y <= 0.1 {
                MARGIN_PX
            } else if custom_y >= 0.9 {
                out_h as f32 - webcam_size_px - MARGIN_PX
            } else {
                custom_y * out_h as f32 - webcam_size_px / 2.0
            };

            (left, top)
        },
    };

    // Convert to normalized coordinates (0-1)
    let x_norm = left_px / out_w as f32;
    let y_norm = top_px / out_h as f32;

    // Log for debugging
    eprintln!(
        "[EXPORT] Webcam: {}x{} aspect={:.3}, overlay={}px, pos=({:.0},{:.0})px norm=({:.3},{:.3})",
        frame.width,
        frame.height,
        frame.width as f32 / frame.height as f32,
        webcam_size_px,
        left_px,
        top_px,
        x_norm,
        y_norm
    );

    let shape = match project.webcam.shape {
        WebcamOverlayShape::Circle => WebcamShape::Circle,
        WebcamOverlayShape::Rectangle => WebcamShape::Rectangle,
        // Use Squircle for RoundedRectangle (iOS-style)
        WebcamOverlayShape::RoundedRectangle => WebcamShape::Squircle,
    };

    // Default shadow settings (subtle drop shadow like Cap)
    // TODO: Add shadow settings to WebcamConfig for user control
    let shadow = 0.5; // 50% shadow strength
    let shadow_size = 0.15; // 15% of webcam size
    let shadow_opacity = 0.25; // 25% opacity
    let shadow_blur = 0.3; // 30% blur

    WebcamOverlay {
        frame,
        x: x_norm,
        y: y_norm,
        size: project.webcam.size,
        shape,
        mirror: project.webcam.mirror,
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
