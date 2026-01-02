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

pub mod types;
pub mod decoder;
pub mod stream_decoder;
pub mod renderer;
pub mod compositor;
pub mod zoom;
pub mod scene;
pub mod editor_instance;
pub mod exporter;

pub use types::*;
pub use decoder::VideoDecoder;
pub use stream_decoder::StreamDecoder;
pub use renderer::Renderer;
pub use compositor::Compositor;
pub use zoom::ZoomInterpolator;
pub use scene::{InterpolatedScene, SceneInterpolator};
pub use editor_instance::EditorInstance;
pub use exporter::export_video_gpu;
