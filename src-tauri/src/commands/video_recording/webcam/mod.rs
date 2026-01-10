//! Webcam capture and compositing for video recording.
//!
//! Architecture (inspired by Cap):
//! - CameraFeed owns the camera hardware and broadcasts frames
//! - Multiple subscribers can register to receive frames:
//!   - Preview: converts to JPEG for browser display
//!   - Recording: encodes to H.264 for file output
//! - Frames are broadcast via non-blocking try_send (slow consumers drop frames)
//! - Same frames with same timestamps ensure perfect A/V sync

// Allow unused helpers - keeping for potential future use
#![allow(dead_code)]

mod capture;
mod channel_encoder;
mod composite;
mod device;
mod drift;
mod encoder;
mod feed;
mod gpu_preview;
mod native_frame;
mod preview;
mod preview_manager;
mod segmented;

// Legacy capture API (deprecated - use feed/preview instead)
pub use capture::{
    get_frame_receiver, is_capture_running, start_capture_service, start_capture_with_receiver,
    stop_capture_service, FrameReceiver, FrameSender, WEBCAM_BUFFER,
};

// New broadcast-based architecture
pub use feed::{
    global_feed_dimensions, is_global_feed_running, restart_global_feed, start_global_feed,
    stop_global_feed, subscribe_global, CameraFeed, Subscription,
};
pub use preview::{get_preview_jpeg, is_preview_running, start_preview, stop_preview};
// GPU-accelerated preview (Cap-style direct rendering)
pub use drift::{TimestampAnomalyTracker, VideoDriftTracker};
pub use gpu_preview::{
    get_manager as get_gpu_preview_manager, is_gpu_preview_running, start_gpu_preview,
    stop_gpu_preview, update_gpu_preview_state, GpuPreviewState,
};
pub use native_frame::NativeCameraFrame;
// composite_webcam no longer used - webcam composited via GPU in editor
pub use channel_encoder::{ChannelWebcamEncoder, EncoderResult};
pub use device::{get_webcam_devices, SupportedResolutions, WebcamDevice};
pub use encoder::{FeedWebcamEncoder, WebcamEncoderPipe};
pub use segmented::{
    concatenate_segments, SegmentInfo, SegmentedRecordingResult, SegmentedWebcamConfig,
    SegmentedWebcamMuxer,
};

// Centralized camera preview manager (Cap-style)
pub use preview_manager::{
    get_preview_manager, hide_camera_preview, is_camera_preview_showing, on_preview_window_close,
    show_camera_preview_async, update_preview_settings, CameraPreviewManager,
};

use serde::{Deserialize, Serialize};
use std::time::Instant;
use ts_rs::TS;

/// Webcam frame data ready for compositing.
///
/// **DEPRECATED**: Used by CPU-based webcam compositing, now replaced by GPU rendering.
#[allow(dead_code)]
#[derive(Clone)]
pub struct WebcamFrame {
    /// BGRA pixel data.
    pub bgra_data: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Unique frame ID (increments with each new frame from camera).
    /// Used by encoder to detect new frames and avoid duplicates.
    pub frame_id: u64,
    /// Wall-clock time when this frame was captured.
    /// Used by encoder to calculate PTS for correct playback timing.
    pub captured_at: Instant,
}

impl Default for WebcamFrame {
    fn default() -> Self {
        Self {
            bgra_data: Vec::new(),
            width: 0,
            height: 0,
            frame_id: 0,
            captured_at: Instant::now(),
        }
    }
}

/// Position of the webcam overlay on the recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// Custom position (x, y from top-left of recording).
    Custom {
        x: i32,
        y: i32,
    },
}

impl Default for WebcamPosition {
    fn default() -> Self {
        Self::BottomRight
    }
}

/// Size of the webcam overlay.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamSize {
    /// ~10% of recording width.
    Small,
    /// ~15% of recording width.
    Medium,
    /// ~20% of recording width.
    Large,
}

impl Default for WebcamSize {
    fn default() -> Self {
        Self::Medium
    }
}

impl WebcamSize {
    /// Get the diameter/width as a fraction of the recording width.
    pub fn as_fraction(&self) -> f32 {
        match self {
            WebcamSize::Small => 0.10,
            WebcamSize::Medium => 0.15,
            WebcamSize::Large => 0.20,
        }
    }
}

/// Shape of the webcam overlay.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamShape {
    /// Circular overlay (common for PiP).
    Circle,
    /// Rectangular overlay with rounded corners.
    Rectangle,
}

impl Default for WebcamShape {
    fn default() -> Self {
        Self::Circle
    }
}

/// Settings for webcam overlay during recording.
/// Note: Webcam capture always uses 1080p (or best available) and output
/// is capped at 1280 width (like Cap) for consistent file sizes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebcamSettings {
    /// Enable webcam overlay.
    pub enabled: bool,
    /// Selected webcam device index.
    pub device_index: usize,
    /// Position of the webcam overlay.
    pub position: WebcamPosition,
    /// Size of the webcam overlay.
    pub size: WebcamSize,
    /// Shape of the webcam overlay (circle or rectangle).
    pub shape: WebcamShape,
    /// Whether to mirror the webcam horizontally (selfie mode).
    pub mirror: bool,
}

