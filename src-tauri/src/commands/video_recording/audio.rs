//! Audio capture using cpal.
//!
//! Supports capturing system audio (loopback) and microphone input.
//!
//! NOTE: This module is currently unused. The VideoEncoder from windows-capture
//! handles audio internally. This code is kept for potential future use with
//! microphone capture or if we switch to FFmpeg-based encoding.

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};

/// Audio capture source type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSource {
    /// System audio (what's playing on the computer).
    SystemAudio,
    /// Microphone input.
    Microphone,
}

/// Audio capture configuration.
#[derive(Debug, Clone)]
pub struct AudioConfig {
    /// Sample rate (e.g., 44100, 48000).
    pub sample_rate: u32,
    /// Number of channels (1 = mono, 2 = stereo).
    pub channels: u16,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 2,
        }
    }
}

/// Audio capture handle.
pub struct AudioCapture {
    /// The audio stream.
    _stream: Stream,
    /// Buffer for captured samples.
    samples: Arc<Mutex<Vec<f32>>>,
    /// Audio configuration.
    config: AudioConfig,
}

impl AudioCapture {
    /// Create a new audio capture for the specified source.
    pub fn new(source: AudioSource) -> Result<Self, String> {
        let host = cpal::default_host();

        let device = match source {
            AudioSource::SystemAudio => {
                // Try to get output device for loopback capture
                // Note: On Windows, this requires WASAPI loopback which may need special handling
                host.default_output_device()
                    .ok_or("No output device available for system audio capture")?
            },
            AudioSource::Microphone => host
                .default_input_device()
                .ok_or("No microphone available")?,
        };

        Self::from_device(device, source)
    }

    /// Create audio capture from a specific device.
    fn from_device(device: Device, source: AudioSource) -> Result<Self, String> {
        let supported_config = if source == AudioSource::SystemAudio {
            // For loopback, use the output device's config
            device
                .default_output_config()
                .map_err(|e| format!("Failed to get output config: {}", e))?
        } else {
            device
                .default_input_config()
                .map_err(|e| format!("Failed to get input config: {}", e))?
        };

        let sample_format = supported_config.sample_format();
        let config: StreamConfig = supported_config.into();

        let audio_config = AudioConfig {
            sample_rate: config.sample_rate,
            channels: config.channels,
        };

        let samples = Arc::new(Mutex::new(Vec::new()));
        let samples_clone = Arc::clone(&samples);

        let err_fn = |err| eprintln!("Audio capture error: {}", err);

        // Build the appropriate stream based on sample format
        let stream = match sample_format {
            SampleFormat::F32 => {
                Self::build_stream::<f32>(&device, &config, samples_clone, err_fn, source)?
            },
            SampleFormat::I16 => {
                Self::build_stream::<i16>(&device, &config, samples_clone, err_fn, source)?
            },
            SampleFormat::U16 => {
                Self::build_stream::<u16>(&device, &config, samples_clone, err_fn, source)?
            },
            _ => return Err(format!("Unsupported sample format: {:?}", sample_format)),
        };

        Ok(Self {
            _stream: stream,
            samples,
            config: audio_config,
        })
    }

    /// Build an input stream for the specified sample type.
    fn build_stream<T>(
        device: &Device,
        config: &StreamConfig,
        samples: Arc<Mutex<Vec<f32>>>,
        err_fn: impl Fn(cpal::StreamError) + Send + 'static,
        source: AudioSource,
    ) -> Result<Stream, String>
    where
        T: cpal::SizedSample + cpal::FromSample<f32> + Into<f32>,
    {
        let data_callback = move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Use safe locking - drop samples rather than panic if mutex is poisoned
            // Audio callbacks must be resilient to avoid crashing the audio thread
            if let Ok(mut samples_lock) = samples.lock() {
                for &sample in data {
                    samples_lock.push(sample.into());
                }
            }
        };

