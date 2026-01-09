//! Video drift tracking for webcam timestamp correction.
//!
//! Camera hardware clocks often drift relative to wall clock time.
//! This module detects and corrects drift to maintain proper A/V sync.
//!
//! Algorithm (adapted from Cap):
//! 1. 2-second warmup period to establish baseline
//! 2. Capture baseline offset between camera and wall clock
//! 3. Correct subsequent timestamps using drift ratio
//! 4. Clamp extreme drift (>5%) to prevent runaway correction

use std::time::Duration;

/// Tolerance for wall clock comparison (100ms).
const VIDEO_WALL_CLOCK_TOLERANCE_SECS: f64 = 0.1;

/// Warmup period before capturing baseline (2 seconds).
const WARMUP_SECS: f64 = 2.0;

/// Minimum acceptable drift ratio.
const MIN_DRIFT_RATIO: f64 = 0.95;

/// Maximum acceptable drift ratio.
const MAX_DRIFT_RATIO: f64 = 1.05;

/// Tracks drift between camera hardware timestamps and wall clock.
///
/// Camera timestamps come from the hardware and may drift over time
/// relative to system wall clock. This tracker:
/// - Waits for a warmup period to establish stable baseline
/// - Captures the offset between camera and wall clock after warmup
/// - Applies drift correction to maintain sync
/// - Clamps extreme drift to prevent overcorrection
pub struct VideoDriftTracker {
    /// Baseline offset captured after warmup (camera_secs - wall_clock_secs).
    baseline_offset_secs: Option<f64>,
    /// Count of frames where timestamp was capped to max allowed.
    capped_frame_count: u64,
}

impl VideoDriftTracker {
    /// Create a new drift tracker.
    pub fn new() -> Self {
        Self {
            baseline_offset_secs: None,
            capped_frame_count: 0,
        }
    }

    /// Calculate corrected timestamp from camera duration and wall clock elapsed.
    ///
    /// # Arguments
    /// * `camera_duration` - Duration from camera hardware timestamp
    /// * `wall_clock_elapsed` - Duration from system wall clock since capture start
    ///
    /// # Returns
    /// Corrected duration to use for frame PTS
    pub fn calculate_timestamp(
        &mut self,
        camera_duration: Duration,
        wall_clock_elapsed: Duration,
    ) -> Duration {
        let camera_secs = camera_duration.as_secs_f64();
        let wall_clock_secs = wall_clock_elapsed.as_secs_f64();
        let max_allowed_secs = wall_clock_secs + VIDEO_WALL_CLOCK_TOLERANCE_SECS;

        // During warmup, just use camera timestamp (capped to wall clock + tolerance)
        if wall_clock_secs < WARMUP_SECS || camera_secs < WARMUP_SECS {
            let result_secs = camera_secs.min(max_allowed_secs);
            if result_secs < camera_secs {
                self.capped_frame_count += 1;
            }
            return Duration::from_secs_f64(result_secs);
        }

        // Capture baseline offset after warmup
        if self.baseline_offset_secs.is_none() {
            let offset = camera_secs - wall_clock_secs;
            log::debug!(
                "[DRIFT] Capturing baseline after warmup: wall={:.3}s camera={:.3}s offset={:.3}s",
                wall_clock_secs,
                camera_secs,
                offset
            );
            self.baseline_offset_secs = Some(offset);
        }

        // Apply baseline correction
        let baseline = self.baseline_offset_secs.unwrap_or(0.0);
        let adjusted_camera_secs = (camera_secs - baseline).max(0.0);

        // Calculate drift ratio
        let drift_ratio = if adjusted_camera_secs > 0.0 {
            wall_clock_secs / adjusted_camera_secs
        } else {
            1.0
        };

        // Apply drift correction (clamp extreme drift)
        let corrected_secs = if !(MIN_DRIFT_RATIO..=MAX_DRIFT_RATIO).contains(&drift_ratio) {
            log::warn!(
                "[DRIFT] Extreme drift detected: ratio={:.4} wall={:.3}s adjusted_camera={:.3}s baseline={:.3}s",
                drift_ratio,
                wall_clock_secs,
                adjusted_camera_secs,
                baseline
            );
            let clamped_ratio = drift_ratio.clamp(MIN_DRIFT_RATIO, MAX_DRIFT_RATIO);
            adjusted_camera_secs * clamped_ratio
        } else {
            adjusted_camera_secs * drift_ratio
        };

        // Cap to max allowed (wall clock + tolerance)
        let final_secs = corrected_secs.min(max_allowed_secs);
        if final_secs < corrected_secs {
            self.capped_frame_count += 1;
        }

        Duration::from_secs_f64(final_secs)
    }

    /// Get the number of frames where timestamp was capped.
    pub fn capped_frame_count(&self) -> u64 {
        self.capped_frame_count
    }

    /// Get the baseline offset (None if still in warmup).
    pub fn baseline_offset(&self) -> Option<f64> {
        self.baseline_offset_secs
    }

    /// Reset the tracker (e.g., after pause/resume).
    pub fn reset(&mut self) {
        self.baseline_offset_secs = None;
        self.capped_frame_count = 0;
    }
}

impl Default for VideoDriftTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Tracks timestamp anomalies for diagnostics.
///
/// Detects backward jumps, large forward jumps, and accumulated skew.
pub struct TimestampAnomalyTracker {
    /// Name of the stream (for logging).
    stream_name: &'static str,
    /// Total anomaly count.
    anomaly_count: u64,
    /// Consecutive anomaly count (reset on valid frame).
    consecutive_anomalies: u64,
    /// Total backward skew accumulated.
    total_backward_skew_secs: f64,
    /// Maximum single backward skew observed.
    max_backward_skew_secs: f64,
    /// Total forward skew accumulated.
    total_forward_skew_secs: f64,
    /// Maximum single forward skew observed.
    max_forward_skew_secs: f64,
    /// Last valid duration seen.
    last_valid_duration: Option<Duration>,
    /// Accumulated compensation applied.
    accumulated_compensation_secs: f64,
    /// Number of resyncs performed.
    resync_count: u64,
}

