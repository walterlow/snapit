//! Audio level monitoring module.
//!
//! Monitors audio input levels and emits events to the frontend for visualization.
//! Supports both microphone input and system audio (WASAPI loopback).
//!
//! # Usage
//!
//! ```typescript
//! // Frontend: Start monitoring
//! await invoke('start_audio_monitoring', { micDeviceIndex: 0, monitorSystemAudio: true });
//!
//! // Frontend: Listen for level updates
//! listen('audio-levels', (event) => {
//!   const { micLevel, systemLevel } = event.payload;
//!   // Update UI with levels (0.0 - 1.0)
//! });
//!
//! // Frontend: Stop monitoring
//! await invoke('stop_audio_monitoring');
//! ```

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use lazy_static::lazy_static;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use ts_rs::TS;
use wasapi::*;

/// Audio levels payload emitted to frontend.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioLevels {
    /// Microphone input level (0.0 - 1.0)
    pub mic_level: f32,
    /// System audio level (0.0 - 1.0)
    pub system_level: f32,
    /// Whether microphone is currently being monitored
    pub mic_active: bool,
    /// Whether system audio is currently being monitored
    pub system_active: bool,
}

/// Audio monitoring state.
struct AudioMonitorState {
    /// Handle to microphone monitoring thread
    mic_thread: Option<JoinHandle<()>>,
    /// Handle to system audio monitoring thread
    system_thread: Option<JoinHandle<()>>,
    /// Signal to stop monitoring
    should_stop: Arc<AtomicBool>,
    /// Current microphone level (shared between threads)
    mic_level: Arc<Mutex<f32>>,
    /// Current system level (shared between threads)
    system_level: Arc<Mutex<f32>>,
    /// Whether mic monitoring is active
    mic_active: Arc<AtomicBool>,
    /// Whether system monitoring is active
    system_active: Arc<AtomicBool>,
}

impl Default for AudioMonitorState {
    fn default() -> Self {
        Self {
            mic_thread: None,
            system_thread: None,
            should_stop: Arc::new(AtomicBool::new(false)),
            mic_level: Arc::new(Mutex::new(0.0)),
            system_level: Arc::new(Mutex::new(0.0)),
            mic_active: Arc::new(AtomicBool::new(false)),
            system_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

lazy_static! {
    /// Global audio monitor state.
    static ref AUDIO_MONITOR: Mutex<AudioMonitorState> = Mutex::new(AudioMonitorState::default());
}

/// Calculate RMS (Root Mean Square) level from audio samples.
/// Returns a value between 0.0 and 1.0.
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    
    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_squares / samples.len() as f32).sqrt();
    
    // Normalize to 0-1 range (audio samples are typically -1.0 to 1.0)
    // Apply some scaling to make the meter more responsive
    (rms * 2.0).min(1.0)
}

/// Convert raw bytes (little-endian f32) to f32 samples.
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

/// Monitor microphone audio levels.
fn monitor_microphone(
    device_index: usize,
    should_stop: Arc<AtomicBool>,
    level: Arc<Mutex<f32>>,
    is_active: Arc<AtomicBool>,
) {
    // Initialize COM for this thread (HRESULT.ok() converts to Result)
    if let Err(e) = initialize_mta().ok() {
        log::error!("[AUDIO_MONITOR] Failed to initialize COM for mic: {:?}", e);
        return;
    }

    // Get device enumerator
    let enumerator = match DeviceEnumerator::new() {
        Ok(e) => e,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to create device enumerator: {:?}", e);
            return;
        }
    };

