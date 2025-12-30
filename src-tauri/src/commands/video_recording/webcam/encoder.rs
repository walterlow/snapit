//! Webcam video encoder for separate webcam recording.
//!
//! Encodes webcam frames to a separate video file for post-editing.
//! The webcam video can be toggled on/off in the video editor.
//!
//! IMPORTANT: This encoder does NOT create its own webcam capture.
//! It pulls frames from the WebcamPreviewService which is the single
//! source of truth for webcam capture. This avoids hardware conflicts
//! where multiple captures try to open the same webcam device.
//!
//! TIMING: Uses wall-clock timestamps from `WebcamFrame.captured_at` to ensure
//! correct playback speed. The webcam runs at its max native FPS (independent
//! of screen recording FPS), and timestamps are calculated relative to
//! `recording_start` for accurate real-time playback.

use std::path::PathBuf;
use std::time::Instant;

use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};

// NOTE: This encoder module is no longer used. Webcam recording is now handled
// by browser MediaRecorder which sends chunks to Rust via webcam_recording_chunk command.
// Keeping this file for reference but it won't compile without the deleted preview module.
// TODO: Remove this file entirely once browser-based recording is fully validated.

// Stub functions to allow compilation (these are never called)
fn get_preview_dimensions() -> Option<(u32, u32)> {
    None
}

fn get_preview_frame() -> Option<super::WebcamFrame> {
    None
}

/// Webcam video encoder for recording webcam to a separate file.
///
/// This encoder pulls frames from the shared WebcamPreviewService
/// rather than opening its own capture. This ensures:
/// 1. No hardware conflicts (webcam opened only once)
/// 2. Consistent frame timing with the preview
/// 3. Same frames shown in preview are encoded
/// 4. Real-time playback via wall-clock timestamps
pub struct WebcamEncoder {
    /// The video encoder.
    encoder: VideoEncoder,
    /// Output video dimensions.
    width: u32,
    height: u32,
    /// Frame buffer for vertical flip.
    flip_buffer: Vec<u8>,
    /// When recording started (for wall-clock timestamp calculation).
    recording_start: Instant,
    /// Frame count for stats/logging.
    frame_count: u64,
    /// Last processed frame ID (to avoid encoding duplicates).
    last_frame_id: u64,
}

/// Default FPS for webcam video container (actual frame timing uses wall-clock).
/// 30fps is standard for webcams and sufficient for PiP overlay.
const WEBCAM_VIDEO_FPS: u32 = 30;

impl WebcamEncoder {
    /// Create a new webcam encoder.
    ///
    /// # Arguments
    /// * `output_path` - Path to save the webcam video.
    /// * `width` - Video width (should match camera resolution).
    /// * `height` - Video height (should match camera resolution).
    ///
    /// Note: The encoder pulls frames from the WebcamPreviewService,
    /// so the preview service must be started before recording begins.
    /// Use `new_auto()` to auto-detect resolution from the preview service.
    /// 
    /// Timestamps are derived from wall-clock time (`WebcamFrame.captured_at`),
    /// ensuring correct real-time playback regardless of camera FPS.
    pub fn new(output_path: &PathBuf, width: u32, height: u32) -> Result<Self, String> {
        // Calculate bitrate based on resolution (higher res = higher bitrate)
        // 1080p: ~8 Mbps, 720p: ~4 Mbps, 480p: ~2 Mbps
        let bitrate = match (width, height) {
            (w, h) if w >= 1920 || h >= 1080 => 8_000_000,
            (w, h) if w >= 1280 || h >= 720 => 4_000_000,
            _ => 2_000_000,
        };

        // Create encoder with no audio
        // FPS is nominal - actual timing comes from wall-clock timestamps
        let video_settings = VideoSettingsBuilder::new(width, height)
            .bitrate(bitrate)
            .frame_rate(WEBCAM_VIDEO_FPS);

        let audio_settings = AudioSettingsBuilder::default().disabled(true);

        let encoder = VideoEncoder::new(
            video_settings,
            audio_settings,
            ContainerSettingsBuilder::default(),
            output_path,
        )
        .map_err(|e| format!("Failed to create webcam encoder: {:?}", e))?;

        let frame_size = (width * height * 4) as usize;

        eprintln!(
            "[WEBCAM_ENC] Created webcam encoder ({}x{}, {} Mbps, wall-clock timing)",
            width, height, bitrate / 1_000_000
        );

        Ok(Self {
            encoder,
            width,
            height,
            flip_buffer: vec![0u8; frame_size],
            recording_start: Instant::now(),
            frame_count: 0,
            last_frame_id: u64::MAX, // Start with invalid ID so first frame is always new
        })
    }

    /// Create a new webcam encoder with auto-detected resolution.
    ///
    /// Queries the preview service for the current camera resolution.
    /// Falls back to 1280x720 if dimensions not available yet.
    pub fn new_auto(output_path: &PathBuf) -> Result<Self, String> {
        // Try to get dimensions from preview service (preferred - doesn't need frame)
        let (width, height) = if let Some((w, h)) = get_preview_dimensions() {
            eprintln!("[WEBCAM_ENC] Auto-detected resolution: {}x{}", w, h);
            (w, h)
        } else if let Some(frame) = get_preview_frame() {
            // Fallback to getting from a frame
            eprintln!(
                "[WEBCAM_ENC] Got resolution from frame: {}x{}",
                frame.width, frame.height
            );
            (frame.width, frame.height)
        } else {
            // Last resort fallback to 720p
            eprintln!("[WEBCAM_ENC] No dimensions available, using 1280x720 fallback");
            (1280, 720)
        };

        Self::new(output_path, width, height)
    }

