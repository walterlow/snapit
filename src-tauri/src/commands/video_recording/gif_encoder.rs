//! GIF encoding with gifski for high-quality output.
//!
//! This module provides frame buffering during recording and
//! high-quality GIF encoding using the gifski library.

#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use gifski::Settings as GifskiSettings;
use image::{ImageBuffer, Rgba};

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
    #[allow(dead_code)]
    fps: u32,
    /// Quality setting (1-100).
    quality: u32,
    /// Maximum number of frames to buffer.
    max_frames: usize,
}

impl GifRecorder {
    /// Create a new GIF recorder.
    pub fn new(width: u32, height: u32, fps: u32, quality: u32, max_frames: usize) -> Self {
        Self {
            frames: Vec::with_capacity(max_frames.min(1000)),
            width,
            height,
            fps,
            quality: quality.clamp(1, 100),
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
    
    /// Encode buffered frames to a GIF file.
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
        encode_frames_to_gif(
            &self.frames,
            output_path,
            self.quality,
            progress_callback,
        )
    }
}

/// Custom progress reporter that wraps a callback function.
struct ProgressCallback<F: Fn(f32) + Send + Sync> {
    callback: F,
    total_frames: usize,
    current: Arc<std::sync::atomic::AtomicUsize>,
}

impl<F: Fn(f32) + Send + Sync> gifski::progress::ProgressReporter for ProgressCallback<F> {
    fn increase(&mut self) -> bool {
        let current = self.current.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let progress = (current as f32 / self.total_frames as f32).min(1.0);
        (self.callback)(progress);
        true // Continue encoding
    }
    
    fn done(&mut self, _msg: &str) {
        (self.callback)(1.0);
    }
}

/// Encode frames to a GIF file using gifski.
pub fn encode_frames_to_gif<P, F>(
    frames: &[GifFrame],
    output_path: P,
    quality: u32,
    progress_callback: F,
) -> Result<u64, String>
where
    P: AsRef<Path>,
    F: Fn(f32) + Send + Sync + 'static,
{
    if frames.is_empty() {
        return Err("No frames to encode".to_string());
    }
    
    let output_path = output_path.as_ref();
    let total_frames = frames.len();
    
    // Create gifski settings
    // Quality: 1-100 maps to gifski's quality 1-100
    let settings = GifskiSettings {
        quality: quality as u8,
        fast: quality < 50, // Use fast mode for lower quality
        repeat: gifski::Repeat::Infinite,
        ..Default::default()
    };
    
    // Create the encoder
    let (collector, writer) = gifski::new(settings)
        .map_err(|e| format!("Failed to create GIF encoder: {}", e))?;
    
    // Spawn a thread to collect frames
    let frames_clone: Vec<GifFrame> = frames.to_vec();
    let collector_handle = std::thread::spawn(move || {
        for (index, frame) in frames_clone.iter().enumerate() {
            // Convert RGBA data to imgref format
            let pixels: Vec<rgb::RGBA8> = frame
                .rgba_data
                .chunks(4)
                .map(|chunk| rgb::RGBA8::new(chunk[0], chunk[1], chunk[2], chunk[3]))
                .collect();
            
            let img = imgref::Img::new(pixels, frame.width as usize, frame.height as usize);
            
            // Use the frame's timestamp for proper timing
            let presentation_timestamp = frame.timestamp;
            
            if let Err(e) = collector.add_frame_rgba(index, img, presentation_timestamp) {
                eprintln!("Error adding frame {}: {}", index, e);
            }
        }
        
        // Drop collector to signal no more frames
        drop(collector);
    });
    
    // Create output file
    let file = std::fs::File::create(output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    
    let mut buffered_writer = std::io::BufWriter::new(file);
    
    // Create progress reporter
    let mut progress_reporter = ProgressCallback {
        callback: progress_callback,
        total_frames,
        current: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };
    
    // Write the GIF with progress reporting
    let write_result = writer.write(&mut buffered_writer, &mut progress_reporter);
    
    // Wait for collector thread
    collector_handle
        .join()
        .map_err(|_| "Frame collector thread panicked".to_string())?;
    
    // Check write result
    write_result.map_err(|e| format!("Failed to write GIF: {}", e))?;
    
    // Get file size
    let file_size = std::fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(0);
    
    Ok(file_size)
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
        let recorder = GifRecorder::new(800, 600, 30, 80, 100);
        assert_eq!(recorder.frame_count(), 0);
        assert_eq!(recorder.duration(), 0.0);
    }
    
    #[test]
    fn test_add_frame() {
        let mut recorder = GifRecorder::new(2, 2, 30, 80, 100);
        
        // Create a simple 2x2 red frame
        let rgba = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];
        
        recorder.add_frame(rgba, 2, 2, 0.0);
        assert_eq!(recorder.frame_count(), 1);
    }
    
    #[test]
    fn test_max_frames_limit() {
        let mut recorder = GifRecorder::new(2, 2, 30, 80, 2);
        
        let rgba = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];
        
        recorder.add_frame(rgba.clone(), 2, 2, 0.0);
        recorder.add_frame(rgba.clone(), 2, 2, 0.033);
        recorder.add_frame(rgba.clone(), 2, 2, 0.066); // Should be ignored
        
        assert_eq!(recorder.frame_count(), 2);
    }
}
