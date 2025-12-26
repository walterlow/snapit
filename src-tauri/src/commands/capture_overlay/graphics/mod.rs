//! Graphics subsystem for the capture overlay.
//!
//! This module provides all the graphics infrastructure needed for rendering
//! the transparent overlay using DirectComposition and Direct2D.
//!
//! # Architecture
//!
//! ```text
//! D3D11 Device
//!     |
//!     +-- DXGI Swap Chain (for composition)
//!     |       |
//!     |       +-- DirectComposition (transparent window)
//!     |
//!     +-- D2D Device Context (for drawing)
//!             |
//!             +-- Brushes, text format, stroke styles
//! ```
//!
//! # Modules
//!
//! - `d3d` - D3D11 device and swap chain creation
//! - `d2d` - Direct2D context, brushes, and text
//! - `compositor` - DirectComposition setup

pub mod compositor;
pub mod d2d;
pub mod d3d;

pub use compositor::CompositorResources;
pub use d2d::D2DResources;
