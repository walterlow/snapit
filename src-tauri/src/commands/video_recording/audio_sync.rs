//! Audio synchronization and mixing.
//!
//! Coordinates audio from multiple sources (system audio + microphone)
//! and provides synchronized frames to the video encoder.
//!
//! NOTE: Many methods are currently unused because VideoEncoder handles audio
//! internally. This code is kept for Phase 3 (microphone support) and potential
//! future FFmpeg migration.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐     ┌──────────────────┐
//! │ WASAPI Loopback │────▶│                  │
//! │ (system audio)  │     │  AudioCollector  │────▶ Mixed AudioFrame
//! └─────────────────┘     │                  │
//!                         │                  │
//! ┌─────────────────┐     │                  │
//! │ cpal Microphone │────▶│                  │
//! │ (mic input)     │     │                  │
//! └─────────────────┘     └──────────────────┘
//! ```

#![allow(dead_code)]

use super::audio_wasapi::AudioFrame;
use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

/// Channel buffer size in frames (~2 seconds at 100 frames/sec)
const AUDIO_CHANNEL_SIZE: usize = 200;

/// Audio collector that gathers and mixes audio from multiple sources.
pub struct AudioCollector {
    /// Receiver for system audio frames
    system_rx: Option<Receiver<AudioFrame>>,
    /// Receiver for microphone frames
    mic_rx: Option<Receiver<AudioFrame>>,
    /// Sample rate for output
    sample_rate: u32,
    /// Number of channels (typically 2 for stereo)
    channels: u16,
    /// Buffer for accumulating audio samples
    buffer: Vec<f32>,
    /// Timestamp of the buffer start
    buffer_timestamp: Option<i64>,
}

