//! Async video decoder with frame caching.
//!
//! Uses ffmpeg-next for native video decoding without subprocess overhead.
//! Runs decoding in a background thread with LRU frame cache.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use tokio::sync::oneshot;

/// Size of the frame cache (about 2 seconds at 30fps).
pub const FRAME_CACHE_SIZE: usize = 60;

/// Decoded video frame ready for rendering.
#[derive(Clone)]
pub struct DecodedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub frame_number: u32,
    pub timestamp_ms: u64,
}

/// Message sent to decoder thread.
pub enum DecoderMessage {
    /// Request frame at time (seconds).
    GetFrame(f32, oneshot::Sender<DecodedFrame>),
    /// Shutdown the decoder.
    Shutdown,
}

/// Result of decoder initialization.
pub struct DecoderInitResult {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_ms: u64,
}

/// Handle to the async video decoder.
#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<DecoderMessage>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl AsyncVideoDecoderHandle {
    /// Request a frame at the given time (seconds).
    pub async fn get_frame(&self, time_secs: f32) -> Option<DecodedFrame> {
        let (tx, rx) = oneshot::channel();

        if self
            .sender
            .send(DecoderMessage::GetFrame(time_secs, tx))
            .is_err()
        {
            return None;
        }

        // Wait with timeout
        match tokio::time::timeout(Duration::from_millis(500), rx).await {
            Ok(Ok(frame)) => Some(frame),
            Ok(Err(_)) => None,
            Err(_) => {
                warn!("Frame decode request timed out");
                None
            },
        }
    }
}

impl Drop for AsyncVideoDecoderHandle {
    fn drop(&mut self) {
        let _ = self.sender.send(DecoderMessage::Shutdown);
    }
}

