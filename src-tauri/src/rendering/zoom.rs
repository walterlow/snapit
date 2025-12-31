//! Zoom interpolation system with bezier easing.
//!
//! Ported from Cap's zoom.rs - provides smooth zoom transitions
//! based on click events and manual regions.

use crate::commands::video_recording::video_project::{EasingFunction, ZoomConfig, ZoomRegion};
use super::types::ZoomState;

/// Zoom interpolator that calculates zoom state for any timestamp.
pub struct ZoomInterpolator {
    /// Sorted zoom regions.
    regions: Vec<ZoomRegion>,
    /// Default scale when no zoom is active.
    default_scale: f32,
}

impl ZoomInterpolator {
    /// Create a new interpolator from zoom configuration.
    pub fn new(config: &ZoomConfig) -> Self {
        let mut regions = config.regions.clone();
        // Sort by start time
        regions.sort_by_key(|r| r.start_ms);

        Self {
            regions,
            default_scale: 1.0,
        }
    }

    /// Get the zoom state at a specific timestamp.
    pub fn get_zoom_at(&self, timestamp_ms: u64) -> ZoomState {
        if self.regions.is_empty() {
            return ZoomState::identity();
        }

        // Find active region or transition
        for (i, region) in self.regions.iter().enumerate() {
            let transition_in_start = region.start_ms.saturating_sub(region.transition.duration_in_ms as u64);
            let transition_out_end = region.end_ms + region.transition.duration_out_ms as u64;

            // Check if we're in the transition-in phase
            if timestamp_ms >= transition_in_start && timestamp_ms < region.start_ms {
                let progress = (timestamp_ms - transition_in_start) as f32
                    / region.transition.duration_in_ms as f32;
                let eased = ease(progress, region.transition.easing);
                
                // Get previous state (either previous region's target or identity)
                let prev_state = if i > 0 {
                    let prev = &self.regions[i - 1];
                    if timestamp_ms < prev.end_ms + prev.transition.duration_out_ms as u64 {
                        // Still in previous region's transition-out
                        self.get_zoom_at(prev.end_ms) // Recursion safe: different timestamp
                    } else {
                        ZoomState::identity()
                    }
                } else {
                    ZoomState::identity()
                };

                return interpolate_zoom(
                    &prev_state,
                    &ZoomState {
                        scale: region.scale,
                        center_x: region.target_x,
                        center_y: region.target_y,
                    },
                    eased,
                );
            }

            // Check if we're in the active zoom phase
            if timestamp_ms >= region.start_ms && timestamp_ms <= region.end_ms {
                return ZoomState {
                    scale: region.scale,
                    center_x: region.target_x,
                    center_y: region.target_y,
                };
            }

            // Check if we're in the transition-out phase
            if timestamp_ms > region.end_ms && timestamp_ms <= transition_out_end {
                let progress = (timestamp_ms - region.end_ms) as f32
                    / region.transition.duration_out_ms as f32;
                let eased = ease(progress, region.transition.easing);

                // Get next state (either next region or identity)
                let next_state = if i + 1 < self.regions.len() {
                    let next = &self.regions[i + 1];
                    if timestamp_ms >= next.start_ms.saturating_sub(next.transition.duration_in_ms as u64) {
                        // Already transitioning into next region
                        ZoomState {
                            scale: next.scale,
                            center_x: next.target_x,
                            center_y: next.target_y,
                        }
                    } else {
                        ZoomState::identity()
                    }
                } else {
                    ZoomState::identity()
                };

                return interpolate_zoom(
                    &ZoomState {
                        scale: region.scale,
                        center_x: region.target_x,
                        center_y: region.target_y,
                    },
                    &next_state,
                    eased,
                );
            }
        }

        // No active region
        ZoomState::identity()
    }

    /// Check if any zoom is active at the given timestamp.
    pub fn is_zoomed_at(&self, timestamp_ms: u64) -> bool {
        let state = self.get_zoom_at(timestamp_ms);
        state.scale > 1.001
    }
}

/// Interpolate between two zoom states.
fn interpolate_zoom(from: &ZoomState, to: &ZoomState, t: f32) -> ZoomState {
    ZoomState {
        scale: lerp(from.scale, to.scale, t),
        center_x: lerp(from.center_x, to.center_x, t),
        center_y: lerp(from.center_y, to.center_y, t),
    }
}

/// Linear interpolation.
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Apply easing function to progress value.
fn ease(t: f32, easing: EasingFunction) -> f32 {
    match easing {
        EasingFunction::Linear => t,
        EasingFunction::EaseIn => ease_in_cubic(t),
        EasingFunction::EaseOut => ease_out_cubic(t),
        EasingFunction::EaseInOut => ease_in_out_cubic(t),
        EasingFunction::Smooth => smoothstep(t),
        EasingFunction::Snappy => snappy(t),
        EasingFunction::Bouncy => bouncy(t),
    }
}

// Easing functions

fn ease_in_cubic(t: f32) -> f32 {
    t * t * t
}

fn ease_out_cubic(t: f32) -> f32 {
    let t = t - 1.0;
    t * t * t + 1.0
}

fn ease_in_out_cubic(t: f32) -> f32 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        let t = -2.0 * t + 2.0;
        1.0 - t * t * t / 2.0
    }
}

fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn snappy(t: f32) -> f32 {
    // Quick start, gradual end (ease-out quad)
    1.0 - (1.0 - t) * (1.0 - t)
}

fn bouncy(t: f32) -> f32 {
    // Slight overshoot at the end
    if t < 0.7 {
        // Quick approach
        let normalized = t / 0.7;
        1.1 * normalized * normalized
    } else {
        // Settle back
        let normalized = (t - 0.7) / 0.3;
        1.1 - 0.1 * (1.0 - (1.0 - normalized) * (1.0 - normalized))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::video_recording::video_project::ZoomTransition;

    #[test]
    fn test_zoom_interpolation() {
        let config = ZoomConfig {
            mode: crate::commands::video_recording::video_project::ZoomMode::Auto,
            auto_zoom_scale: 2.0,
            regions: vec![ZoomRegion {
                id: "test".to_string(),
                start_ms: 1000,
                end_ms: 3000,
                scale: 2.0,
                target_x: 0.5,
                target_y: 0.5,
                is_auto: true,
                transition: ZoomTransition {
                    duration_in_ms: 300,
                    duration_out_ms: 300,
                    easing: EasingFunction::EaseInOut,
                },
            }],
        };

        let interpolator = ZoomInterpolator::new(&config);

        // Before zoom
        let state = interpolator.get_zoom_at(0);
        assert!((state.scale - 1.0).abs() < 0.01);

        // During zoom
        let state = interpolator.get_zoom_at(2000);
        assert!((state.scale - 2.0).abs() < 0.01);

        // After zoom
        let state = interpolator.get_zoom_at(5000);
        assert!((state.scale - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_easing_functions() {
        // All easing functions should map 0 -> 0 and 1 -> 1
        let funcs = [
            EasingFunction::Linear,
            EasingFunction::EaseIn,
            EasingFunction::EaseOut,
            EasingFunction::EaseInOut,
            EasingFunction::Smooth,
            EasingFunction::Snappy,
        ];

        for func in funcs {
            assert!((ease(0.0, func) - 0.0).abs() < 0.01, "{:?} at 0", func);
            assert!((ease(1.0, func) - 1.0).abs() < 0.1, "{:?} at 1", func);
        }
    }
}