impl AudioCollector {
    /// Create a new audio collector with no sources.
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            system_rx: None,
            mic_rx: None,
            sample_rate,
            channels,
            buffer: Vec::with_capacity(sample_rate as usize * channels as usize / 10), // 100ms
            buffer_timestamp: None,
        }
    }

    /// Set the system audio receiver.
    pub fn set_system_audio(&mut self, rx: Receiver<AudioFrame>) {
        self.system_rx = Some(rx);
    }

    /// Set the microphone audio receiver.
    pub fn set_microphone(&mut self, rx: Receiver<AudioFrame>) {
        self.mic_rx = Some(rx);
    }

    /// Get the sample rate.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Get the number of channels.
    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// Collect all available audio frames and return mixed result.
    ///
    /// Returns `None` if no audio is available from any source.
    pub fn collect(&mut self) -> Option<AudioFrame> {
        let mut system_frames = Vec::new();
        let mut mic_frames = Vec::new();

        // Drain all available system audio frames
        if let Some(ref rx) = self.system_rx {
            loop {
                match rx.try_recv() {
                    Ok(frame) => system_frames.push(frame),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        self.system_rx = None;
                        break;
                    }
                }
            }
        }

        // Drain all available microphone frames
        if let Some(ref rx) = self.mic_rx {
            loop {
                match rx.try_recv() {
                    Ok(frame) => mic_frames.push(frame),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        self.mic_rx = None;
                        break;
                    }
                }
            }
        }

        // If no audio from either source, return None
        if system_frames.is_empty() && mic_frames.is_empty() {
            return None;
        }

        // Merge all frames from each source
        let system_merged = Self::merge_frames(&system_frames);
        let mic_merged = Self::merge_frames(&mic_frames);

        // Mix the two sources together
        match (system_merged, mic_merged) {
            (Some(sys), Some(mic)) => Some(Self::mix_frames(&sys, &mic)),
            (Some(sys), None) => Some(sys),
            (None, Some(mic)) => Some(mic),
            (None, None) => None,
        }
    }

    /// Try to get the next audio frame.
    ///
    /// Returns frames one at a time with original timestamps to avoid jitter.
    /// When both system and mic audio are active, alternates between them.
    pub fn try_get_audio(&mut self) -> Option<AudioFrame> {
        // Try system audio first
        if let Some(ref rx) = self.system_rx {
            match rx.try_recv() {
                Ok(mut frame) => {
                    // If mic is also available, try to mix
                    if let Some(ref mic_rx) = self.mic_rx {
                        if let Ok(mic_frame) = mic_rx.try_recv() {
                            return Some(Self::mix_frames(&frame, &mic_frame));
                        }
                    }
                    return Some(frame);
                }
                Err(TryRecvError::Disconnected) => {
                    self.system_rx = None;
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        // Fall back to mic only
        if let Some(ref rx) = self.mic_rx {
            match rx.try_recv() {
                Ok(frame) => return Some(frame),
                Err(TryRecvError::Disconnected) => {
                    self.mic_rx = None;
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        None
    }

    /// Merge multiple frames from the same source into one.
    fn merge_frames(frames: &[AudioFrame]) -> Option<AudioFrame> {
        if frames.is_empty() {
            return None;
        }

        if frames.len() == 1 {
            return Some(frames[0].clone());
        }

        // Concatenate all samples, use timestamp from first frame
        let total_samples: usize = frames.iter().map(|f| f.samples.len()).sum();
        let mut merged_samples = Vec::with_capacity(total_samples);
        let mut total_frame_count = 0;

        for frame in frames {
            merged_samples.extend_from_slice(&frame.samples);
            total_frame_count += frame.frame_count;
        }

        Some(AudioFrame {
            samples: merged_samples,
            timestamp_100ns: frames[0].timestamp_100ns,
            frame_count: total_frame_count,
        })
    }

    /// Mix two audio frames together (system + mic).
    ///
    /// Uses simple additive mixing with headroom to prevent clipping.
    fn mix_frames(a: &AudioFrame, b: &AudioFrame) -> AudioFrame {
        let max_len = a.samples.len().max(b.samples.len());
        let mut mixed = Vec::with_capacity(max_len);

        for i in 0..max_len {
            let sample_a = a.samples.get(i).copied().unwrap_or(0.0);
            let sample_b = b.samples.get(i).copied().unwrap_or(0.0);

            // Mix with headroom (0.7 factor prevents clipping when both are loud)
            let mixed_sample = (sample_a + sample_b) * 0.7;

            // Hard clamp to prevent any possibility of overflow
            mixed.push(mixed_sample.clamp(-1.0, 1.0));
        }

        AudioFrame {
            samples: mixed,
            timestamp_100ns: a.timestamp_100ns.min(b.timestamp_100ns),
            frame_count: a.frame_count.max(b.frame_count),
        }
    }
}

/// Audio capture manager that spawns and manages audio capture threads.
pub struct AudioCaptureManager {
    /// Handle to system audio capture thread
    system_handle: Option<JoinHandle<Result<(), String>>>,
    /// Handle to microphone capture thread
    mic_handle: Option<JoinHandle<Result<(), String>>>,
    /// Stop signal for all threads
    should_stop: Arc<AtomicBool>,
    /// Pause signal for all threads
    is_paused: Arc<AtomicBool>,
    /// Audio collector for the video encoder to use
    collector: AudioCollector,
}

impl AudioCaptureManager {
    /// Create a new audio capture manager.
    pub fn new(should_stop: Arc<AtomicBool>, is_paused: Arc<AtomicBool>) -> Self {
        Self {
            system_handle: None,
            mic_handle: None,
            should_stop,
            is_paused,
            collector: AudioCollector::new(48000, 2),
        }
    }

    /// Start capturing system audio (WASAPI loopback).
    pub fn start_system_audio(&mut self, start_time: Instant) -> Result<(), String> {
        use super::audio_wasapi::WasapiLoopback;

        let (tx, rx) = bounded::<AudioFrame>(AUDIO_CHANNEL_SIZE);
        self.collector.set_system_audio(rx);

        let should_stop = Arc::clone(&self.should_stop);
        let is_paused = Arc::clone(&self.is_paused);

        let handle = std::thread::Builder::new()
            .name("audio-wasapi".to_string())
            .spawn(move || {
                let loopback = WasapiLoopback::new()?;
                loopback.capture_loop(tx, start_time, should_stop, is_paused)
            })
            .map_err(|e| format!("Failed to spawn WASAPI thread: {}", e))?;

        self.system_handle = Some(handle);
        log::info!("System audio capture started");
        Ok(())
    }

    /// Start capturing microphone audio using cpal.
    ///
    /// # Arguments
    /// * `device_index` - Index of the audio input device to use
    /// * `start_time` - Recording start time for timestamp calculation
    pub fn start_microphone(
        &mut self,
        device_index: usize,
        start_time: Instant,
    ) -> Result<(), String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let (tx, rx) = bounded::<AudioFrame>(AUDIO_CHANNEL_SIZE);
        self.collector.set_microphone(rx);

        let should_stop = Arc::clone(&self.should_stop);
        let is_paused = Arc::clone(&self.is_paused);

        let handle = std::thread::Builder::new()
            .name("audio-microphone".to_string())
            .spawn(move || -> Result<(), String> {
                // Get the device by index
                let host = cpal::default_host();
                let device = host
                    .input_devices()
                    .map_err(|e| format!("Failed to enumerate audio devices: {}", e))?
                    .nth(device_index)
                    .ok_or_else(|| format!("Audio input device {} not found", device_index))?;

                log::info!(
                    "Using microphone [{}]: {}",
                    device_index,
                    device.name().unwrap_or_default()
                );

                // Get supported config
                let config = device
                    .default_input_config()
                    .map_err(|e| format!("Failed to get input config: {}", e))?;

                let sample_rate = config.sample_rate();
                let channels = config.channels() as usize;

                log::info!(
                    "Microphone config: {} Hz, {} channels, {:?}",
                    sample_rate,
                    channels,
                    config.sample_format()
                );

                // Target format: 48000 Hz stereo (to match system audio/encoder)
                const TARGET_SAMPLE_RATE: u32 = 48000;
                const TARGET_CHANNELS: usize = 2;

                let src_sample_rate = sample_rate;
                let src_channels = channels;

                log::info!(
                    "Microphone: will resample from {} Hz {} ch -> {} Hz {} ch",
                    src_sample_rate,
                    src_channels,
                    TARGET_SAMPLE_RATE,
                    TARGET_CHANNELS
                );

                // Build the stream based on sample format
                let tx_clone = tx.clone();
                let should_stop_clone = Arc::clone(&should_stop);
                let is_paused_clone = Arc::clone(&is_paused);

                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => {
                        let stream = device
                            .build_input_stream(
                                &config.into(),
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    if should_stop_clone.load(Ordering::SeqCst) {
                                        return;
                                    }
                                    if is_paused_clone.load(Ordering::SeqCst) {
                                        return;
                                    }

                                    // Convert and resample the audio
                                    let processed = process_mic_audio(
                                        data,
                                        src_sample_rate,
                                        src_channels,
                                        TARGET_SAMPLE_RATE,
                                        TARGET_CHANNELS,
                                    );

                                    // Calculate timestamp relative to start
                                    let elapsed = start_time.elapsed();
                                    let timestamp_100ns = (elapsed.as_nanos() / 100) as i64;

                                    let frame = AudioFrame {
                                        samples: processed,
                                        timestamp_100ns,
                                        frame_count: data.len() / src_channels,
                                    };

                                    let _ = tx_clone.try_send(frame);
                                },
                                |err| log::error!("Microphone stream error: {}", err),
                                None,
                            )
                            .map_err(|e| format!("Failed to build input stream: {}", e))?;
                        stream
                    }
                    cpal::SampleFormat::I16 => {
                        let stream = device
                            .build_input_stream(
                                &config.into(),
                                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                    if should_stop_clone.load(Ordering::SeqCst) {
                                        return;
                                    }
                                    if is_paused_clone.load(Ordering::SeqCst) {
                                        return;
                                    }

                                    // Convert i16 to f32
                                    let f32_samples: Vec<f32> =
                                        data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();

                                    // Convert and resample the audio
                                    let processed = process_mic_audio(
                                        &f32_samples,
                                        src_sample_rate,
                                        src_channels,
                                        TARGET_SAMPLE_RATE,
                                        TARGET_CHANNELS,
                                    );

                                    let elapsed = start_time.elapsed();
                                    let timestamp_100ns = (elapsed.as_nanos() / 100) as i64;

                                    let frame = AudioFrame {
                                        samples: processed,
                                        timestamp_100ns,
                                        frame_count: data.len() / src_channels,
                                    };

                                    let _ = tx_clone.try_send(frame);
                                },
                                |err| log::error!("Microphone stream error: {}", err),
                                None,
                            )
                            .map_err(|e| format!("Failed to build input stream: {}", e))?;
                        stream
                    }
                    format => {
                        return Err(format!("Unsupported sample format: {:?}", format));
                    }
                };

                // Start the stream
                stream
                    .play()
                    .map_err(|e| format!("Failed to start microphone stream: {}", e))?;

                log::info!("Microphone capture started");

                // Keep the stream alive until stop signal
                while !should_stop.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }

                // Stream will be dropped here, stopping capture
                log::info!("Microphone capture stopped");
                Ok(())
            })
            .map_err(|e| format!("Failed to spawn microphone thread: {}", e))?;

        self.mic_handle = Some(handle);
        log::info!("Microphone audio capture started");
        Ok(())
    }

    /// Get a reference to the audio collector.
    pub fn collector(&mut self) -> &mut AudioCollector {
        &mut self.collector
    }

    /// Stop all audio capture threads and wait for them to finish.
    pub fn stop(&mut self) {
        // Signal stop
        self.should_stop.store(true, Ordering::SeqCst);

        // Wait for threads to finish
        if let Some(handle) = self.system_handle.take() {
            match handle.join() {
                Ok(Ok(())) => log::info!("System audio thread stopped cleanly"),
                Ok(Err(e)) => log::error!("System audio thread error: {}", e),
                Err(_) => log::error!("System audio thread panicked"),
            }
        }

        if let Some(handle) = self.mic_handle.take() {
            match handle.join() {
                Ok(Ok(())) => log::info!("Microphone thread stopped cleanly"),
                Ok(Err(e)) => log::error!("Microphone thread error: {}", e),
                Err(_) => log::error!("Microphone thread panicked"),
            }
        }
    }
}