/// Spawn an async video decoder in a background thread.
pub fn spawn_decoder(path: PathBuf) -> Result<AsyncVideoDecoderHandle, String> {
    // Channel for decoder messages
    let (tx, rx) = mpsc::channel();

    // Channel to receive initialization result
    let (init_tx, init_rx) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        // Initialize ffmpeg
        ffmpeg_next::init().ok();

        // Open video file
        let mut ictx = match ffmpeg_next::format::input(&path) {
            Ok(ctx) => ctx,
            Err(e) => {
                let _ = init_tx.send(Err(format!("Failed to open video: {}", e)));
                return;
            },
        };

        // Find video stream
        let video_stream_index = match ictx.streams().best(ffmpeg_next::media::Type::Video) {
            Some(stream) => stream.index(),
            None => {
                let _ = init_tx.send(Err("No video stream found".to_string()));
                return;
            },
        };

        let stream = ictx.stream(video_stream_index).unwrap();
        let time_base = stream.time_base();
        let duration = stream.duration();
        let fps = stream.avg_frame_rate();
        let fps_f64 = fps.0 as f64 / fps.1.max(1) as f64;
        let fps_u32 = fps_f64.round() as u32;

        // Get decoder
        let decoder_params = stream.parameters();
        let decoder_ctx = ffmpeg_next::codec::Context::from_parameters(decoder_params)
            .map_err(|e| format!("Failed to create decoder context: {}", e));

        let mut decoder = match decoder_ctx {
            Ok(ctx) => match ctx.decoder().video() {
                Ok(d) => d,
                Err(e) => {
                    let _ = init_tx.send(Err(format!("Failed to open video decoder: {}", e)));
                    return;
                },
            },
            Err(e) => {
                let _ = init_tx.send(Err(e));
                return;
            },
        };

        let width = decoder.width();
        let height = decoder.height();

        // Calculate duration in ms
        let duration_ms = if duration > 0 {
            (duration as f64 * time_base.0 as f64 / time_base.1 as f64 * 1000.0) as u64
        } else {
            0
        };

        info!(
            "Video decoder initialized: {}x{} @ {:.2}fps, duration: {}ms",
            width, height, fps_f64, duration_ms
        );

        // Send init result
        let _ = init_tx.send(Ok(DecoderInitResult {
            width,
            height,
            fps: fps_f64,
            duration_ms,
        }));

        // Frame cache
        let mut cache: BTreeMap<u32, DecodedFrame> = BTreeMap::new();
        let mut last_decoded_frame: Option<u32> = None;

        // Scaler for converting to RGBA
        let mut scaler = ffmpeg_next::software::scaling::Context::get(
            decoder.format(),
            width,
            height,
            ffmpeg_next::format::Pixel::RGBA,
            width,
            height,
            ffmpeg_next::software::scaling::Flags::BILINEAR,
        )
        .ok();

        // Process messages
        while let Ok(msg) = rx.recv() {
            match msg {
                DecoderMessage::Shutdown => break,

                DecoderMessage::GetFrame(time_secs, sender) => {
                    if sender.is_closed() {
                        continue;
                    }

                    let requested_frame = (time_secs * fps_f64 as f32).floor() as u32;

                    // Check cache first
                    if let Some(cached) = cache.get(&requested_frame) {
                        let _ = sender.send(cached.clone());
                        continue;
                    }

                    // Determine if we need to seek
                    let needs_seek = last_decoded_frame
                        .map(|last| {
                            requested_frame < last
                                || requested_frame.saturating_sub(last) > FRAME_CACHE_SIZE as u32
                        })
                        .unwrap_or(true);

                    if needs_seek {
                        // Seek to requested position
                        let seek_ts = (time_secs as f64 * 1_000_000.0) as i64;
                        if let Err(e) = ictx.seek(seek_ts, ..seek_ts) {
                            warn!("Seek failed: {}", e);
                        }
                        cache.clear();
                        last_decoded_frame = None;
                        decoder.flush();
                    }

                    // Decode frames until we reach the requested one
                    let mut result_frame: Option<DecodedFrame> = None;
                    let decode_start = Instant::now();

                    'decode: for (stream, packet) in ictx.packets() {
                        if stream.index() != video_stream_index {
                            continue;
                        }

                        if let Err(e) = decoder.send_packet(&packet) {
                            warn!("Error sending packet: {}", e);
                            continue;
                        }

                        let mut decoded = ffmpeg_next::frame::Video::empty();
                        while decoder.receive_frame(&mut decoded).is_ok() {
                            let pts = decoded.pts().unwrap_or(0);
                            let frame_time_secs =
                                pts as f64 * time_base.0 as f64 / time_base.1 as f64;
                            let frame_num = (frame_time_secs * fps_f64).round() as u32;

                            // Convert to RGBA
                            let rgba_data = if let Some(ref mut scaler) = scaler {
                                let mut rgb_frame = ffmpeg_next::frame::Video::empty();
                                if scaler.run(&decoded, &mut rgb_frame).is_ok() {
                                    rgb_frame.data(0).to_vec()
                                } else {
                                    vec![0u8; (width * height * 4) as usize]
                                }
                            } else {
                                vec![0u8; (width * height * 4) as usize]
                            };

                            let frame = DecodedFrame {
                                data: rgba_data,
                                width,
                                height,
                                frame_number: frame_num,
                                timestamp_ms: (frame_time_secs * 1000.0) as u64,
                            };

                            // Cache the frame
                            if cache.len() >= FRAME_CACHE_SIZE {
                                // Remove oldest frame
                                if let Some(&oldest) = cache.keys().next() {
                                    cache.remove(&oldest);
                                }
                            }
                            cache.insert(frame_num, frame.clone());
                            last_decoded_frame = Some(frame_num);

                            // Check if this is the frame we want
                            if frame_num >= requested_frame {
                                result_frame = Some(frame);
                                break 'decode;
                            }

                            // Keep the last frame in case we overshoot
                            result_frame = Some(frame);

                            // Timeout protection
                            if decode_start.elapsed() > Duration::from_millis(200) {
                                debug!("Decode timeout, returning best frame");
                                break 'decode;
                            }
                        }
                    }

                    // Send result
                    if let Some(frame) = result_frame {
                        let _ = sender.send(frame);
                    } else if let Some(cached) = cache.values().last() {
                        let _ = sender.send(cached.clone());
                    } else {
                        // Return black frame
                        let _ = sender.send(DecodedFrame {
                            data: vec![0u8; (width * height * 4) as usize],
                            width,
                            height,
                            frame_number: requested_frame,
                            timestamp_ms: (time_secs * 1000.0) as u64,
                        });
                    }
                },
            }
        }

        info!("Video decoder thread shutting down");
    });

    // Wait for initialization
    match init_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(init)) => Ok(AsyncVideoDecoderHandle {
            sender: tx,
            width: init.width,
            height: init.height,
            fps: (init.fps.round() as u32).max(1),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Decoder initialization timed out".to_string()),
    }
}
