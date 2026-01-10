//! SVG cursor rendering using resvg.
//!
//! Renders embedded SVG cursor icons to RGBA bitmaps for high-quality
//! cursor display. Falls back to captured bitmap if SVG is not available.

use crate::commands::video_recording::cursor::events::WindowsCursorShape;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Embedded SVG cursor data with metadata.
struct SvgCursorData {
    svg_data: &'static str,
    /// Hotspot as fraction of width/height (0-1)
    hotspot_x: f32,
    hotspot_y: f32,
}

/// Rendered SVG cursor as RGBA bitmap.
#[derive(Clone)]
pub struct RenderedSvgCursor {
    pub width: u32,
    pub height: u32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub data: Vec<u8>, // RGBA
}

/// Cache of rendered SVG cursors at different scales.
static SVG_CURSOR_CACHE: OnceLock<HashMap<(WindowsCursorShape, u32), RenderedSvgCursor>> =
    OnceLock::new();

// Embed SVG files at compile time
const ARROW_SVG: &str = include_str!("../cursor/info/assets/windows/arrow.svg");
const IBEAM_SVG: &str = include_str!("../cursor/info/assets/windows/ibeam.svg");
const WAIT_SVG: &str = include_str!("../cursor/info/assets/windows/wait.svg");
const CROSS_SVG: &str = include_str!("../cursor/info/assets/windows/cross.svg");
const UPARROW_SVG: &str = include_str!("../cursor/info/assets/windows/uparrow.svg");
const HAND_SVG: &str = include_str!("../cursor/info/assets/windows/hand.svg");
const NO_SVG: &str = include_str!("../cursor/info/assets/windows/no.svg");
const SIZEALL_SVG: &str = include_str!("../cursor/info/assets/windows/sizeall.svg");
const SIZENWSE_SVG: &str = include_str!("../cursor/info/assets/windows/sizenwse.svg");
const SIZENESW_SVG: &str = include_str!("../cursor/info/assets/windows/sizenesw.svg");
const SIZEWE_SVG: &str = include_str!("../cursor/info/assets/windows/sizewe.svg");
const SIZENS_SVG: &str = include_str!("../cursor/info/assets/windows/sizens.svg");
const APPSTARTING_SVG: &str = include_str!("../cursor/info/assets/windows/appstarting.svg");
const HELP_SVG: &str = include_str!("../cursor/info/assets/windows/help.svg");
const PEN_SVG: &str = include_str!("../cursor/info/assets/windows/pen.svg");
const PIN_SVG: &str = include_str!("../cursor/info/assets/windows/pin.svg");
const PERSON_SVG: &str = include_str!("../cursor/info/assets/windows/person.svg");

