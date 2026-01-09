//! GPU-accelerated video rendering for the video editor.
//!
//! This module provides real-time compositing with wgpu for smooth 60fps playback.
//! Architecture inspired by Cap's rendering engine.
//!
//! ## Components
//! - `types`: Core data structures (DecodedFrame, RenderOptions, etc.)
//! - `decoder`: Async video decoder with frame prefetching
//! - `renderer`: wgpu device/queue management and shader compilation
//! - `compositor`: Frame compositing pipeline
//! - `zoom`: Zoom interpolation with bezier easing
//! - `editor_instance`: Playback state management

pub mod compositor;
pub mod coord;
pub mod cursor;
pub mod decoder;
pub mod editor_instance;
pub mod exporter;
pub mod renderer;
pub mod scene;
pub mod stream_decoder;
pub mod svg_cursor;
pub mod types;
pub mod zoom;

pub use compositor::Compositor;
pub use coord::{
    CaptureSpace, Coord, FrameSpace, Rect, ScreenSpace, ScreenUVSpace, Size, TransformParams,
    ZoomedFrameSpace,
};
pub use cursor::{
    composite_cursor, composite_cursor_with_motion_blur, get_svg_cursor_image, CursorInterpolator,
    DecodedCursorImage, InterpolatedCursor,
};
pub use decoder::VideoDecoder;
pub use editor_instance::EditorInstance;
pub use exporter::export_video_gpu;
pub use renderer::Renderer;
pub use scene::{InterpolatedScene, SceneInterpolator};
pub use stream_decoder::StreamDecoder;
pub use svg_cursor::{get_svg_cursor, render_svg_cursor, RenderedSvgCursor};
pub use types::*;
pub use zoom::ZoomInterpolator;
