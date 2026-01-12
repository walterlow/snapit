//! Multi-track audio recording module.
//!
//! Records system audio and microphone to separate WAV files for later mixing.
//! This enables independent volume control and audio editing in post-production.
//!
//! # Architecture
//!
//! Uses async write queues to decouple real-time audio capture from disk I/O:
//!
//! ```text
//! ┌─────────────────┐     ┌─────────────────┐
//! │  System Audio   │     │   Microphone    │
//! │  (WASAPI Loop)  │     │  (WASAPI Cap)   │
//! └────────┬────────┘     └────────┬────────┘
//!          │                       │
//!          ▼                       ▼
//!    ┌───────────┐           ┌───────────┐
//!    │ Capture   │           │ Capture   │
//!    │ Thread    │           │ Thread    │
//!    └─────┬─────┘           └─────┬─────┘
//!          │ (channel)             │ (channel)
//!          ▼                       ▼
//!    ┌───────────┐           ┌───────────┐
//!    │ Writer    │           │ Writer    │
//!    │ Thread    │           │ Thread    │
//!    └─────┬─────┘           └─────┬─────┘
//!          │                       │
//!          ▼                       ▼
//!   system_audio.wav         microphone.wav
//! ```
//!
//! This prevents disk I/O from blocking real-time audio capture, eliminating jitter.

use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Sender};
use hound::{WavSpec, WavWriter};
use wasapi::*;

/// Audio format configuration.
const SAMPLE_RATE: u32 = 48000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 32;

/// Async write queue buffer size (in sample batches).
/// ~5 seconds of audio buffer at 48kHz stereo (48000 * 2 channels * 5 seconds / 4800 batch size)
const WRITE_QUEUE_SIZE: usize = 100;

/// Event timeout for WASAPI buffer events (ms).
/// Lower = more responsive capture, but more CPU. 10-20ms is optimal.
const EVENT_TIMEOUT_MS: u32 = 15;

/// Multi-track audio recorder that captures system audio and microphone to separate files.
pub struct MultiTrackAudioRecorder {
    /// Handle to system audio recording thread.
    system_thread: Option<JoinHandle<Result<(), String>>>,
    /// Handle to microphone recording thread.
    mic_thread: Option<JoinHandle<Result<(), String>>>,
    /// Signal to stop recording.
    should_stop: Arc<AtomicBool>,
    /// Signal that recording is paused.
    is_paused: Arc<AtomicBool>,
    /// Path to system audio WAV file.
    system_audio_path: Option<PathBuf>,
    /// Path to microphone WAV file.
    mic_audio_path: Option<PathBuf>,
}

impl MultiTrackAudioRecorder {
    /// Create a new multi-track audio recorder with its own control flags.
    pub fn new() -> Self {
        Self {
            system_thread: None,
            mic_thread: None,
            should_stop: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            system_audio_path: None,
            mic_audio_path: None,
        }
    }

    /// Create a new multi-track audio recorder with shared control flags.
    ///
    /// Use this when you want to control pause/resume externally.
    pub fn with_flags(should_stop: Arc<AtomicBool>, is_paused: Arc<AtomicBool>) -> Self {
        Self {
            system_thread: None,
            mic_thread: None,
            should_stop,
            is_paused,
            system_audio_path: None,
            mic_audio_path: None,
        }
    }

    /// Start recording audio to the specified files.
    ///
    /// # Arguments
    /// * `system_audio_path` - Path for system audio WAV file (None to skip)
    /// * `mic_audio_path` - Path for microphone WAV file (None to skip)
    ///
    /// # Returns
    /// Tuple of (system_audio_path, mic_audio_path) for files that were started
    pub fn start(
        &mut self,
        system_audio_path: Option<PathBuf>,
        mic_audio_path: Option<PathBuf>,
    ) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
        // Reset stop flag
        self.should_stop.store(false, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);

        let start_time = Instant::now();
        let mut actual_system_path = None;
        let mut actual_mic_path = None;

        // Start system audio recording thread
        if let Some(path) = system_audio_path {
            let should_stop = Arc::clone(&self.should_stop);
            let is_paused = Arc::clone(&self.is_paused);
            let path_clone = path.clone();

            let handle = thread::spawn(move || {
                record_system_audio(&path_clone, should_stop, is_paused, start_time)
            });

            self.system_thread = Some(handle);
            self.system_audio_path = Some(path.clone());
            actual_system_path = Some(path);
            log::info!("[MULTITRACK] Started system audio recording");
        }