    // Get capture devices and select by index
    let devices: Vec<Device> = match enumerator.get_device_collection(&Direction::Capture) {
        Ok(collection) => {
            let count = collection.get_nbr_devices().unwrap_or(0);
            (0..count)
                .filter_map(|i| collection.get_device_at_index(i).ok())
                .collect()
        }
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get capture devices: {:?}", e);
            return;
        }
    };

    let device: &Device = match devices.get(device_index) {
        Some(d) => d,
        None => {
            log::error!("[AUDIO_MONITOR] Microphone device index {} not found", device_index);
            return;
        }
    };

    let device_name = device.get_friendlyname().unwrap_or_else(|_| "Unknown".to_string());
    log::info!("[AUDIO_MONITOR] Monitoring microphone: '{}'", device_name);

    // Get audio client
    let mut audio_client = match device.get_iaudioclient() {
        Ok(c) => c,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get audio client: {:?}", e);
            return;
        }
    };

    // Define format: 32-bit float, 48kHz, stereo
    let wave_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);

    // Get device timing
    let (_def_time, min_time) = match audio_client.get_device_period() {
        Ok(t) => t,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get device period: {:?}", e);
            return;
        }
    };

    // Initialize for capture
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };

    if let Err(e) = audio_client.initialize_client(&wave_format, &Direction::Capture, &mode) {
        log::error!("[AUDIO_MONITOR] Failed to initialize audio client: {:?}", e);
        return;
    }

    let event_handle = match audio_client.set_get_eventhandle() {
        Ok(h) => h,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get event handle: {:?}", e);
            return;
        }
    };

    let capture_client = match audio_client.get_audiocaptureclient() {
        Ok(c) => c,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get capture client: {:?}", e);
            return;
        }
    };

    // Start capture
    if let Err(e) = audio_client.start_stream() {
        log::error!("[AUDIO_MONITOR] Failed to start mic stream: {:?}", e);
        return;
    }

    is_active.store(true, Ordering::SeqCst);
    log::info!("[AUDIO_MONITOR] Microphone monitoring started");

    // Capture buffer
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(48000 * 4);

    // Monitoring loop
    while !should_stop.load(Ordering::Relaxed) {
        // Wait for buffer event (short timeout for responsive shutdown)
        if event_handle.wait_for_event(50).is_err() {
            continue;
        }

        // Read audio data
        if let Ok(_) = capture_client.read_from_device_to_deque(&mut sample_queue) {
            if sample_queue.len() >= 4 {
                let samples = bytes_to_f32_samples(&sample_queue);
                let rms = calculate_rms(&samples);
                
                if let Ok(mut lvl) = level.lock() {
                    // Smooth the level with exponential moving average
                    *lvl = *lvl * 0.7 + rms * 0.3;
                }
                
                sample_queue.clear();
            }
        }
    }

    // Cleanup
    let _ = audio_client.stop_stream();
    is_active.store(false, Ordering::SeqCst);
    if let Ok(mut lvl) = level.lock() {
        *lvl = 0.0;
    }
    log::info!("[AUDIO_MONITOR] Microphone monitoring stopped");
}

/// Monitor system audio levels (WASAPI loopback).
fn monitor_system_audio(
    should_stop: Arc<AtomicBool>,
    level: Arc<Mutex<f32>>,
    is_active: Arc<AtomicBool>,
) {
    // Initialize COM for this thread (HRESULT.ok() converts to Result)
    if let Err(e) = initialize_mta().ok() {
        log::error!("[AUDIO_MONITOR] Failed to initialize COM for system audio: {:?}", e);
        return;
    }

    // Get default render device for loopback
    let enumerator = match DeviceEnumerator::new() {
        Ok(e) => e,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to create device enumerator: {:?}", e);
            return;
        }
    };

    let device = match enumerator.get_default_device(&Direction::Render) {
        Ok(d) => d,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get default audio device: {:?}", e);
            return;
        }
    };

    let device_name = device.get_friendlyname().unwrap_or_else(|_| "Unknown".to_string());
    log::info!("[AUDIO_MONITOR] Monitoring system audio: '{}'", device_name);

    // Get audio client
    let mut audio_client = match device.get_iaudioclient() {
        Ok(c) => c,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get audio client: {:?}", e);
            return;
        }
    };

    // Define format: 32-bit float, 48kHz, stereo
    let wave_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);

    // Get device timing
    let (_def_time, min_time) = match audio_client.get_device_period() {
        Ok(t) => t,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get device period: {:?}", e);
            return;
        }
    };

    // Initialize for loopback capture (capture from render device)
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };

    if let Err(e) = audio_client.initialize_client(&wave_format, &Direction::Capture, &mode) {
        log::error!("[AUDIO_MONITOR] Failed to initialize loopback client: {:?}", e);
        return;
    }

    let event_handle = match audio_client.set_get_eventhandle() {
        Ok(h) => h,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get event handle: {:?}", e);
            return;
        }
    };

    let capture_client = match audio_client.get_audiocaptureclient() {
        Ok(c) => c,
        Err(e) => {
            log::error!("[AUDIO_MONITOR] Failed to get capture client: {:?}", e);
            return;
        }
    };

    // Start capture
    if let Err(e) = audio_client.start_stream() {
        log::error!("[AUDIO_MONITOR] Failed to start loopback stream: {:?}", e);
        return;
    }

    is_active.store(true, Ordering::SeqCst);
    log::info!("[AUDIO_MONITOR] System audio monitoring started");

    // Capture buffer
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(48000 * 4);

    // Monitoring loop
    while !should_stop.load(Ordering::Relaxed) {
        // Wait for buffer event
        if event_handle.wait_for_event(50).is_err() {
            continue;
        }

        // Read audio data
        if let Ok(_) = capture_client.read_from_device_to_deque(&mut sample_queue) {
            if sample_queue.len() >= 4 {
                let samples = bytes_to_f32_samples(&sample_queue);
                let rms = calculate_rms(&samples);
                
                if let Ok(mut lvl) = level.lock() {
                    // Smooth the level with exponential moving average
                    *lvl = *lvl * 0.7 + rms * 0.3;
                }
                
                sample_queue.clear();
            }
        }
    }

    // Cleanup
    let _ = audio_client.stop_stream();
    is_active.store(false, Ordering::SeqCst);
    if let Ok(mut lvl) = level.lock() {
        *lvl = 0.0;
    }
    log::info!("[AUDIO_MONITOR] System audio monitoring stopped");
}

