//! Native camera frame with Media Foundation buffer.
//!
//! This provides direct access to the camera frame data without intermediate copies,
//! enabling efficient GPU upload for hardware encoding.

use snapit_camera_windows::{Frame, PixelFormat};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A native camera frame with reference-counted buffer access.
///
/// Unlike the old SharedFrame which held decoded BGRA data, this keeps the
/// native Media Foundation buffer for zero-copy GPU upload.
#[derive(Clone)]
pub struct NativeCameraFrame {
    /// The raw frame data from Media Foundation.
    pub frame: Arc<FrameData>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Pixel format of the frame data.
    pub pixel_format: PixelFormat,
    /// Whether the image is stored bottom-up in memory.
    pub is_bottom_up: bool,
    /// Camera timestamp (from hardware).
    pub camera_timestamp: Duration,
    /// Performance counter value at capture time.
    pub perf_counter: i64,
    /// Wall-clock time when frame was received.
    pub captured_at: Instant,
    /// Monotonic frame ID for change detection.
    pub frame_id: u64,
}

/// Frame data holder - allows sharing frame bytes between consumers.
pub struct FrameData {
    /// Raw frame bytes (copied from MF buffer for sharing).
    pub bytes: Vec<u8>,
}

impl NativeCameraFrame {
    /// Create a new NativeCameraFrame from a camera-windows Frame.
    pub fn from_frame(frame: &Frame, frame_id: u64) -> Option<Self> {
        // Lock and copy the frame bytes
        let bytes = frame.bytes().ok()?;
        let frame_data = FrameData {
            bytes: bytes.to_vec(),
        };

        Some(Self {
            frame: Arc::new(frame_data),
            width: frame.width as u32,
            height: frame.height as u32,
            pixel_format: frame.pixel_format,
            is_bottom_up: frame.is_bottom_up,
            camera_timestamp: frame.timestamp,
            perf_counter: frame.perf_counter,
            captured_at: Instant::now(),
            frame_id,
        })
    }

    /// Create a NativeCameraFrame from MJPEG data (nokhwa).
    pub fn from_mjpeg(data: &[u8], width: u32, height: u32, frame_id: u64) -> Option<Self> {
        if data.len() < 2 {
            return None;
        }
        let frame_data = FrameData {
            bytes: data.to_vec(),
        };
        Some(Self {
            frame: Arc::new(frame_data),
            width,
            height,
            pixel_format: PixelFormat::MJPEG,
            is_bottom_up: false,
            camera_timestamp: Duration::ZERO,
            perf_counter: 0,
            captured_at: Instant::now(),
            frame_id,
        })
    }

    /// Create a NativeCameraFrame from decoded RGB data (nokhwa decode_image result).
    /// This is the preferred method when using nokhwa's built-in decoding.
    pub fn from_decoded_rgb(data: &[u8], width: u32, height: u32, frame_id: u64) -> Option<Self> {
        let expected_size = (width * height * 3) as usize;
        if data.len() != expected_size {
            log::warn!(
                "[NATIVE_FRAME] RGB size mismatch: got {} bytes, expected {} for {}x{}",
                data.len(),
                expected_size,
                width,
                height
            );
            return None;
        }

        let frame_data = FrameData {
            bytes: data.to_vec(),
        };

        Some(Self {
            frame: Arc::new(frame_data),
            width,
            height,
            pixel_format: PixelFormat::RGB24,
            is_bottom_up: false,
            camera_timestamp: Duration::ZERO,
            perf_counter: 0,
            captured_at: Instant::now(),
            frame_id,
        })
    }

    /// Create a NativeCameraFrame from RGB or YUYV data (nokhwa).
    /// Detects format based on data length vs expected pixel count.
    pub fn from_rgb_or_yuyv(
        data: &[u8],
        width: u32,
        height: u32,
        pixel_count: usize,
        frame_id: u64,
    ) -> Option<Self> {
        let len = data.len();

        // Detect format based on bytes per pixel
        let (pixel_format, is_valid) = if len == pixel_count * 3 {
            // RGB24: 3 bytes per pixel
            (PixelFormat::RGB24, true)
        } else if len == pixel_count * 4 {
            // RGBA/BGRA: 4 bytes per pixel
            (PixelFormat::RGB32, true)
        } else if len == pixel_count * 2 {
            // YUYV: 2 bytes per pixel (4:2:2)
            (PixelFormat::YUYV422, true)
        } else if len >= pixel_count + pixel_count / 2 {
            // NV12: Y plane + UV plane (1.5 bytes per pixel)
            (PixelFormat::NV12, true)
        } else {
            log::warn!(
                "[NATIVE_FRAME] Unknown format: {} bytes for {}x{} ({} pixels)",
                len,
                width,
                height,
                pixel_count
            );
            (PixelFormat::RGB24, false)
        };

        if !is_valid {
            return None;
        }

        let frame_data = FrameData {
            bytes: data.to_vec(),
        };

        Some(Self {
            frame: Arc::new(frame_data),
            width,
            height,
            pixel_format,
            is_bottom_up: false,
            camera_timestamp: Duration::ZERO,
            perf_counter: 0,
            captured_at: Instant::now(),
            frame_id,
        })
    }

