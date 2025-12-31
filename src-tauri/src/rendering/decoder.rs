//! Async video decoder using ffmpeg-next.
//!
//! Provides frame-accurate seeking and prefetching for smooth playback.

use std::path::Path;
use std::sync::Arc;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::types::DecodedFrame;

/// Number of frames to prefetch ahead of playback position.
const PREFETCH_COUNT: usize = 5;

/// Video decoder with async frame extraction.
pub struct VideoDecoder {
    /// Path to video file.
    path: String,
    /// Video dimensions.
    width: u32,
    height: u32,
    /// Frame rate.
    fps: f64,
    /// Duration in milliseconds.
    duration_ms: u64,
    /// Total frame count.
    frame_count: u32,
    /// Frame cache for prefetched frames.
    frame_cache: Arc<Mutex<FrameCache>>,
    /// Background decoder task handle.
    decoder_task: Option<tokio::task::JoinHandle<()>>,
    /// Channel to request frame decoding.
    decode_tx: Option<mpsc::Sender<DecodeRequest>>,
}

struct FrameCache {
    frames: Vec<Option<DecodedFrame>>,
    base_frame: u32,
    capacity: usize,
}

impl FrameCache {
    fn new(capacity: usize) -> Self {
        Self {
            frames: vec![None; capacity],
            base_frame: 0,
            capacity,
        }
    }

    fn get(&self, frame: u32) -> Option<&DecodedFrame> {
        if frame < self.base_frame {
            return None;
        }
        let idx = (frame - self.base_frame) as usize;
        if idx >= self.capacity {
            return None;
        }
        self.frames[idx].as_ref()
    }

    fn insert(&mut self, frame: u32, decoded: DecodedFrame) {
        if frame < self.base_frame {
            return;
        }
        let idx = (frame - self.base_frame) as usize;
        if idx >= self.capacity {
            // Need to shift window forward
            let shift = idx - self.capacity + 1;
            
            if shift >= self.capacity {
                // Frame is too far ahead - clear cache and reset base
                for slot in &mut self.frames {
                    *slot = None;
                }
                self.base_frame = frame;
                self.frames[0] = Some(decoded);
            } else {
                // Shift window forward
                self.base_frame += shift as u32;
                for i in 0..self.capacity - shift {
                    self.frames[i] = self.frames[i + shift].take();
                }
                for i in self.capacity - shift..self.capacity {
                    self.frames[i] = None;
                }
                let new_idx = (frame - self.base_frame) as usize;
                if new_idx < self.capacity {
                    self.frames[new_idx] = Some(decoded);
                }
            }
        } else {
            self.frames[idx] = Some(decoded);
        }
    }

    fn clear(&mut self) {
        for slot in &mut self.frames {
            *slot = None;
        }
        self.base_frame = 0;
    }
}

enum DecodeRequest {
    Seek(u32),
    Prefetch(u32),
    Stop,
}

impl VideoDecoder {
    /// Create a new decoder for the given video file.
    pub fn new(path: &Path) -> Result<Self, String> {
        // Get video metadata using ffprobe
        let metadata = get_video_metadata(path)?;
        
        Ok(Self {
            path: path.to_string_lossy().to_string(),
            width: metadata.width,
            height: metadata.height,
            fps: metadata.fps,
            duration_ms: metadata.duration_ms,
            frame_count: metadata.frame_count,
            frame_cache: Arc::new(Mutex::new(FrameCache::new(PREFETCH_COUNT * 2))),
            decoder_task: None,
            decode_tx: None,
        })
    }

    /// Start the background decoder task.
    pub fn start(&mut self) -> Result<(), String> {
        let (tx, rx) = mpsc::channel(32);
        self.decode_tx = Some(tx);

        let path = self.path.clone();
        let width = self.width;
        let height = self.height;
        let fps = self.fps;
        let cache = Arc::clone(&self.frame_cache);

        let handle = tokio::spawn(async move {
            decoder_task(path, width, height, fps, cache, rx).await;
        });

        self.decoder_task = Some(handle);
        Ok(())
    }