    /// Process one frame - get from preview service, resize if needed, encode.
    /// Call this in the main recording loop.
    ///
    /// Returns true if a NEW frame was processed, false if no new frame available.
    /// Skips duplicate frames (same frame_id) to avoid encoding the same frame twice.
    pub fn process_frame(&mut self) -> Result<bool, String> {
        // Get latest webcam frame from preview service (single source of truth)
        let frame = match get_preview_frame() {
            Some(f) => f,
            None => return Ok(false),
        };

        // Skip if we've already encoded this frame (avoid duplicates)
        // This happens when the main recording loop runs faster than webcam FPS
        if frame.frame_id == self.last_frame_id {
            return Ok(false);
        }
        self.last_frame_id = frame.frame_id;

        // Calculate timestamp from wall-clock time for real-time playback
        // This ensures the webcam video plays at the same speed as reality,
        // regardless of camera FPS or recording loop speed
        let elapsed = frame.captured_at.duration_since(self.recording_start);
        let timestamp_100ns = (elapsed.as_nanos() / 100) as i64;
        
        // Log periodically to debug frame production
        if self.frame_count == 0 || self.frame_count % 60 == 0 {
            eprintln!(
                "[WEBCAM_ENC] Encoding frame {} (id={}, ts={:.2}s)", 
                self.frame_count, frame.frame_id, elapsed.as_secs_f64()
            );
        }
        self.frame_count += 1;

        // Resize frame to encoder dimensions if needed
        let frame_data = if frame.width == self.width && frame.height == self.height {
            frame.bgra_data.clone()
        } else {
            // Simple nearest-neighbor resize
            resize_bgra(
                &frame.bgra_data,
                frame.width,
                frame.height,
                self.width,
                self.height,
            )
        };

        // Flip vertically (encoder expects bottom-up)
        let flipped = flip_vertical_bgra(&frame_data, self.width, self.height, &mut self.flip_buffer);

        // Send to encoder
        if let Err(e) = self.encoder.send_frame_buffer(flipped, timestamp_100ns) {
            eprintln!("[WEBCAM_ENC] Failed to encode frame: {:?}", e);
        }

        Ok(true)
    }

    /// Finalize encoding and save the video file.
    pub fn finish(self) -> Result<(), String> {
        eprintln!(
            "[WEBCAM_ENC] Finishing webcam encoder ({} frames)",
            self.frame_count
        );

        // Finish encoding
        self.encoder
            .finish()
            .map_err(|e| format!("Failed to finish webcam encoding: {:?}", e))?;

        eprintln!("[WEBCAM_ENC] Webcam encoding finished");
        Ok(())
    }

    /// Get the number of frames encoded so far.
    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }
}

/// Simple nearest-neighbor resize for BGRA image.
fn resize_bgra(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    let mut dst = vec![0u8; (dst_w * dst_h * 4) as usize];

    let x_ratio = src_w as f32 / dst_w as f32;
    let y_ratio = src_h as f32 / dst_h as f32;

    for y in 0..dst_h {
        for x in 0..dst_w {
            let src_x = (x as f32 * x_ratio) as u32;
            let src_y = (y as f32 * y_ratio) as u32;

            let src_idx = ((src_y * src_w + src_x) * 4) as usize;
            let dst_idx = ((y * dst_w + x) * 4) as usize;

            if src_idx + 3 < src.len() && dst_idx + 3 < dst.len() {
                dst[dst_idx] = src[src_idx];
                dst[dst_idx + 1] = src[src_idx + 1];
                dst[dst_idx + 2] = src[src_idx + 2];
                dst[dst_idx + 3] = src[src_idx + 3];
            }
        }
    }

    dst
}

/// Flip BGRA image vertically into provided buffer.
fn flip_vertical_bgra<'a>(src: &[u8], width: u32, height: u32, dst: &'a mut [u8]) -> &'a [u8] {
    let row_size = (width * 4) as usize;
    let total_size = row_size * height as usize;

    for (i, row) in src[..total_size].chunks_exact(row_size).enumerate() {
        let dest_row = height as usize - 1 - i;
        let dest_start = dest_row * row_size;
        dst[dest_start..dest_start + row_size].copy_from_slice(row);
    }

    &dst[..total_size]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resize_bgra() {
        // 2x2 source image (R, G, B, W pixels)
        let src = vec![
            255, 0, 0, 255,   // Red
            0, 255, 0, 255,   // Green
            0, 0, 255, 255,   // Blue
            255, 255, 255, 255, // White
        ];

        // Resize to 4x4 (should duplicate each pixel)
        let dst = resize_bgra(&src, 2, 2, 4, 4);
        assert_eq!(dst.len(), 64); // 4x4x4
    }

    #[test]
    fn test_flip_vertical() {
        // 2x2 image (4 pixels = 16 bytes)
        let src = vec![
            1, 2, 3, 4,   5, 6, 7, 8,     // Row 0 (2 pixels)
            9, 10, 11, 12, 13, 14, 15, 16, // Row 1 (2 pixels)
        ];
        let mut dst = vec![0u8; 16];

        flip_vertical_bgra(&src, 2, 2, &mut dst);

        // Row 1 should become Row 0
        assert_eq!(dst[0..8], [9, 10, 11, 12, 13, 14, 15, 16]);
        // Row 0 should become Row 1
        assert_eq!(dst[8..16], [1, 2, 3, 4, 5, 6, 7, 8]);
    }
}
