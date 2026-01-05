//! Tauri command handlers.
//!
//! This module contains all Tauri IPC command implementations, organized by domain.
//!
//! ## Command Modules
//!
//! | Module | Description |
//! |--------|-------------|
//! | [`capture`] | Screen/window capture with transparency support |
//! | [`capture_overlay`] | Native DirectComposition overlay for region selection |
//! | [`capture_settings`] | Screenshot/video/GIF settings types |
//! | [`fonts`] | System font enumeration |
//! | [`image`] | Clipboard operations |
//! | [`keyboard_hook`] | Windows low-level keyboard hook for global shortcuts |
//! | [`logging`] | Frontend logging bridge |
//! | [`settings`] | App settings (autostart, close-to-tray, etc.) |
//! | [`storage`] | Project persistence and library management |
//! | [`video_recording`] | Video/GIF recording and editing |
//! | [`window`] | Window management (toolbar, overlay, editor) |
//!
//! ## Adding New Commands
//!
//! 1. Add the command function with `#[tauri::command]` in the appropriate module
//! 2. Register it in `lib.rs` invoke_handler (commands can't be re-exported)
//! 3. Run `cargo test --lib` to generate TypeScript types if using `ts-rs`

pub mod capture;
pub mod capture_overlay;
pub mod capture_settings;
pub mod fonts;
pub mod image;
pub mod keyboard_hook;
pub mod logging;
pub mod settings;
pub mod storage;
pub mod video_recording;
pub mod win_utils;
pub mod window;