        // Start microphone recording thread
        if let Some(path) = mic_audio_path {
            let should_stop = Arc::clone(&self.should_stop);
            let is_paused = Arc::clone(&self.is_paused);
            let path_clone = path.clone();

            let handle = thread::spawn(move || {
                record_microphone(&path_clone, should_stop, is_paused, start_time)
            });

            self.mic_thread = Some(handle);
            self.mic_audio_path = Some(path.clone());
            actual_mic_path = Some(path);
            log::info!("[MULTITRACK] Started microphone recording");
        }

        Ok((actual_system_path, actual_mic_path))
    }

    /// Pause audio recording.
    pub fn pause(&self) {
        self.is_paused.store(true, Ordering::SeqCst);
        log::info!("[MULTITRACK] Recording paused");
    }

    /// Resume audio recording.
    pub fn resume(&self) {
        self.is_paused.store(false, Ordering::SeqCst);
        log::info!("[MULTITRACK] Recording resumed");
    }

    /// Stop recording and finalize WAV files.
    pub fn stop(&mut self) -> Result<(), String> {
        log::info!("[MULTITRACK] Stopping audio recording...");
        self.should_stop.store(true, Ordering::SeqCst);

        let mut errors = Vec::new();

        // Wait for system audio thread
        if let Some(handle) = self.system_thread.take() {
            match handle.join() {
                Ok(Ok(())) => log::info!("[MULTITRACK] System audio recording completed"),
                Ok(Err(e)) => {
                    log::error!("[MULTITRACK] System audio recording error: {}", e);
                    errors.push(format!("System audio: {}", e));
                },
                Err(_) => {
                    log::error!("[MULTITRACK] System audio thread panicked");
                    errors.push("System audio thread panicked".to_string());
                },
            }
        }

        // Wait for microphone thread
        if let Some(handle) = self.mic_thread.take() {
            match handle.join() {
                Ok(Ok(())) => log::info!("[MULTITRACK] Microphone recording completed"),
                Ok(Err(e)) => {
                    log::error!("[MULTITRACK] Microphone recording error: {}", e);
                    errors.push(format!("Microphone: {}", e));
                },
                Err(_) => {
                    log::error!("[MULTITRACK] Microphone thread panicked");
                    errors.push("Microphone thread panicked".to_string());
                },
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Get the paths of recorded audio files.
    pub fn get_audio_paths(&self) -> (Option<&PathBuf>, Option<&PathBuf>) {
        (
            self.system_audio_path.as_ref(),
            self.mic_audio_path.as_ref(),
        )
    }
}

impl Drop for MultiTrackAudioRecorder {
    fn drop(&mut self) {
        // Ensure threads are stopped
        self.should_stop.store(true, Ordering::SeqCst);
    }
}

/// Spawn async WAV writer thread that consumes samples from a channel.
/// Returns sender channel for samples.
fn spawn_wav_writer(
    output_path: PathBuf,
    should_stop: Arc<AtomicBool>,
    name: &str,
) -> Result<(Sender<Vec<f32>>, JoinHandle<Result<u64, String>>), String> {
    let (tx, rx) = bounded::<Vec<f32>>(WRITE_QUEUE_SIZE);
    let name = name.to_string();

    let handle = thread::Builder::new()
        .name(format!("{}-writer", name))
        .spawn(move || {
            let spec = WavSpec {
                channels: CHANNELS,
                sample_rate: SAMPLE_RATE,
                bits_per_sample: BITS_PER_SAMPLE,
                sample_format: hound::SampleFormat::Float,
            };

            let file = File::create(&output_path)
                .map_err(|e| format!("Failed to create WAV file: {}", e))?;
            let mut writer = WavWriter::new(BufWriter::new(file), spec)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?;

            let mut total_samples = 0u64;

            // Process samples until channel closes or stop signal
            loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(samples) => {
                        for sample in &samples {
                            if let Err(e) = writer.write_sample(*sample) {
                                log::error!("[{}] Write error: {}", name, e);
                                // Continue writing remaining samples
                            }
                        }
                        total_samples += samples.len() as u64;
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        if should_stop.load(Ordering::Relaxed) {
                            break;
                        }
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        break;
                    },
                }
            }

            // Drain any remaining samples
            while let Ok(samples) = rx.try_recv() {
                for sample in &samples {
                    let _ = writer.write_sample(*sample);
                }
                total_samples += samples.len() as u64;
            }

            writer
                .finalize()
                .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

            log::info!("[{}] Writer finished, {} samples", name, total_samples);
            Ok(total_samples)
        })
        .map_err(|e| format!("Failed to spawn writer thread: {}", e))?;

    Ok((tx, handle))
}

