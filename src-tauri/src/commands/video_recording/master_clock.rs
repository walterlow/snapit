//! Master clock for synchronized A/V recording.
//!
//! Provides a single source of truth for timestamps across all recording components:
//! - Video frames
//! - System audio (WASAPI)
//! - Microphone audio
//! - Webcam (browser-based)
//!
//! All timestamps are in 100-nanosecond units (Windows FILETIME format) for
//! compatibility with Media Foundation encoders.
//!
//! **NOTE**: Currently only used in tests. Production code uses frame-based timing.

#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Shared master clock for synchronized recording.
///
/// Thread-safe and lock-free for high-performance access from multiple threads.
#[derive(Clone)]
pub struct MasterClock {
    inner: Arc<MasterClockInner>,
}

struct MasterClockInner {
    /// Recording start time (wall clock reference)
    start_instant: Instant,
    /// Total pause duration in microseconds
    pause_duration_us: AtomicU64,
    /// Timestamp when pause started (0 if not paused)
    pause_start_us: AtomicU64,
    /// Whether recording is currently paused
    is_paused: AtomicBool,
    /// Whether recording has started
    is_started: AtomicBool,
    /// Audio sample count for sample-accurate audio timing
    audio_sample_count: AtomicU64,
    /// Audio sample rate (e.g., 48000)
    audio_sample_rate: AtomicU64,
    /// Last emitted video timestamp (for monotonicity)
    last_video_timestamp: AtomicI64,
    /// Last emitted audio timestamp (for monotonicity)
    last_audio_timestamp: AtomicI64,
}

impl MasterClock {
    /// Create a new master clock (not yet started).
    pub fn new() -> Self {
        Self {
            inner: Arc::new(MasterClockInner {
                start_instant: Instant::now(),
                pause_duration_us: AtomicU64::new(0),
                pause_start_us: AtomicU64::new(0),
                is_paused: AtomicBool::new(false),
                is_started: AtomicBool::new(false),
                audio_sample_count: AtomicU64::new(0),
                audio_sample_rate: AtomicU64::new(48000),
                last_video_timestamp: AtomicI64::new(0),
                last_audio_timestamp: AtomicI64::new(0),
            }),
        }
    }

    /// Create and start a new master clock.
    pub fn start_now() -> Self {
        let clock = Self::new();
        clock.start();
        clock
    }

    /// Start the clock (call this when recording actually begins).
    pub fn start(&self) {
        // Reset start instant to now
        // Note: We can't mutate start_instant, so we track offset via pause_duration
        self.inner.is_started.store(true, Ordering::SeqCst);
    }

    /// Set the audio sample rate (default 48000).
    pub fn set_audio_sample_rate(&self, sample_rate: u32) {
        self.inner
            .audio_sample_rate
            .store(sample_rate as u64, Ordering::SeqCst);
    }

    /// Pause the clock.
    pub fn pause(&self) {
        if !self.inner.is_paused.load(Ordering::SeqCst) {
            let now_us = self.inner.start_instant.elapsed().as_micros() as u64;
            self.inner.pause_start_us.store(now_us, Ordering::SeqCst);
            self.inner.is_paused.store(true, Ordering::SeqCst);
        }
    }

    /// Resume the clock.
    pub fn resume(&self) {
        if self.inner.is_paused.load(Ordering::SeqCst) {
            let pause_start = self.inner.pause_start_us.load(Ordering::SeqCst);
            let now_us = self.inner.start_instant.elapsed().as_micros() as u64;
            let pause_duration = now_us.saturating_sub(pause_start);

            // Add to total pause duration
            self.inner
                .pause_duration_us
                .fetch_add(pause_duration, Ordering::SeqCst);
            self.inner.pause_start_us.store(0, Ordering::SeqCst);
            self.inner.is_paused.store(false, Ordering::SeqCst);
        }
    }

    /// Check if clock is paused.
    pub fn is_paused(&self) -> bool {
        self.inner.is_paused.load(Ordering::SeqCst)
    }

    /// Get elapsed recording time in microseconds (excludes pause time).
    pub fn elapsed_us(&self) -> u64 {
        let total_elapsed = self.inner.start_instant.elapsed().as_micros() as u64;
        let pause_duration = self.inner.pause_duration_us.load(Ordering::SeqCst);

        // If currently paused, also subtract time since pause started
        let current_pause = if self.inner.is_paused.load(Ordering::SeqCst) {
            let pause_start = self.inner.pause_start_us.load(Ordering::SeqCst);
            total_elapsed.saturating_sub(pause_start)
        } else {
            0
        };

        total_elapsed
            .saturating_sub(pause_duration)
            .saturating_sub(current_pause)
    }