/// Get SVG data and hotspot for a cursor shape.
/// Hotspot values match Cap's implementation from CursorShapeWindows::resolve()
fn get_svg_data(shape: WindowsCursorShape) -> Option<SvgCursorData> {
    match shape {
        WindowsCursorShape::Arrow => Some(SvgCursorData {
            svg_data: ARROW_SVG,
            hotspot_x: 0.288,
            hotspot_y: 0.189,
        }),
        WindowsCursorShape::IBeam => Some(SvgCursorData {
            svg_data: IBEAM_SVG,
            hotspot_x: 0.490,
            hotspot_y: 0.471,
        }),
        WindowsCursorShape::Wait => Some(SvgCursorData {
            svg_data: WAIT_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.52,
        }),
        WindowsCursorShape::Cross => Some(SvgCursorData {
            svg_data: CROSS_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::UpArrow => Some(SvgCursorData {
            svg_data: UPARROW_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.05,
        }),
        WindowsCursorShape::Hand => Some(SvgCursorData {
            svg_data: HAND_SVG,
            hotspot_x: 0.441,
            hotspot_y: 0.143,
        }),
        WindowsCursorShape::No => Some(SvgCursorData {
            svg_data: NO_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::SizeAll => Some(SvgCursorData {
            svg_data: SIZEALL_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::SizeNWSE => Some(SvgCursorData {
            svg_data: SIZENWSE_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::SizeNESW => Some(SvgCursorData {
            svg_data: SIZENESW_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::SizeWE => Some(SvgCursorData {
            svg_data: SIZEWE_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::SizeNS => Some(SvgCursorData {
            svg_data: SIZENS_SVG,
            hotspot_x: 0.5,
            hotspot_y: 0.5,
        }),
        WindowsCursorShape::AppStarting => Some(SvgCursorData {
            svg_data: APPSTARTING_SVG,
            hotspot_x: 0.055,
            hotspot_y: 0.368,
        }),
        WindowsCursorShape::Help => Some(SvgCursorData {
            svg_data: HELP_SVG,
            hotspot_x: 0.056,
            hotspot_y: 0.127,
        }),
        WindowsCursorShape::Pen => Some(SvgCursorData {
            svg_data: PEN_SVG,
            hotspot_x: 0.055,
            hotspot_y: 0.945,
        }),
        WindowsCursorShape::Pin => Some(SvgCursorData {
            svg_data: PIN_SVG,
            hotspot_x: 0.245,
            hotspot_y: 0.05,
        }),
        WindowsCursorShape::Person => Some(SvgCursorData {
            svg_data: PERSON_SVG,
            hotspot_x: 0.235,
            hotspot_y: 0.05,
        }),
        // Scroll cursors - no SVG assets yet, fall back to bitmap
        WindowsCursorShape::ScrollNS
        | WindowsCursorShape::ScrollWE
        | WindowsCursorShape::ScrollNSEW
        | WindowsCursorShape::ScrollN
        | WindowsCursorShape::ScrollS
        | WindowsCursorShape::ScrollW
        | WindowsCursorShape::ScrollE
        | WindowsCursorShape::ScrollNW
        | WindowsCursorShape::ScrollNE
        | WindowsCursorShape::ScrollSW
        | WindowsCursorShape::ScrollSE
        | WindowsCursorShape::ArrowCD => None,
    }
}

/// Render an SVG cursor to RGBA bitmap at the specified scale.
///
/// Returns None if rendering fails.
pub fn render_svg_cursor(shape: WindowsCursorShape, scale: f32) -> Option<RenderedSvgCursor> {
    let svg_data = get_svg_data(shape)?;

    // Parse SVG
    let opts = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_str(svg_data.svg_data, &opts).ok()?;

    // Get original size
    let size = tree.size();
    let orig_width = size.width();
    let orig_height = size.height();

    // Calculate scaled dimensions
    let scaled_width = (orig_width * scale).ceil() as u32;
    let scaled_height = (orig_height * scale).ceil() as u32;

    // Minimum size of 1
    let scaled_width = scaled_width.max(1);
    let scaled_height = scaled_height.max(1);

    // Create pixmap for rendering
    let mut pixmap = resvg::tiny_skia::Pixmap::new(scaled_width, scaled_height)?;

    // Calculate transform for scaling
    let transform = resvg::tiny_skia::Transform::from_scale(
        scaled_width as f32 / orig_width,
        scaled_height as f32 / orig_height,
    );

    // Render SVG to pixmap
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    // Keep premultiplied alpha (like Cap) for correct compositing
    let mut rgba_data = Vec::with_capacity((scaled_width * scaled_height * 4) as usize);
    for pixel in pixmap.pixels() {
        rgba_data.extend_from_slice(&[pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]);
    }

    // Calculate hotspot in pixels
    let hotspot_x = (svg_data.hotspot_x * scaled_width as f32).round() as i32;
    let hotspot_y = (svg_data.hotspot_y * scaled_height as f32).round() as i32;

    Some(RenderedSvgCursor {
        width: scaled_width,
        height: scaled_height,
        hotspot_x,
        hotspot_y,
        data: rgba_data,
    })
}

/// Get or render an SVG cursor at the specified size.
///
/// Uses a cache to avoid re-rendering the same cursor at the same size.
/// The `target_height` is used to determine the scale factor.
pub fn get_svg_cursor(shape: WindowsCursorShape, target_height: u32) -> Option<RenderedSvgCursor> {
    // For now, just render fresh each time
    // In a production system, we'd use the cache
    let scale = target_height as f32 / 24.0; // Base cursor height is ~24px
    render_svg_cursor(shape, scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_arrow_cursor() {
        let cursor = render_svg_cursor(WindowsCursorShape::Arrow, 1.0);
        assert!(cursor.is_some());

        let cursor = cursor.unwrap();
        assert!(cursor.width > 0);
        assert!(cursor.height > 0);
        assert_eq!(
            cursor.data.len(),
            (cursor.width * cursor.height * 4) as usize
        );
    }

    #[test]
    fn test_render_all_cursors() {
        let shapes = [
            WindowsCursorShape::Arrow,
            WindowsCursorShape::IBeam,
            WindowsCursorShape::Wait,
            WindowsCursorShape::Cross,
            WindowsCursorShape::Hand,
            WindowsCursorShape::No,
            WindowsCursorShape::SizeAll,
        ];

        for shape in shapes {
            let cursor = render_svg_cursor(shape, 2.0);
            assert!(cursor.is_some(), "Failed to render {:?}", shape);
        }
    }
}