/// Start audio level monitoring.
///
/// This starts background threads that capture audio and update level values.
/// A separate emitter thread sends periodic updates to the frontend.
pub fn start_monitoring(
    app: AppHandle,
    mic_device_index: Option<usize>,
    enable_system_audio: bool,
) -> Result<(), String> {
    let mut state = AUDIO_MONITOR.lock().map_err(|e| e.to_string())?;
    
    // Stop any existing monitoring
    state.should_stop.store(true, Ordering::SeqCst);
    
    // Wait for threads to stop
    if let Some(handle) = state.mic_thread.take() {
        let _ = handle.join();
    }
    if let Some(handle) = state.system_thread.take() {
        let _ = handle.join();
    }
    
    // Reset state
    state.should_stop = Arc::new(AtomicBool::new(false));
    state.mic_level = Arc::new(Mutex::new(0.0));
    state.system_level = Arc::new(Mutex::new(0.0));
    state.mic_active = Arc::new(AtomicBool::new(false));
    state.system_active = Arc::new(AtomicBool::new(false));
    
    let should_stop = Arc::clone(&state.should_stop);
    let mic_level = Arc::clone(&state.mic_level);
    let system_level = Arc::clone(&state.system_level);
    let mic_active = Arc::clone(&state.mic_active);
    let system_active = Arc::clone(&state.system_active);
    
    // Start microphone monitoring thread
    if let Some(device_index) = mic_device_index {
        let stop = Arc::clone(&should_stop);
        let level = Arc::clone(&mic_level);
        let active = Arc::clone(&mic_active);
        
        state.mic_thread = Some(thread::spawn(move || {
            monitor_microphone(device_index, stop, level, active);
        }));
    }
    
    // Start system audio monitoring thread
    if enable_system_audio {
        let stop = Arc::clone(&should_stop);
        let level = Arc::clone(&system_level);
        let active = Arc::clone(&system_active);
        
        state.system_thread = Some(thread::spawn(move || {
            monitor_system_audio(stop, level, active);
        }));
    }
    
    // Start emitter thread that sends levels to frontend
    let stop_emitter = Arc::clone(&should_stop);
    let mic_lvl = Arc::clone(&mic_level);
    let sys_lvl = Arc::clone(&system_level);
    let mic_act = Arc::clone(&mic_active);
    let sys_act = Arc::clone(&system_active);
    
    thread::spawn(move || {
        while !stop_emitter.load(Ordering::Relaxed) {
            let levels = AudioLevels {
                mic_level: mic_lvl.lock().map(|l| *l).unwrap_or(0.0),
                system_level: sys_lvl.lock().map(|l| *l).unwrap_or(0.0),
                mic_active: mic_act.load(Ordering::Relaxed),
                system_active: sys_act.load(Ordering::Relaxed),
            };
            
            if let Err(e) = app.emit("audio-levels", &levels) {
                log::trace!("[AUDIO_MONITOR] Failed to emit audio levels: {}", e);
            }
            
            // Emit at ~20Hz for smooth UI updates
            thread::sleep(Duration::from_millis(50));
        }
    });
    
    log::info!(
        "[AUDIO_MONITOR] Monitoring started: mic={:?}, system={}",
        mic_device_index,
        enable_system_audio
    );
    
    Ok(())
}

/// Stop audio level monitoring.
pub fn stop_monitoring() -> Result<(), String> {
    let mut state = AUDIO_MONITOR.lock().map_err(|e| e.to_string())?;
    
    state.should_stop.store(true, Ordering::SeqCst);
    
    // Wait for threads to stop (with timeout)
    if let Some(handle) = state.mic_thread.take() {
        let _ = handle.join();
    }
    if let Some(handle) = state.system_thread.take() {
        let _ = handle.join();
    }
    
    log::info!("[AUDIO_MONITOR] Monitoring stopped");
    Ok(())
}

/// Check if audio monitoring is currently active.
pub fn is_monitoring() -> bool {
    AUDIO_MONITOR
        .lock()
        .map(|state| {
            state.mic_active.load(Ordering::Relaxed) 
                || state.system_active.load(Ordering::Relaxed)
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_rms() {
        // Silent audio
        let silent = vec![0.0; 100];
        assert!(calculate_rms(&silent) < 0.01);
        
        // Full amplitude sine approximation (simple test)
        let loud = vec![1.0, -1.0, 1.0, -1.0];
        assert!(calculate_rms(&loud) > 0.5);
        
        // Empty
        assert_eq!(calculate_rms(&[]), 0.0);
    }

    #[test]
    fn test_bytes_to_f32() {
        let mut bytes = VecDeque::new();
        bytes.extend(&0.5f32.to_le_bytes());
        bytes.extend(&(-0.25f32).to_le_bytes());
        
        let samples = bytes_to_f32_samples(&bytes);
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.5).abs() < 0.001);
        assert!((samples[1] - (-0.25)).abs() < 0.001);
    }
}