impl Default for WebcamSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            device_index: 0,
            position: WebcamPosition::default(),
            size: WebcamSize::default(),
            shape: WebcamShape::default(),
            mirror: false,
        }
    }
}

/// Compute the position and size of the webcam overlay on a frame.
pub fn compute_webcam_rect(
    frame_width: u32,
    frame_height: u32,
    settings: &WebcamSettings,
) -> (i32, i32, u32) {
    // Calculate diameter based on size setting and frame width
    let diameter = (frame_width as f32 * settings.size.as_fraction()) as u32;
    let margin = 20_i32; // Pixels from edge

    let (x, y) = match &settings.position {
        WebcamPosition::TopLeft => (margin, margin),
        WebcamPosition::TopRight => ((frame_width as i32) - (diameter as i32) - margin, margin),
        WebcamPosition::BottomLeft => (margin, (frame_height as i32) - (diameter as i32) - margin),
        WebcamPosition::BottomRight => (
            (frame_width as i32) - (diameter as i32) - margin,
            (frame_height as i32) - (diameter as i32) - margin,
        ),
        WebcamPosition::Custom { x, y } => (*x, *y),
    };

    (x, y, diameter)
}

// === PREVIEW SERVICE FUNCTIONS ===
// Using new broadcast-based architecture (Cap-style)

/// Stop the webcam preview service.
pub fn stop_preview_service() {
    preview::stop_preview();
}

/// Start the webcam preview service.
pub fn start_preview_service(device_index: usize) -> Result<(), String> {
    preview::start_preview(device_index)
}

/// Check if the webcam preview is running.
pub fn is_preview_active() -> bool {
    preview::is_preview_running()
}

/// Get the latest webcam frame as base64 JPEG for browser preview.
/// Returns None if no frame available.
pub fn get_preview_frame_jpeg(_quality: u8) -> Option<String> {
    preview::get_preview_jpeg()
}

/// Get preview frame dimensions.
pub fn get_preview_dimensions() -> Option<(u32, u32)> {
    preview::get_preview_dimensions()
}

// === CHANNEL-BASED RECORDING INTEGRATION ===
// These functions provide a high-level API for using the new channel-based
// webcam recording system with drift tracking and optional segmentation.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::JoinHandle;

/// Handle for segmented webcam recording.
pub struct SegmentedRecordingHandle {
    thread: Option<JoinHandle<SegmentedRecordingResult>>,
    stop_signal: Arc<AtomicBool>,
    /// Output directory for segments.
    pub output_dir: PathBuf,
}

impl SegmentedRecordingHandle {
    /// Check if recording is still running.
    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .map(|t| !t.is_finished())
            .unwrap_or(false)
    }

    /// Signal stop and wait for completion.
    pub fn finish(mut self) -> Result<SegmentedRecordingResult, String> {
        use std::sync::atomic::Ordering;
        self.stop_signal.store(true, Ordering::SeqCst);

        self.thread
            .take()
            .ok_or_else(|| "Recorder thread already finished".to_string())?
            .join()
            .map_err(|_| "Recorder thread panicked".to_string())
    }

    /// Cancel recording and clean up.
    pub fn cancel(mut self) {
        use std::sync::atomic::Ordering;
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // Optionally clean up segments
        let _ = std::fs::remove_dir_all(&self.output_dir);
    }

    /// Get the manifest path.
    pub fn manifest_path(&self) -> PathBuf {
        self.output_dir.join("manifest.json")
    }
}

/// Start segmented webcam recording for crash recovery.
///
/// Records webcam to multiple short segments (~3 seconds each) with a manifest
/// file that enables recovery of completed segments if recording is interrupted.
///
/// # Arguments
/// * `device_index` - Webcam device index
/// * `output_dir` - Directory for segments and manifest
/// * `buffer_size` - Frame buffer size (default 30)
///
/// # Returns
/// A handle to control and finish the recording.
pub fn start_segmented_webcam_recording(
    device_index: usize,
    output_dir: PathBuf,
    buffer_size: Option<usize>,
) -> Result<SegmentedRecordingHandle, String> {
    let buf_size = buffer_size.unwrap_or(30);
    let recording_start = Instant::now();

    // Start capture service with channel
    let receiver = start_capture_with_receiver(device_index, buf_size)?;

    // Create segmented muxer
    let muxer = SegmentedWebcamMuxer::new(output_dir.clone(), receiver, recording_start);
    let stop_signal = muxer.stop_signal();

    // Spawn muxer thread
    let thread = std::thread::Builder::new()
        .name("webcam-segmented".to_string())
        .spawn(move || muxer.run())
        .map_err(|e| format!("Failed to spawn segmented recorder: {}", e))?;

    Ok(SegmentedRecordingHandle {
        thread: Some(thread),
        stop_signal,
        output_dir,
    })
}