impl TimestampAnomalyTracker {
    /// Create a new anomaly tracker for the given stream.
    pub fn new(stream_name: &'static str) -> Self {
        Self {
            stream_name,
            anomaly_count: 0,
            consecutive_anomalies: 0,
            total_backward_skew_secs: 0.0,
            max_backward_skew_secs: 0.0,
            total_forward_skew_secs: 0.0,
            max_forward_skew_secs: 0.0,
            last_valid_duration: None,
            accumulated_compensation_secs: 0.0,
            resync_count: 0,
        }
    }

    /// Process a timestamp and detect anomalies.
    ///
    /// Returns the corrected duration if anomaly detected, or the original if valid.
    pub fn process(&mut self, duration: Duration) -> Duration {
        let Some(last) = self.last_valid_duration else {
            self.last_valid_duration = Some(duration);
            return duration;
        };

        let last_secs = last.as_secs_f64();
        let current_secs = duration.as_secs_f64();
        let delta = current_secs - last_secs;

        // Check for backward jump
        if delta < -0.001 {
            self.anomaly_count += 1;
            self.consecutive_anomalies += 1;
            self.total_backward_skew_secs += delta.abs();
            self.max_backward_skew_secs = self.max_backward_skew_secs.max(delta.abs());

            // Compensate by using last valid + small increment
            let compensated = last_secs + 0.001;
            self.accumulated_compensation_secs += compensated - current_secs;

            if self.consecutive_anomalies > 10 {
                log::warn!(
                    "[{}] {} consecutive backward jumps, resyncing",
                    self.stream_name,
                    self.consecutive_anomalies
                );
                self.resync_count += 1;
                self.consecutive_anomalies = 0;
                self.last_valid_duration = Some(duration);
                return duration;
            }

            let result = Duration::from_secs_f64(compensated);
            self.last_valid_duration = Some(result);
            return result;
        }

        // Check for large forward jump (>5 seconds)
        if delta > 5.0 {
            self.anomaly_count += 1;
            self.consecutive_anomalies += 1;
            self.total_forward_skew_secs += delta;
            self.max_forward_skew_secs = self.max_forward_skew_secs.max(delta);

            log::warn!(
                "[{}] Large forward jump: {:.3}s -> {:.3}s (delta={:.3}s)",
                self.stream_name,
                last_secs,
                current_secs,
                delta
            );

            // Accept but track
            self.last_valid_duration = Some(duration);
            return duration;
        }

        // Valid timestamp
        self.consecutive_anomalies = 0;
        self.last_valid_duration = Some(duration);
        duration
    }

    /// Get diagnostic summary.
    pub fn summary(&self) -> String {
        format!(
            "[{}] anomalies={} resyncs={} backward_skew={:.3}s (max={:.3}s) forward_skew={:.3}s (max={:.3}s) compensation={:.3}s",
            self.stream_name,
            self.anomaly_count,
            self.resync_count,
            self.total_backward_skew_secs,
            self.max_backward_skew_secs,
            self.total_forward_skew_secs,
            self.max_forward_skew_secs,
            self.accumulated_compensation_secs
        )
    }

    /// Get total anomaly count.
    pub fn anomaly_count(&self) -> u64 {
        self.anomaly_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dur(secs: f64) -> Duration {
        Duration::from_secs_f64(secs)
    }

    #[test]
    fn test_drift_tracker_warmup() {
        let mut tracker = VideoDriftTracker::new();

        // During warmup, should pass through (capped to wall clock + tolerance)
        let result = tracker.calculate_timestamp(dur(1.0), dur(1.0));
        assert!((result.as_secs_f64() - 1.0).abs() < 0.001);
        assert!(tracker.baseline_offset().is_none());

        // Still in warmup
        let result = tracker.calculate_timestamp(dur(1.5), dur(1.5));
        assert!((result.as_secs_f64() - 1.5).abs() < 0.001);
        assert!(tracker.baseline_offset().is_none());
    }

    #[test]
    fn test_drift_tracker_baseline_capture() {
        let mut tracker = VideoDriftTracker::new();

        // Skip warmup
        let _ = tracker.calculate_timestamp(dur(2.1), dur(2.0));

        // Baseline should be captured
        assert!(tracker.baseline_offset().is_some());
        let offset = tracker.baseline_offset().unwrap();
        assert!((offset - 0.1).abs() < 0.01); // camera was 0.1s ahead
    }

    #[test]
    fn test_drift_tracker_extreme_drift_clamped() {
        let mut tracker = VideoDriftTracker::new();

        // Establish baseline
        let _ = tracker.calculate_timestamp(dur(2.0), dur(2.0));

        // Simulate extreme drift (camera running 20% fast)
        let result = tracker.calculate_timestamp(dur(12.0), dur(10.0));

        // Should be clamped, not exceed max allowed
        let max_allowed = 10.0 + VIDEO_WALL_CLOCK_TOLERANCE_SECS;
        assert!(result.as_secs_f64() <= max_allowed + 0.001);
    }

    #[test]
    fn test_anomaly_tracker_backward_jump() {
        let mut tracker = TimestampAnomalyTracker::new("test");

        let _ = tracker.process(dur(1.0));
        let _ = tracker.process(dur(2.0));

        // Backward jump
        let result = tracker.process(dur(1.5));

        // Should compensate
        assert!(result.as_secs_f64() > 2.0);
        assert_eq!(tracker.anomaly_count(), 1);
    }
}