    /// Stop the background decoder.
    pub async fn stop(&mut self) {
        if let Some(tx) = self.decode_tx.take() {
            let _ = tx.send(DecodeRequest::Stop).await;
        }
        if let Some(handle) = self.decoder_task.take() {
            let _ = handle.await;
        }
    }

    /// Get video width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Get video height.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Get video FPS.
    pub fn fps(&self) -> f64 {
        self.fps
    }

    /// Get duration in milliseconds.
    pub fn duration_ms(&self) -> u64 {
        self.duration_ms
    }

    /// Get total frame count.
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Seek to a specific frame and get it.
    pub async fn seek(&self, frame: u32) -> Result<DecodedFrame, String> {
        // Check cache first
        {
            let cache = self.frame_cache.lock();
            if let Some(decoded) = cache.get(frame) {
                log::debug!("[DECODER] Frame {} found in cache", frame);
                return Ok(decoded.clone());
            }
        }

        log::debug!("[DECODER] Frame {} not in cache, requesting decode", frame);

        // Request decode
        if let Some(tx) = &self.decode_tx {
            tx.send(DecodeRequest::Seek(frame))
                .await
                .map_err(|e| format!("Failed to send decode request: {}", e))?;
        } else {
            return Err("Decoder not started".to_string());
        }

        // Wait for frame to be decoded (with timeout - 5 seconds for slow FFmpeg startup)
        for i in 0..250 {
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
            let cache = self.frame_cache.lock();
            if let Some(decoded) = cache.get(frame) {
                log::debug!("[DECODER] Frame {} decoded after {}ms", frame, i * 20);
                return Ok(decoded.clone());
            }
        }

        Err(format!("Timeout waiting for frame {} (5s)", frame))
    }

    /// Get a frame if it's in the cache.
    pub fn get_cached_frame(&self, frame: u32) -> Option<DecodedFrame> {
        let cache = self.frame_cache.lock();
        cache.get(frame).cloned()
    }

    /// Request prefetching from the given frame.
    pub async fn prefetch(&self, from_frame: u32) {
        if let Some(tx) = &self.decode_tx {
            let _ = tx.send(DecodeRequest::Prefetch(from_frame)).await;
        }
    }

    /// Convert timestamp to frame number.
    pub fn timestamp_to_frame(&self, timestamp_ms: u64) -> u32 {
        ((timestamp_ms as f64 / 1000.0) * self.fps).floor() as u32
    }

    /// Convert frame number to timestamp.
    pub fn frame_to_timestamp(&self, frame: u32) -> u64 {
        ((frame as f64 / self.fps) * 1000.0) as u64
    }
}

