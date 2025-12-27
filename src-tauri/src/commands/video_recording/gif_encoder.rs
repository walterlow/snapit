//! GIF encoding with FFmpeg for fast, high-quality output.
//!
//! This module provides frame buffering during recording and
//! high-quality GIF encoding using FFmpeg.

#![allow(dead_code)]

use std::path::Path;

use image::{ImageBuffer, Rgba};

use super::ffmpeg_gif_encoder::{FfmpegGifEncoder, GifQualityPreset};

/// A single captured frame for GIF encoding.
#[derive(Clone)]
pub struct GifFrame {
    /// RGBA pixel data.
    pub rgba_data: Vec<u8>,
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
    /// Timestamp in seconds since recording start.
    pub timestamp: f64,
}

/// GIF recorder that buffers frames and encodes them.
pub struct GifRecorder {
    /// Buffered frames.
    frames: Vec<GifFrame>,
    /// Target width.
    #[allow(dead_code)]
    width: u32,
    /// Target height.
    #[allow(dead_code)]
    height: u32,
    /// Target FPS.
    fps: u32,
    /// Quality preset (Fast/Balanced/High).
    preset: GifQualityPreset,
    /// Maximum number of frames to buffer.
    max_frames: usize,
}

impl GifRecorder {
    /// Create a new GIF recorder.
    pub fn new(width: u32, height: u32, fps: u32, preset: GifQualityPreset, max_frames: usize) -> Self {
        Self {
            frames: Vec::with_capacity(max_frames.min(1000)),
            width,
            height,
            fps,
            preset,
            max_frames,
        }
    }
    
    /// Add a frame to the buffer.
    pub fn add_frame(&mut self, rgba_data: Vec<u8>, width: u32, height: u32, timestamp: f64) {
        if self.frames.len() >= self.max_frames {
            return;
        }
        
        self.frames.push(GifFrame {
            rgba_data,
            width,
            height,
            timestamp,
        });
    }
    
    /// Get the number of buffered frames.
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }
    
    /// Get the total duration of buffered frames.
    pub fn duration(&self) -> f64 {
        self.frames.last().map(|f| f.timestamp).unwrap_or(0.0)
    }
    
    /// Take ownership of the frames (for encoding in another thread).
    pub fn take_frames(&mut self) -> Vec<GifFrame> {
        std::mem::take(&mut self.frames)
    }
    
    /// Encode buffered frames to a GIF file using FFmpeg.
    ///
    /// Returns the file size in bytes.
    pub fn encode_to_file<P, F>(
        &self,
        output_path: P,
        progress_callback: F,
    ) -> Result<u64, String>
    where
        P: AsRef<Path>,
        F: Fn(f32) + Send + Sync + 'static,
    {
        if self.frames.is_empty() {
            return Err("No frames to encode".to_string());
        }

        // Get dimensions from first frame (they should all be the same)
        let first_frame = &self.frames[0];

        // Create FFmpeg encoder
        let encoder = FfmpegGifEncoder::new(
            first_frame.width,
            first_frame.height,
            self.fps as f64,
            self.preset,
        )?;

        // Encode with FFmpeg
        encoder.encode(&self.frames, output_path.as_ref(), progress_callback)
    }
}

/// Resize a frame to target dimensions using nearest neighbor (fast) or bilinear (quality).
pub fn resize_frame(
    rgba_data: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    high_quality: bool,
) -> Vec<u8> {
    if src_width == dst_width && src_height == dst_height {
        return rgba_data.to_vec();
    }
    
    let src_image: ImageBuffer<Rgba<u8>, _> =
        ImageBuffer::from_raw(src_width, src_height, rgba_data.to_vec())
            .expect("Failed to create image buffer");
    
    let filter = if high_quality {
        image::imageops::FilterType::Lanczos3
    } else {
        image::imageops::FilterType::Nearest
    };
    
    let resized = image::imageops::resize(&src_image, dst_width, dst_height, filter);
    
    resized.into_raw()
}

/// Crop a frame to a specific region.
pub fn crop_frame(
    rgba_data: &[u8],
    src_width: u32,
    src_height: u32,
    x: u32,
    y: u32,
    crop_width: u32,
    crop_height: u32,
) -> Vec<u8> {
    let src_image: ImageBuffer<Rgba<u8>, _> =
        ImageBuffer::from_raw(src_width, src_height, rgba_data.to_vec())
            .expect("Failed to create image buffer");
    
    let cropped = image::imageops::crop_imm(&src_image, x, y, crop_width, crop_height).to_image();
    
    cropped.into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gif_recorder_creation() {
        let recorder = GifRecorder::new(800, 600, 30, GifQualityPreset::Balanced, 100);
        assert_eq!(recorder.frame_count(), 0);
        assert_eq!(recorder.duration(), 0.0);
    }

    #[test]
    fn test_add_frame() {
        let mut recorder = GifRecorder::new(2, 2, 30, GifQualityPreset::Fast, 100);

        // Create a simple 2x2 red frame
        let rgba = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];

        recorder.add_frame(rgba, 2, 2, 0.0);
        assert_eq!(recorder.frame_count(), 1);
    }

    #[test]
    fn test_max_frames_limit() {
        let mut recorder = GifRecorder::new(2, 2, 30, GifQualityPreset::High, 2);

        let rgba = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];

        recorder.add_frame(rgba.clone(), 2, 2, 0.0);
        recorder.add_frame(rgba.clone(), 2, 2, 0.033);
        recorder.add_frame(rgba.clone(), 2, 2, 0.066); // Should be ignored

        assert_eq!(recorder.frame_count(), 2);
    }
}