/// Record system audio (loopback) to a WAV file.
/// Uses async write queue to prevent disk I/O from blocking real-time capture.
fn record_system_audio(
    output_path: &PathBuf,
    should_stop: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    _start_time: Instant,
) -> Result<(), String> {
    // Spawn async writer thread first
    let (sample_tx, writer_handle) = spawn_wav_writer(
        output_path.clone(),
        Arc::clone(&should_stop),
        "system-audio",
    )?;

    // Initialize COM for this thread
    initialize_mta()
        .ok()
        .map_err(|e| format!("Failed to initialize COM: {:?}", e))?;

    // Get default render device for loopback
    let enumerator = DeviceEnumerator::new()
        .map_err(|e| format!("Failed to create device enumerator: {:?}", e))?;

    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("Failed to get default audio device: {:?}", e))?;

    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "Unknown".to_string());
    log::info!("[MULTITRACK] System audio device: '{}'", device_name);

    // Get audio client
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("Failed to get audio client: {:?}", e))?;

    // Define format: 32-bit float, 48kHz, stereo
    let wave_format = WaveFormat::new(
        BITS_PER_SAMPLE as usize,
        BITS_PER_SAMPLE as usize,
        &SampleType::Float,
        SAMPLE_RATE as usize,
        CHANNELS as usize,
        None,
    );

    // Get device timing
    let (_def_time, min_time) = audio_client
        .get_device_period()
        .map_err(|e| format!("Failed to get device period: {:?}", e))?;

    // Initialize for loopback capture
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };

    audio_client
        .initialize_client(&wave_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Failed to initialize audio client: {:?}", e))?;

    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Failed to get event handle: {:?}", e))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Failed to get capture client: {:?}", e))?;

    // Start capture
    audio_client
        .start_stream()
        .map_err(|e| format!("Failed to start audio stream: {:?}", e))?;

    log::info!("[MULTITRACK] System audio capture started (async write queue)");

    // Capture buffer - pre-allocate for ~100ms of audio to reduce allocations
    let buffer_capacity = (SAMPLE_RATE as usize * CHANNELS as usize) / 10;
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(buffer_capacity * 4);
    let mut captured_samples = 0u64;

    // Capture loop - only captures, never blocks on disk I/O
    while !should_stop.load(Ordering::Relaxed) {
        // Handle pause
        if is_paused.load(Ordering::Relaxed) {
            // Drain buffer during pause
            if event_handle.wait_for_event(10).is_ok() {
                let _ = capture_client.read_from_device_to_deque(&mut sample_queue);
                sample_queue.clear();
            }
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        // Wait for buffer event with lower timeout for responsive capture
        if event_handle.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
            continue;
        }

        // Read audio data
        if capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .is_ok()
            && sample_queue.len() >= 4
        {
            // Convert to f32 samples
            let samples = bytes_to_f32_samples(&sample_queue);
            captured_samples += samples.len() as u64;
            sample_queue.clear();

            // Send to async writer (non-blocking - drops samples if queue full)
            if sample_tx.try_send(samples).is_err() {
                log::warn!("[MULTITRACK] System audio write queue full, dropping samples");
            }
        }
    }

    // Drop sender to signal writer to finish
    drop(sample_tx);

    // Wait for writer to finish
    match writer_handle.join() {
        Ok(Ok(total)) => {
            log::info!(
                "[MULTITRACK] System audio: captured {}, written {}",
                captured_samples,
                total
            );
        },
        Ok(Err(e)) => {
            log::error!("[MULTITRACK] System audio writer error: {}", e);
            return Err(e);
        },
        Err(_) => {
            log::error!("[MULTITRACK] System audio writer thread panicked");
            return Err("Writer thread panicked".to_string());
        },
    }

    Ok(())
}