/// Background decoder task.
async fn decoder_task(
    path: String,
    width: u32,
    height: u32,
    fps: f64,
    cache: Arc<Mutex<FrameCache>>,
    mut rx: mpsc::Receiver<DecodeRequest>,
) {
    log::info!("[DECODER] Decoder task started for path: {}", path);
    
    while let Some(request) = rx.recv().await {
        match request {
            DecodeRequest::Stop => {
                log::info!("[DECODER] Decoder task stopping");
                break;
            }
            DecodeRequest::Seek(frame) => {
                log::debug!("[DECODER] Seek request for frame {}", frame);
                // Decode the requested frame using spawn_blocking to avoid blocking tokio runtime
                let path_clone = path.clone();
                let cache_clone = Arc::clone(&cache);
                let result = tokio::task::spawn_blocking(move || {
                    let path = Path::new(&path_clone);
                    match decode_frame_ffmpeg(path, frame, width, height, fps) {
                        Ok(decoded) => {
                            let mut c = cache_clone.lock();
                            c.insert(frame, decoded);
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }).await;
                
                if let Err(e) = result {
                    log::error!("[DECODER] spawn_blocking failed for frame {}: {:?}", frame, e);
                } else if let Ok(Err(e)) = result {
                    log::error!("[DECODER] FFmpeg decode failed for frame {}: {}", frame, e);
                }
            }
            DecodeRequest::Prefetch(from_frame) => {
                log::debug!("[DECODER] Prefetch request from frame {}", from_frame);
                // Decode multiple frames ahead
                let path_clone = path.clone();
                let cache_clone = Arc::clone(&cache);
                let _ = tokio::task::spawn_blocking(move || {
                    let path = Path::new(&path_clone);
                    for i in 0..PREFETCH_COUNT {
                        let frame = from_frame + i as u32;
                        
                        // Skip if already cached
                        {
                            let c = cache_clone.lock();
                            if c.get(frame).is_some() {
                                continue;
                            }
                        }
                        
                        match decode_frame_ffmpeg(path, frame, width, height, fps) {
                            Ok(decoded) => {
                                let mut c = cache_clone.lock();
                                c.insert(frame, decoded);
                            }
                            Err(e) => {
                                log::warn!("[DECODER] Prefetch failed for frame {}: {}", frame, e);
                            }
                        }
                    }
                }).await;
            }
        }
    }
    
    log::info!("[DECODER] Decoder task ended");
}

/// Decode a single frame using FFmpeg CLI.
/// 
/// This is a fallback approach. For better performance, we should use
/// ffmpeg-next bindings directly, but this works for initial implementation.
fn decode_frame_ffmpeg(
    path: &Path,
    frame: u32,
    width: u32,
    height: u32,
    fps: f64,
) -> Result<DecodedFrame, String> {
    let timestamp_ms = ((frame as f64 / fps) * 1000.0) as u64;
    let timestamp_secs = timestamp_ms as f64 / 1000.0;
    
    log::debug!(
        "[DECODER] Decoding frame {} at {:.3}s from {:?}",
        frame,
        timestamp_secs,
        path
    );
    
    // Find FFmpeg
    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or_else(|| "FFmpeg not found".to_string())?;
    
    // Use FFmpeg to extract frame as raw RGBA with explicit scaling to target dimensions
    let output = std::process::Command::new(&ffmpeg_path)
        .args([
            "-ss", &format!("{:.3}", timestamp_secs),
            "-i", &path.to_string_lossy(),
            "-frames:v", "1",
            "-vf", &format!("scale={}:{}", width, height),
            "-f", "rawvideo",
            "-pix_fmt", "rgba",
            "-",
        ])
        .output()
        .map_err(|e| format!("FFmpeg failed to execute: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("[DECODER] FFmpeg error for frame {}: {}", frame, stderr);
        return Err(format!("FFmpeg error: {}", stderr));
    }
    
    let expected_size = (width * height * 4) as usize;
    if output.stdout.len() != expected_size {
        log::error!(
            "[DECODER] Frame {} size mismatch: expected {} bytes ({}x{}x4), got {}",
            frame,
            expected_size,
            width,
            height,
            output.stdout.len()
        );
        return Err(format!(
            "Frame size mismatch: expected {} bytes, got {}",
            expected_size,
            output.stdout.len()
        ));
    }
    
    log::debug!("[DECODER] Frame {} decoded successfully ({} bytes)", frame, output.stdout.len());
    
    Ok(DecodedFrame {
        frame_number: frame,
        timestamp_ms,
        data: output.stdout,
        width,
        height,
    })
}

/// Video metadata from ffprobe.
struct VideoMetadata {
    width: u32,
    height: u32,
    fps: f64,
    duration_ms: u64,
    frame_count: u32,
}

/// Get video metadata using ffprobe.
fn get_video_metadata(path: &Path) -> Result<VideoMetadata, String> {
    use crate::commands::video_recording::video_project::VideoMetadata as ProjectMetadata;
    
    let meta = ProjectMetadata::from_file(path)?;
    let fps = meta.fps as f64;
    let frame_count = ((meta.duration_ms as f64 / 1000.0) * fps).ceil() as u32;
    
    Ok(VideoMetadata {
        width: meta.width,
        height: meta.height,
        fps,
        duration_ms: meta.duration_ms,
        frame_count,
    })
}
