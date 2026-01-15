//! Pipeline parallelism for video export.
//!
//! Provides async tasks for decoding and encoding that run concurrently
//! with the main render loop via bounded channels.

use std::io::Write;
use std::process::ChildStdin;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::rendering::stream_decoder::StreamDecoder;
use crate::rendering::types::DecodedFrame;

/// Buffer size for decode and encode channels.
/// 4 frames provides good overlap without excessive memory usage.
/// At 1080p RGBA (~8MB/frame), this uses ~32MB per channel.
pub const PIPELINE_BUFFER_SIZE: usize = 4;

/// Bundle of decoded frames for a single frame index.
pub struct DecodedFrameBundle {
    /// Frame index (0-indexed from start of export).
    pub frame_idx: u32,
    /// Decoded screen frame.
    pub screen_frame: DecodedFrame,
    /// Decoded webcam frame (if webcam enabled).
    pub webcam_frame: Option<DecodedFrame>,
}

/// Spawns a decode task that pre-fetches frames into a bounded channel.
///
/// The task reads frames from the screen and webcam decoders and sends
/// bundles to the returned receiver. Backpressure is automatic via the
/// bounded channel.
///
/// Returns the receiver and task handle for cleanup.
pub fn spawn_decode_task(
    mut screen_decoder: StreamDecoder,
    mut webcam_decoder: Option<StreamDecoder>,
    total_frames: u32,
) -> (
    mpsc::Receiver<DecodedFrameBundle>,
    JoinHandle<Result<(), String>>,
) {
    let (tx, rx) = mpsc::channel(PIPELINE_BUFFER_SIZE);

    let handle = tokio::spawn(async move {
        let mut frame_idx = 0u32;
        let mut last_webcam_frame: Option<DecodedFrame> = None;

        loop {
            // Read screen frame
            let screen_frame = match screen_decoder.next_frame().await {
                Ok(Some(frame)) => frame,
                Ok(None) => break, // End of stream
                Err(e) => {
                    log::error!("[PIPELINE] Decode error: {}", e);
                    return Err(e);
                },
            };

            // Read webcam frame (always consume to stay in sync)
            let webcam_frame = if let Some(ref mut decoder) = webcam_decoder {
                match decoder.next_frame().await {
                    Ok(Some(frame)) => {
                        last_webcam_frame = Some(frame.clone());
                        Some(frame)
                    },
                    _ => last_webcam_frame.clone(),
                }
            } else {
                None
            };

            // Send bundle to render loop
            let bundle = DecodedFrameBundle {
                frame_idx,
                screen_frame,
                webcam_frame,
            };

            if tx.send(bundle).await.is_err() {
                // Receiver dropped (render loop exited early)
                log::debug!("[PIPELINE] Decode channel closed");
                break;
            }

            frame_idx += 1;
            if frame_idx >= total_frames {
                break;
            }
        }

        log::debug!("[PIPELINE] Decode task complete: {} frames", frame_idx);
        Ok(())
    });

    (rx, handle)
}

/// Spawns an encode task that writes rendered frames to FFmpeg.
///
/// The task reads RGBA frames from the channel and writes them to FFmpeg's
/// stdin. Backpressure is automatic via the bounded channel.
///
/// Returns the sender and task handle for cleanup.
pub fn spawn_encode_task(
    mut stdin: ChildStdin,
) -> (mpsc::Sender<Vec<u8>>, JoinHandle<Result<(), String>>) {
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(PIPELINE_BUFFER_SIZE);

    let handle = tokio::spawn(async move {
        let mut frame_count = 0u32;

        while let Some(rgba_data) = rx.recv().await {
            // Write to FFmpeg (blocking but in async context)
            if let Err(e) = stdin.write_all(&rgba_data) {
                log::error!("[PIPELINE] Encode write error: {}", e);
                return Err(format!("FFmpeg write failed: {}", e));
            }
            frame_count += 1;
        }

        // Close stdin to signal EOF to FFmpeg
        drop(stdin);

        log::debug!("[PIPELINE] Encode task complete: {} frames", frame_count);
        Ok(())
    });

    (tx, handle)
}