impl Drop for AudioCaptureManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Create bounded channels for audio capture.
///
/// Returns (sender, receiver) tuple with appropriate buffer size.
pub fn create_audio_channel() -> (Sender<AudioFrame>, Receiver<AudioFrame>) {
    bounded(AUDIO_CHANNEL_SIZE)
}

/// Process microphone audio: convert channels and resample to target format.
///
/// This handles:
/// - Mono to stereo conversion (duplicate channel)
/// - Sample rate conversion (linear interpolation)
fn process_mic_audio(
    samples: &[f32],
    src_rate: u32,
    src_channels: usize,
    target_rate: u32,
    target_channels: usize,
) -> Vec<f32> {
    // Step 1: Convert to target channel count
    let stereo_samples = if src_channels == 1 && target_channels == 2 {
        // Mono to stereo: duplicate each sample
        samples.iter().flat_map(|&s| [s, s]).collect::<Vec<_>>()
    } else if src_channels == target_channels {
        // Same channel count, no conversion needed
        samples.to_vec()
    } else if src_channels == 2 && target_channels == 1 {
        // Stereo to mono: average channels
        samples
            .chunks(2)
            .map(|c| (c[0] + c.get(1).unwrap_or(&0.0)) / 2.0)
            .collect()
    } else {
        // Unsupported conversion, just use as-is
        samples.to_vec()
    };

    // Step 2: Resample if rates differ
    if src_rate == target_rate {
        return stereo_samples;
    }

    // Linear interpolation resampling
    let ratio = src_rate as f64 / target_rate as f64;
    let src_frames = stereo_samples.len() / target_channels;
    let target_frames = ((src_frames as f64) / ratio).ceil() as usize;

    let mut resampled = Vec::with_capacity(target_frames * target_channels);

    for i in 0..target_frames {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos.floor() as usize;
        let frac = (src_pos - src_idx as f64) as f32;

        for ch in 0..target_channels {
            let idx = src_idx * target_channels + ch;
            let next_idx = (src_idx + 1) * target_channels + ch;

            let sample = if next_idx < stereo_samples.len() {
                // Linear interpolation between samples
                stereo_samples[idx] * (1.0 - frac) + stereo_samples[next_idx] * frac
            } else if idx < stereo_samples.len() {
                stereo_samples[idx]
            } else {
                0.0
            };

            resampled.push(sample);
        }
    }

    resampled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_frames() {
        let frames = vec![
            AudioFrame {
                samples: vec![0.1, 0.2],
                timestamp_100ns: 1000,
                frame_count: 1,
            },
            AudioFrame {
                samples: vec![0.3, 0.4],
                timestamp_100ns: 2000,
                frame_count: 1,
            },
        ];

        let merged = AudioCollector::merge_frames(&frames).unwrap();
        assert_eq!(merged.samples, vec![0.1, 0.2, 0.3, 0.4]);
        assert_eq!(merged.timestamp_100ns, 1000); // First frame's timestamp
        assert_eq!(merged.frame_count, 2);
    }

    #[test]
    fn test_mix_frames() {
        let a = AudioFrame {
            samples: vec![0.5, 0.5],
            timestamp_100ns: 1000,
            frame_count: 1,
        };
        let b = AudioFrame {
            samples: vec![0.3, 0.3, 0.3],
            timestamp_100ns: 1500,
            frame_count: 1,
        };

        let mixed = AudioCollector::mix_frames(&a, &b);
        assert_eq!(mixed.samples.len(), 3);
        // (0.5 + 0.3) * 0.7 = 0.56
        assert!((mixed.samples[0] - 0.56).abs() < 0.001);
        // (0.5 + 0.3) * 0.7 = 0.56
        assert!((mixed.samples[1] - 0.56).abs() < 0.001);
        // (0.0 + 0.3) * 0.7 = 0.21
        assert!((mixed.samples[2] - 0.21).abs() < 0.001);
    }

    #[test]
    fn test_collector_no_sources() {
        let mut collector = AudioCollector::new(48000, 2);
        assert!(collector.collect().is_none());
    }
}
