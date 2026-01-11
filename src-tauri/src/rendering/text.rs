//! Text preparation for GPU rendering.
//!
//! Converts TextSegment data from the project into PreparedText structures
//! ready for GPU rendering with glyphon.
//!
//! Based on Cap's text rendering implementation.

use crate::commands::video_recording::video_project::{TextSegment, XY};

/// Base text height used for size scaling calculations.
const BASE_TEXT_HEIGHT: f64 = 0.2;

/// Maximum font size in pixels to prevent performance issues.
const MAX_FONT_SIZE_PX: f32 = 256.0;

/// Prepared text segment ready for GPU rendering.
#[derive(Debug, Clone)]
pub struct PreparedText {
    /// Text content to render.
    pub content: String,
    /// Bounding box [left, top, right, bottom] in pixels.
    pub bounds: [f32; 4],
    /// Text color as RGBA (0.0-1.0).
    pub color: [f32; 4],
    /// Font family name.
    pub font_family: String,
    /// Font size in pixels.
    pub font_size: f32,
    /// Font weight (100-900).
    pub font_weight: f32,
    /// Whether to use italic style.
    pub italic: bool,
    /// Opacity (0.0-1.0), used for fade animations.
    pub opacity: f32,
}

/// Parse a hex color string to RGBA values.
pub fn parse_color(hex: &str) -> [f32; 4] {
    let color = hex.trim_start_matches('#');
    if color.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&color[0..2], 16),
            u8::from_str_radix(&color[2..4], 16),
            u8::from_str_radix(&color[4..6], 16),
        ) {
            return [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0];
        }
    }

    [1.0, 1.0, 1.0, 1.0]
}

/// Prepare text segments for rendering at a specific frame time.
///
/// Filters segments by time, calculates positions/sizes, and applies fade animations.
pub fn prepare_texts(
    output_size: XY<u32>,
    frame_time: f64,
    segments: &[TextSegment],
) -> Vec<PreparedText> {
    let mut prepared = Vec::new();
    let height_scale = if output_size.y == 0 {
        1.0
    } else {
        output_size.y as f32 / 1080.0
    };

    for segment in segments {
        if !segment.enabled {
            continue;
        }

        if frame_time < segment.start || frame_time > segment.end {
            continue;
        }

        let center = XY::new(
            segment.center.x.clamp(0.0, 1.0),
            segment.center.y.clamp(0.0, 1.0),
        );
        let size = XY::new(
            segment.size.x.clamp(0.01, 2.0),
            segment.size.y.clamp(0.01, 2.0),
        );
        let size_scale = (size.y / BASE_TEXT_HEIGHT).clamp(0.25, 4.0) as f32;

        let width = (size.x * output_size.x as f64).max(1.0) as f32;
        let height = (size.y * output_size.y as f64).max(1.0) as f32;
        let half_w = width / 2.0;
        let half_h = height / 2.0;

        let left = (center.x as f32 * output_size.x as f32 - half_w).max(0.0);
        let top = (center.y as f32 * output_size.y as f32 - half_h).max(0.0);
        let right = (left + width).min(output_size.x as f32);
        let bottom = (top + height).min(output_size.y as f32);

        let fade_duration = segment.fade_duration.max(0.0);
        let opacity = if fade_duration > 0.0 {
            let time_since_start = (frame_time - segment.start).max(0.0);
            let time_until_end = (segment.end - frame_time).max(0.0);

            let fade_in = (time_since_start / fade_duration).min(1.0);
            let fade_out = (time_until_end / fade_duration).min(1.0);

            (fade_in * fade_out) as f32
        } else {
            1.0
        };

        prepared.push(PreparedText {
            content: segment.content.clone(),
            bounds: [left, top, right, bottom],
            color: parse_color(&segment.color),
            font_family: segment.font_family.clone(),
            font_size: ((segment.font_size * size_scale).max(1.0) * height_scale)
                .min(MAX_FONT_SIZE_PX),
            font_weight: segment.font_weight,
            italic: segment.italic,
            opacity,
        });
    }

    prepared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_color_hex() {
        let color = parse_color("#FF0000");
        assert!((color[0] - 1.0).abs() < 0.01);
        assert!(color[1].abs() < 0.01);
        assert!(color[2].abs() < 0.01);
        assert!((color[3] - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_color_white() {
        let color = parse_color("#ffffff");
        assert!((color[0] - 1.0).abs() < 0.01);
        assert!((color[1] - 1.0).abs() < 0.01);
        assert!((color[2] - 1.0).abs() < 0.01);
        assert!((color[3] - 1.0).abs() < 0.01);
    }
}