    /// Get a reference to the frame bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.frame.bytes
    }

    /// Check if this is MJPEG compressed data.
    pub fn is_mjpeg(&self) -> bool {
        self.pixel_format == PixelFormat::MJPEG
    }

    /// Check if this is NV12 format (preferred for hardware encoding).
    pub fn is_nv12(&self) -> bool {
        self.pixel_format == PixelFormat::NV12
    }

    /// Check if this is a YUV format suitable for hardware encoding.
    pub fn is_hardware_friendly(&self) -> bool {
        matches!(
            self.pixel_format,
            PixelFormat::NV12 | PixelFormat::YUYV422 | PixelFormat::UYVY422 | PixelFormat::YUV420P
        )
    }

    /// Convert to BGRA if needed for software encoding or preview.
    /// Returns None if conversion fails.
    pub fn to_bgra(&self) -> Option<Vec<u8>> {
        let bytes = self.bytes();
        let pixel_count = (self.width * self.height) as usize;

        match self.pixel_format {
            PixelFormat::MJPEG => {
                // Decode JPEG to RGB, then convert to BGRA
                let img =
                    image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
                let rgb = img.to_rgb8();

                // Verify dimensions match (JPEG dimensions from header vs frame metadata)
                let decoded_width = rgb.width() as usize;
                let decoded_height = rgb.height() as usize;
                let decoded_pixels = decoded_width * decoded_height;

                if decoded_width != self.width as usize || decoded_height != self.height as usize {
                    log::warn!(
                        "[NATIVE_FRAME] MJPEG dimension mismatch: decoded {}x{}, metadata {}x{}",
                        decoded_width,
                        decoded_height,
                        self.width,
                        self.height
                    );
                }

                // Use actual decoded pixel count for output
                let mut bgra = Vec::with_capacity(decoded_pixels * 4);
                for pixel in rgb.pixels() {
                    bgra.push(pixel[2]); // B
                    bgra.push(pixel[1]); // G
                    bgra.push(pixel[0]); // R
                    bgra.push(255); // A
                }
                Some(bgra)
            },
            PixelFormat::NV12 => {
                // NV12: Y plane followed by interleaved UV plane
                let y_size = pixel_count;
                let uv_size = pixel_count / 2;
                if bytes.len() < y_size + uv_size {
                    return None;
                }
                let y_plane = &bytes[..y_size];
                let uv_plane = &bytes[y_size..y_size + uv_size];

                let mut bgra = Vec::with_capacity(pixel_count * 4);
                for y_idx in 0..self.height {
                    for x_idx in 0..self.width {
                        let y = y_plane[(y_idx * self.width + x_idx) as usize] as f32;
                        let uv_idx = ((y_idx / 2) * self.width + (x_idx / 2 * 2)) as usize;
                        let u = uv_plane[uv_idx] as f32 - 128.0;
                        let v = uv_plane[uv_idx + 1] as f32 - 128.0;

                        let r = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
                        let g = (y - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                        let b = (y + 1.772 * u).clamp(0.0, 255.0) as u8;

                        bgra.push(b);
                        bgra.push(g);
                        bgra.push(r);
                        bgra.push(255);
                    }
                }
                Some(bgra)
            },
            PixelFormat::YUYV422 => {
                // YUYV: packed YUV 4:2:2
                let expected = pixel_count * 2;
                if bytes.len() < expected {
                    return None;
                }
                let mut bgra = Vec::with_capacity(pixel_count * 4);
                for chunk in bytes[..expected].chunks_exact(4) {
                    let y0 = chunk[0] as f32;
                    let u = chunk[1] as f32 - 128.0;
                    let y1 = chunk[2] as f32;
                    let v = chunk[3] as f32 - 128.0;

                    let r0 = (y0 + 1.402 * v).clamp(0.0, 255.0) as u8;
                    let g0 = (y0 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                    let b0 = (y0 + 1.772 * u).clamp(0.0, 255.0) as u8;

                    let r1 = (y1 + 1.402 * v).clamp(0.0, 255.0) as u8;
                    let g1 = (y1 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                    let b1 = (y1 + 1.772 * u).clamp(0.0, 255.0) as u8;

                    bgra.extend_from_slice(&[b0, g0, r0, 255, b1, g1, r1, 255]);
                }
                Some(bgra)
            },
            PixelFormat::RGB24 => {
                let expected = pixel_count * 3;
                if bytes.len() < expected {
                    return None;
                }
                let mut bgra = Vec::with_capacity(pixel_count * 4);
                for pixel in bytes[..expected].chunks_exact(3) {
                    bgra.push(pixel[2]); // B
                    bgra.push(pixel[1]); // G
                    bgra.push(pixel[0]); // R
                    bgra.push(255); // A
                }
                Some(bgra)
            },
            PixelFormat::RGB32 | PixelFormat::ARGB => {
                let expected = pixel_count * 4;
                if bytes.len() < expected {
                    return None;
                }
                // Assume BGRA layout, just clone
                Some(bytes[..expected].to_vec())
            },
            _ => {
                log::warn!(
                    "Unsupported pixel format for BGRA conversion: {:?}",
                    self.pixel_format
                );
                None
            },
        }
    }

    /// Encode frame to JPEG for preview.
    pub fn to_jpeg(&self, quality: u8) -> Option<Vec<u8>> {
        // If already MJPEG, return as-is (or re-encode at different quality)
        if self.is_mjpeg() {
            return Some(self.bytes().to_vec());
        }

        // Convert to BGRA first, then encode
        let bgra = self.to_bgra()?;
        encode_bgra_to_jpeg(&bgra, self.width, self.height, quality)
    }
}

/// Encode BGRA to JPEG bytes.
fn encode_bgra_to_jpeg(bgra: &[u8], width: u32, height: u32, quality: u8) -> Option<Vec<u8>> {
    use image::{ImageBuffer, Rgb};

    // Convert BGRA to RGB
    let mut rgb_data = Vec::with_capacity((width * height * 3) as usize);
    for pixel in bgra.chunks_exact(4) {
        rgb_data.push(pixel[2]); // R
        rgb_data.push(pixel[1]); // G
        rgb_data.push(pixel[0]); // B
    }

    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgb_data)?;

    let mut jpeg_buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, quality);
    encoder.encode_image(&img).ok()?;

    Some(jpeg_buffer)
}
