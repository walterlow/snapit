//! Recording state management.
//!
//! This module provides thread-safe state management for recording sessions,
//! including start/stop signals and progress tracking.

#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crossbeam_channel::{bounded, Receiver, Sender};
use lazy_static::lazy_static;

use super::{RecordingSettings, RecordingState};

lazy_static! {
    /// Global recording controller.
    pub static ref RECORDING_CONTROLLER: Mutex<RecordingController> = Mutex::new(RecordingController::new());
}

/// Commands that can be sent to the recorder.
#[derive(Debug, Clone)]
pub enum RecorderCommand {
    /// Stop recording and save the file.
    Stop,
    /// Cancel recording without saving.
    Cancel,
    /// Pause recording (MP4 only).
    Pause,
    /// Resume recording.
    Resume,
}

/// Shared state for tracking recording progress.
#[derive(Debug)]
pub struct RecordingProgress {
    /// Number of frames captured.
    pub frame_count: AtomicU64,
    /// Whether recording is currently paused.
    pub is_paused: AtomicBool,
    /// Whether recording should stop.
    pub should_stop: AtomicBool,
    /// Whether recording was cancelled.
    pub was_cancelled: AtomicBool,
}

impl RecordingProgress {
    pub fn new() -> Self {
        Self {
            frame_count: AtomicU64::new(0),
            is_paused: AtomicBool::new(false),
            should_stop: AtomicBool::new(false),
            was_cancelled: AtomicBool::new(false),
        }
    }

    pub fn increment_frame(&self) {
        self.frame_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn get_frame_count(&self) -> u64 {
        self.frame_count.load(Ordering::Relaxed)
    }

    pub fn set_paused(&self, paused: bool) {
        self.is_paused.store(paused, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::Relaxed)
    }

    pub fn request_stop(&self) {
        self.should_stop.store(true, Ordering::Relaxed);
    }

    pub fn should_stop(&self) -> bool {
        self.should_stop.load(Ordering::Relaxed)
    }

    pub fn mark_cancelled(&self) {
        self.was_cancelled.store(true, Ordering::Relaxed);
        self.should_stop.store(true, Ordering::Relaxed);
    }

    pub fn was_cancelled(&self) -> bool {
        self.was_cancelled.load(Ordering::Relaxed)
    }
}

impl Default for RecordingProgress {
    fn default() -> Self {
        Self::new()
    }
}

/// Active recording session data.
pub struct ActiveRecording {
    /// Recording settings.
    pub settings: RecordingSettings,
    /// When recording started.
    pub started_at: Instant,
    /// Output file path.
    pub output_path: std::path::PathBuf,
    /// Shared progress state.
    pub progress: Arc<RecordingProgress>,
    /// Command sender to control the recorder.
    pub command_tx: Sender<RecorderCommand>,
    /// Handle to the recording thread.
    pub thread_handle: Option<std::thread::JoinHandle<Result<(), String>>>,
}

/// Controller for managing recording state.
pub struct RecordingController {
    /// Current recording state.
    pub state: RecordingState,
    /// Current settings (if recording).
    pub settings: Option<RecordingSettings>,
    /// Active recording session.
    pub active: Option<ActiveRecording>,
}

impl RecordingController {
    pub fn new() -> Self {
        Self {
            state: RecordingState::Idle,
            settings: None,
            active: None,
        }
    }

    /// Check if a recording is currently active.
    pub fn is_active(&self) -> bool {
        matches!(
            self.state,
            RecordingState::Recording { .. }
                | RecordingState::Countdown { .. }
                | RecordingState::Paused { .. }
                | RecordingState::Processing { .. }
        )
    }

    /// Start a new recording session.
    pub fn start(
        &mut self,
        settings: RecordingSettings,
        output_path: std::path::PathBuf,
    ) -> Result<(Arc<RecordingProgress>, Receiver<RecorderCommand>), String> {
        if self.is_active() {
            return Err("A recording is already in progress".to_string());
        }

        let progress = Arc::new(RecordingProgress::new());
        let (command_tx, command_rx) = bounded::<RecorderCommand>(10);

        self.state = if settings.countdown_secs > 0 {
            RecordingState::Countdown {
                seconds_remaining: settings.countdown_secs,
            }
        } else {
            RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: 0.0,
                frame_count: 0,
            }
        };

        self.settings = Some(settings.clone());
        self.active = Some(ActiveRecording {
            settings,
            started_at: Instant::now(),
            output_path,
            progress: Arc::clone(&progress),
            command_tx,
            thread_handle: None,
        });

        Ok((progress, command_rx))
    }

    /// Update the recording state.
    pub fn update_state(&mut self, state: RecordingState) {
        self.state = state;
    }

    /// Update countdown.
    pub fn update_countdown(&mut self, seconds_remaining: u32) {
        self.state = RecordingState::Countdown { seconds_remaining };
    }

    /// Transition from countdown to recording.
    pub fn start_actual_recording(&mut self) {
        self.state = RecordingState::Recording {
            started_at: chrono::Local::now().to_rfc3339(),
            elapsed_secs: 0.0,
            frame_count: 0,
        };

        if let Some(ref mut active) = self.active {
            active.started_at = Instant::now();
        }
    }

    /// Update recording progress.
    pub fn update_progress(&mut self, elapsed_secs: f64, frame_count: u64) {
        if let RecordingState::Recording { started_at, .. } = &self.state {
            self.state = RecordingState::Recording {
                started_at: started_at.clone(),
                elapsed_secs,
                frame_count,
            };
        }
    }

    /// Set paused state.
    pub fn set_paused(&mut self, paused: bool) {
        if paused {
            if let RecordingState::Recording {
                elapsed_secs,
                frame_count,
                ..
            } = &self.state
            {
                self.state = RecordingState::Paused {
                    elapsed_secs: *elapsed_secs,
                    frame_count: *frame_count,
                };
            }
        } else if let RecordingState::Paused {
            elapsed_secs,
            frame_count,
        } = &self.state
        {
            self.state = RecordingState::Recording {
                started_at: chrono::Local::now().to_rfc3339(),
                elapsed_secs: *elapsed_secs,
                frame_count: *frame_count,
            };
        }

        if let Some(ref active) = self.active {
            active.progress.set_paused(paused);
        }
    }

    /// Set processing state with progress.
    pub fn set_processing(&mut self, progress: f32) {
        self.state = RecordingState::Processing { progress };
    }

    /// Complete the recording.
    pub fn complete(&mut self, output_path: String, duration_secs: f64, file_size_bytes: u64) {
        self.state = RecordingState::Completed {
            output_path,
            duration_secs,
            file_size_bytes,
        };
        self.active = None;
    }

    /// Set error state.
    pub fn set_error(&mut self, message: String) {
        self.state = RecordingState::Error { message };
        self.active = None;
    }

    /// Reset to idle state.
    pub fn reset(&mut self) {
        self.state = RecordingState::Idle;
        self.settings = None;
        self.active = None;
    }

    /// Send a command to the active recording.
    pub fn send_command(&self, command: RecorderCommand) -> Result<(), String> {
        if let Some(ref active) = self.active {
            active
                .command_tx
                .send(command)
                .map_err(|e| format!("Failed to send command: {}", e))
        } else {
            Err("No active recording".to_string())
        }
    }

    /// Get elapsed time since recording started.
    pub fn get_elapsed_secs(&self) -> f64 {
        if let Some(ref active) = self.active {
            active.started_at.elapsed().as_secs_f64()
        } else {
            0.0
        }
    }
}

impl Default for RecordingController {
    fn default() -> Self {
        Self::new()
    }
}
