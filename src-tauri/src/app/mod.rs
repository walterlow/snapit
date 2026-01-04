//! Application lifecycle and platform integration.
//!
//! This module contains extracted functionality from lib.rs for better organization:
//! - `tray`: System tray setup and menu handling
//! - `events`: Window event handlers

pub mod events;

#[cfg(desktop)]
pub mod tray;

// Re-export TrayState for external use
#[cfg(desktop)]
pub use tray::TrayState;
