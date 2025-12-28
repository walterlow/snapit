//! Input handling for the capture overlay.
//!
//! This module provides:
//! - Hit-testing for resize handles
//! - Window detection under cursor
//!
//! # Modules
//!
//! - `hit_test` - Resize handle hit-testing
//! - `window_detect` - Window enumeration and detection

pub mod hit_test;
pub mod window_detect;

pub use hit_test::hit_test_handle;
pub use window_detect::get_window_at_point;
