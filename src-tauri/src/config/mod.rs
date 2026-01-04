//! Application configuration management.
//!
//! This module provides centralized, thread-safe configuration for recording
//! and webcam settings. Replaces scattered global atomics with typed structs
//! behind RwLock for atomic batch updates.
//!
//! ## Architecture
//!
//! - `RecordingConfig`: All recording settings (FPS, quality, audio, etc.)
//! - `WebcamConfig`: Webcam overlay settings (position, size, shape, etc.)
//!
//! Both configs use `parking_lot::RwLock` for:
//! - Fast, non-poisoning locks
//! - Atomic batch updates from frontend
//! - Single IPC call instead of multiple atomic setters

pub mod recording;
pub mod webcam;

pub use recording::{RecordingConfig, RECORDING_CONFIG};
pub use webcam::{WebcamConfig, WEBCAM_CONFIG};