/// Record microphone audio to a WAV file.
/// Uses async write queue to prevent disk I/O from blocking real-time capture.
fn record_microphone(
    output_path: &PathBuf,
    should_stop: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    _start_time: Instant,
) -> Result<(), String> {
    // Spawn async writer thread first
    let (sample_tx, writer_handle) =
        spawn_wav_writer(output_path.clone(), Arc::clone(&should_stop), "microphone")?;

    // Initialize COM for this thread
    initialize_mta()
        .ok()
        .map_err(|e| format!("Failed to initialize COM: {:?}", e))?;

    // Get default capture device (microphone)
    let enumerator = DeviceEnumerator::new()
        .map_err(|e| format!("Failed to create device enumerator: {:?}", e))?;

    let device = enumerator
        .get_default_device(&Direction::Capture)
        .map_err(|e| format!("Failed to get default microphone: {:?}", e))?;

    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "Unknown".to_string());
    log::info!("[MULTITRACK] Microphone device: '{}'", device_name);

    // Get audio client
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("Failed to get audio client: {:?}", e))?;

    // Define format: 32-bit float, 48kHz, stereo
    let wave_format = WaveFormat::new(
        BITS_PER_SAMPLE as usize,
        BITS_PER_SAMPLE as usize,
        &SampleType::Float,
        SAMPLE_RATE as usize,
        CHANNELS as usize,
        None,
    );

    // Get device timing
    let (_def_time, min_time) = audio_client
        .get_device_period()
        .map_err(|e| format!("Failed to get device period: {:?}", e))?;

    // Initialize for capture
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };

    audio_client
        .initialize_client(&wave_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Failed to initialize audio client: {:?}", e))?;

    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Failed to get event handle: {:?}", e))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Failed to get capture client: {:?}", e))?;

    // Start capture
    audio_client
        .start_stream()
        .map_err(|e| format!("Failed to start audio stream: {:?}", e))?;

    log::info!("[MULTITRACK] Microphone capture started (async write queue)");

    // Capture buffer - pre-allocate for ~100ms of audio to reduce allocations
    let buffer_capacity = (SAMPLE_RATE as usize * CHANNELS as usize) / 10;
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(buffer_capacity * 4);
    let mut captured_samples = 0u64;

    // Capture loop - only captures, never blocks on disk I/O
    while !should_stop.load(Ordering::Relaxed) {
        // Handle pause
        if is_paused.load(Ordering::Relaxed) {
            // Drain buffer during pause
            if event_handle.wait_for_event(10).is_ok() {
                let _ = capture_client.read_from_device_to_deque(&mut sample_queue);
                sample_queue.clear();
            }
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        // Wait for buffer event with lower timeout for responsive capture
        if event_handle.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
            continue;
        }

        // Read audio data
        if capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .is_ok()
            && sample_queue.len() >= 4
        {
            // Convert to f32 samples
            let samples = bytes_to_f32_samples(&sample_queue);
            captured_samples += samples.len() as u64;
            sample_queue.clear();

            // Send to async writer (non-blocking - drops samples if queue full)
            if sample_tx.try_send(samples).is_err() {
                log::warn!("[MULTITRACK] Microphone write queue full, dropping samples");
            }
        }
    }

    // Drop sender to signal writer to finish
    drop(sample_tx);

    // Wait for writer to finish
    match writer_handle.join() {
        Ok(Ok(total)) => {
            log::info!(
                "[MULTITRACK] Microphone: captured {}, written {}",
                captured_samples,
                total
            );
        },
        Ok(Err(e)) => {
            log::error!("[MULTITRACK] Microphone writer error: {}", e);
            return Err(e);
        },
        Err(_) => {
            log::error!("[MULTITRACK] Microphone writer thread panicked");
            return Err("Writer thread panicked".to_string());
        },
    }

    Ok(())
}

/// Convert raw bytes (little-endian f32) to f32 sample vector.
fn bytes_to_f32_samples(bytes: &VecDeque<u8>) -> Vec<f32> {
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    let bytes_slice: Vec<u8> = bytes.iter().copied().collect();

    for chunk in bytes_slice.chunks(4) {
        if chunk.len() == 4 {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            samples.push(sample);
        }
    }

    samples
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bytes_to_f32_samples() {
        let mut bytes = VecDeque::new();
        // 0.5 in f32 little-endian
        bytes.extend(&0.5f32.to_le_bytes());
        // -0.25 in f32 little-endian
        bytes.extend(&(-0.25f32).to_le_bytes());

        let samples = bytes_to_f32_samples(&bytes);
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.5).abs() < 0.001);
        assert!((samples[1] - (-0.25)).abs() < 0.001);
    }
}