    /// Get elapsed recording time as Duration.
    pub fn elapsed(&self) -> Duration {
        Duration::from_micros(self.elapsed_us())
    }

    /// Get video timestamp in 100-nanosecond units.
    /// Guarantees monotonically increasing timestamps.
    pub fn video_timestamp_100ns(&self) -> i64 {
        let ts = (self.elapsed_us() * 10) as i64;

        // Ensure monotonicity
        let last = self.inner.last_video_timestamp.load(Ordering::SeqCst);
        let new_ts = ts.max(last + 1);
        self.inner
            .last_video_timestamp
            .store(new_ts, Ordering::SeqCst);

        new_ts
    }

    /// Get audio timestamp based on sample count (jitter-free).
    /// Call `advance_audio_samples()` after sending each audio buffer.
    pub fn audio_timestamp_100ns(&self) -> i64 {
        let sample_count = self.inner.audio_sample_count.load(Ordering::SeqCst);
        let sample_rate = self.inner.audio_sample_rate.load(Ordering::SeqCst);

        // Convert samples to 100ns units: samples / sample_rate * 10_000_000
        let ts = (sample_count as f64 / sample_rate as f64 * 10_000_000.0) as i64;

        // Ensure monotonicity
        let last = self.inner.last_audio_timestamp.load(Ordering::SeqCst);
        let new_ts = ts.max(last);
        self.inner
            .last_audio_timestamp
            .store(new_ts, Ordering::SeqCst);

        new_ts
    }

    /// Advance audio sample count (call after sending audio buffer).
    pub fn advance_audio_samples(&self, samples: u64) {
        self.inner
            .audio_sample_count
            .fetch_add(samples, Ordering::SeqCst);
    }

    /// Get current audio sample count.
    pub fn audio_sample_count(&self) -> u64 {
        self.inner.audio_sample_count.load(Ordering::SeqCst)
    }

    /// Reset audio sample count (for pause/resume sync).
    pub fn reset_audio_samples(&self) {
        self.inner.audio_sample_count.store(0, Ordering::SeqCst);
    }

    /// Get timestamp for webcam sync (milliseconds since start).
    /// This is sent to the browser for MediaRecorder alignment.
    pub fn webcam_timestamp_ms(&self) -> u64 {
        self.elapsed_us() / 1000
    }

    /// Get elapsed seconds as f64 (for UI display).
    pub fn elapsed_secs(&self) -> f64 {
        self.elapsed_us() as f64 / 1_000_000.0
    }
}

impl Default for MasterClock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_basic_timing() {
        let clock = MasterClock::start_now();
        thread::sleep(Duration::from_millis(100));

        let elapsed = clock.elapsed_us();
        assert!(
            elapsed >= 90_000 && elapsed <= 150_000,
            "elapsed: {}",
            elapsed
        );
    }

    #[test]
    fn test_pause_resume() {
        let clock = MasterClock::start_now();
        thread::sleep(Duration::from_millis(50));

        clock.pause();
        let before_pause = clock.elapsed_us();
        thread::sleep(Duration::from_millis(100)); // Paused time shouldn't count
        let during_pause = clock.elapsed_us();

        assert!(
            (during_pause as i64 - before_pause as i64).abs() < 10_000,
            "Time should not advance during pause"
        );

        clock.resume();
        thread::sleep(Duration::from_millis(50));
        let after_resume = clock.elapsed_us();

        assert!(
            after_resume > during_pause,
            "Time should advance after resume"
        );
    }

    #[test]
    fn test_audio_timestamps() {
        let clock = MasterClock::start_now();
        clock.set_audio_sample_rate(48000);

        // Advance by 1 second worth of samples
        clock.advance_audio_samples(48000);
        let ts = clock.audio_timestamp_100ns();

        // Should be ~1 second = 10_000_000 (100ns units)
        assert!(ts >= 9_900_000 && ts <= 10_100_000, "ts: {}", ts);
    }

    #[test]
    fn test_monotonicity() {
        let clock = MasterClock::start_now();

        let mut last = 0i64;
        for _ in 0..1000 {
            let ts = clock.video_timestamp_100ns();
            assert!(ts >= last, "Timestamps must be monotonic");
            last = ts;
        }
    }
}