        if source == AudioSource::SystemAudio {
            // For system audio, we need to use input stream on the output device (loopback)
            // This is platform-specific and may require additional setup on Windows
            device
                .build_input_stream(config, data_callback, err_fn, None)
                .map_err(|e| format!("Failed to build loopback stream: {}", e))
        } else {
            device
                .build_input_stream(config, data_callback, err_fn, None)
                .map_err(|e| format!("Failed to build input stream: {}", e))
        }
    }

    /// Start capturing audio.
    pub fn start(&self) -> Result<(), String> {
        self._stream
            .play()
            .map_err(|e| format!("Failed to start audio capture: {}", e))
    }

    /// Stop capturing and return the collected samples.
    pub fn stop(&self) -> Result<Vec<f32>, String> {
        self._stream
            .pause()
            .map_err(|e| format!("Failed to stop audio capture: {}", e))?;

        let samples = self
            .samples
            .lock()
            .map_err(|e| format!("Failed to lock samples: {}", e))?
            .clone();

        Ok(samples)
    }

    /// Get the audio configuration.
    pub fn config(&self) -> &AudioConfig {
        &self.config
    }

    /// Get the current number of captured samples.
    pub fn sample_count(&self) -> usize {
        self.samples.lock().map(|s| s.len()).unwrap_or(0)
    }

    /// Clear the sample buffer.
    pub fn clear(&self) {
        if let Ok(mut samples) = self.samples.lock() {
            samples.clear();
        }
    }
}

/// Combined audio capture for both system audio and microphone.
pub struct CombinedAudioCapture {
    system_audio: Option<AudioCapture>,
    microphone: Option<AudioCapture>,
}

impl CombinedAudioCapture {
    /// Create a new combined audio capture.
    pub fn new(capture_system_audio: bool, capture_microphone: bool) -> Result<Self, String> {
        let system_audio = if capture_system_audio {
            match AudioCapture::new(AudioSource::SystemAudio) {
                Ok(capture) => Some(capture),
                Err(e) => {
                    eprintln!("Warning: Failed to initialize system audio capture: {}", e);
                    None
                },
            }
        } else {
            None
        };

        let microphone = if capture_microphone {
            match AudioCapture::new(AudioSource::Microphone) {
                Ok(capture) => Some(capture),
                Err(e) => {
                    eprintln!("Warning: Failed to initialize microphone capture: {}", e);
                    None
                },
            }
        } else {
            None
        };

        Ok(Self {
            system_audio,
            microphone,
        })
    }

    /// Start all audio captures.
    pub fn start(&self) -> Result<(), String> {
        if let Some(ref capture) = self.system_audio {
            capture.start()?;
        }
        if let Some(ref capture) = self.microphone {
            capture.start()?;
        }
        Ok(())
    }

    /// Stop all audio captures and return mixed samples.
    pub fn stop(&self) -> Result<Vec<f32>, String> {
        let system_samples = self
            .system_audio
            .as_ref()
            .map(|c| c.stop())
            .transpose()?
            .unwrap_or_default();

        let mic_samples = self
            .microphone
            .as_ref()
            .map(|c| c.stop())
            .transpose()?
            .unwrap_or_default();

        // If we have both, mix them together
        if !system_samples.is_empty() && !mic_samples.is_empty() {
            Ok(mix_audio_samples(&system_samples, &mic_samples))
        } else if !system_samples.is_empty() {
            Ok(system_samples)
        } else {
            Ok(mic_samples)
        }
    }

    /// Check if any audio is being captured.
    pub fn is_capturing(&self) -> bool {
        self.system_audio.is_some() || self.microphone.is_some()
    }
}

/// Mix two audio sample buffers together.
fn mix_audio_samples(a: &[f32], b: &[f32]) -> Vec<f32> {
    let len = a.len().max(b.len());
    let mut result = Vec::with_capacity(len);

    for i in 0..len {
        let sample_a = a.get(i).copied().unwrap_or(0.0);
        let sample_b = b.get(i).copied().unwrap_or(0.0);

        // Simple additive mixing with clipping prevention
        let mixed = (sample_a + sample_b) * 0.5;
        result.push(mixed.clamp(-1.0, 1.0));
    }

    result
}

/// List available audio input devices.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();

    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// List available audio output devices (for system audio loopback).
pub fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();

    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mix_audio_samples() {
        let a = vec![0.5, 0.3, 0.1];
        let b = vec![0.2, 0.4, 0.6, 0.8];

        let mixed = mix_audio_samples(&a, &b);

        assert_eq!(mixed.len(), 4);
        assert!((mixed[0] - 0.35).abs() < 0.001);
        assert!((mixed[1] - 0.35).abs() < 0.001);
        assert!((mixed[2] - 0.35).abs() < 0.001);
        assert!((mixed[3] - 0.4).abs() < 0.001); // 0.0 + 0.8 * 0.5
    }

    #[test]
    fn test_list_devices() {
        // These should not panic
        let _inputs = list_input_devices();
        let _outputs = list_output_devices();
    }
}
