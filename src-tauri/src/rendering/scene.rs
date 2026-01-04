//! Scene interpolation system with bezier easing.
//!
//! Ported from Cap's scene.rs - provides smooth transitions between scene modes
//! (Default, CameraOnly, ScreenOnly) with blur, zoom, and opacity effects.

use crate::commands::video_recording::video_project::{SceneMode, SceneSegment};

/// Scene transition duration in seconds (matches Cap).
pub const SCENE_TRANSITION_DURATION: f64 = 0.3;
/// Minimum gap to trigger transition through default mode.
pub const MIN_GAP_FOR_TRANSITION: f64 = 0.5;

/// Cursor for tracking position within scene segments.
#[derive(Debug, Clone, Copy)]
pub struct SceneSegmentsCursor<'a> {
    time: f64,
    segment: Option<&'a SceneSegment>,
    prev_segment: Option<&'a SceneSegment>,
    segments: &'a [SceneSegment],
}

impl<'a> SceneSegmentsCursor<'a> {
    pub fn new(time: f64, segments: &'a [SceneSegment]) -> Self {
        let time_ms = (time * 1000.0) as u64;

        let active_idx = segments
            .iter()
            .position(|s| time_ms >= s.start_ms && time_ms < s.end_ms);

        match active_idx {
            Some(idx) => SceneSegmentsCursor {
                time,
                segment: Some(&segments[idx]),
                prev_segment: if idx > 0 {
                    Some(&segments[idx - 1])
                } else {
                    None
                },
                segments,
            },
            None => {
                let prev = segments
                    .iter()
                    .rev()
                    .find(|s| (s.end_ms as f64 / 1000.0) <= time);
                SceneSegmentsCursor {
                    time,
                    segment: None,
                    prev_segment: prev,
                    segments,
                }
            },
        }
    }

    pub fn next_segment(&self) -> Option<&'a SceneSegment> {
        let time_ms = (self.time * 1000.0) as u64;
        self.segments.iter().find(|s| s.start_ms > time_ms)
    }
}

/// Interpolated scene state for smooth transitions.
#[derive(Debug, Clone, Copy)]
pub struct InterpolatedScene {
    pub camera_opacity: f64,
    pub screen_opacity: f64,
    pub camera_scale: f64,
    pub scene_mode: SceneMode,
    pub transition_progress: f64,
    pub from_mode: SceneMode,
    pub to_mode: SceneMode,
    pub screen_blur: f64,
    pub camera_only_zoom: f64,
    pub camera_only_blur: f64,
}

impl InterpolatedScene {
    fn from_single_mode(mode: SceneMode) -> Self {
        let (camera_opacity, screen_opacity, camera_scale) = Self::get_scene_values(&mode);

        InterpolatedScene {
            camera_opacity,
            screen_opacity,
            camera_scale,
            scene_mode: mode,
            transition_progress: 1.0,
            from_mode: mode,
            to_mode: mode,
            screen_blur: 0.0,
            camera_only_zoom: 1.0,
            camera_only_blur: 0.0,
        }
    }

    pub fn new(cursor: SceneSegmentsCursor) -> Self {
        let ease_in_out = |t: f32| -> f32 {
            // Approximate bezier(0.42, 0.0, 0.58, 1.0)
            bezier_easing::bezier_easing(0.42, 0.0, 0.58, 1.0).unwrap()(t)
        };

        let (current_mode, next_mode, transition_progress) =
            Self::calculate_transition(&cursor, ease_in_out);

        let (start_camera_opacity, start_screen_opacity, start_camera_scale) =
            Self::get_scene_values(&current_mode);
        let (end_camera_opacity, end_screen_opacity, end_camera_scale) =
            Self::get_scene_values(&next_mode);

        let camera_opacity = Self::lerp(
            start_camera_opacity,
            end_camera_opacity,
            transition_progress,
        );
        let screen_opacity = Self::lerp(
            start_screen_opacity,
            end_screen_opacity,
            transition_progress,
        );
        let camera_scale = Self::lerp(start_camera_scale, end_camera_scale, transition_progress);

        // Screen blur for camera-only transitions
        let screen_blur = if matches!(current_mode, SceneMode::CameraOnly)
            || matches!(next_mode, SceneMode::CameraOnly)
        {
            if matches!(current_mode, SceneMode::CameraOnly)
                && !matches!(next_mode, SceneMode::CameraOnly)
            {
                Self::lerp(1.0, 0.0, transition_progress)
            } else if !matches!(current_mode, SceneMode::CameraOnly)
                && matches!(next_mode, SceneMode::CameraOnly)
            {
                transition_progress
            } else {
                0.0
            }
        } else {
            0.0
        };

        // Camera zoom during camera-only transition
        let camera_only_zoom = if matches!(next_mode, SceneMode::CameraOnly)
            && !matches!(current_mode, SceneMode::CameraOnly)
        {
            Self::lerp(1.1, 1.0, transition_progress)
        } else if matches!(current_mode, SceneMode::CameraOnly)
            && !matches!(next_mode, SceneMode::CameraOnly)
        {
            Self::lerp(1.0, 1.1, transition_progress)
        } else {
            1.0
        };

        // Camera blur during camera-only transition
        let camera_only_blur = if matches!(next_mode, SceneMode::CameraOnly)
            && !matches!(current_mode, SceneMode::CameraOnly)
        {
            Self::lerp(1.0, 0.0, transition_progress)
        } else if matches!(current_mode, SceneMode::CameraOnly)
            && !matches!(next_mode, SceneMode::CameraOnly)
        {
            transition_progress
        } else {
            0.0
        };

        InterpolatedScene {
            camera_opacity,
            screen_opacity,
            camera_scale,
            scene_mode: if transition_progress > 0.5 {
                next_mode
            } else {
                current_mode
            },
            transition_progress,
            from_mode: current_mode,
            to_mode: next_mode,
            screen_blur,
            camera_only_zoom,
            camera_only_blur,
        }
    }

    fn calculate_transition(
        cursor: &SceneSegmentsCursor,
        ease_fn: impl Fn(f32) -> f32,
    ) -> (SceneMode, SceneMode, f64) {
        if let Some(segment) = cursor.segment {
            let transition_start = segment.start_ms as f64 / 1000.0 - SCENE_TRANSITION_DURATION;
            let transition_end = segment.end_ms as f64 / 1000.0 - SCENE_TRANSITION_DURATION;

            if cursor.time < segment.start_ms as f64 / 1000.0 && cursor.time >= transition_start {
                // Transitioning into segment
                let prev_mode = if let Some(prev_seg) = cursor.prev_segment {
                    let gap = segment.start_ms as f64 / 1000.0 - prev_seg.end_ms as f64 / 1000.0;
                    let same_mode = prev_seg.mode == segment.mode;
                    if gap < MIN_GAP_FOR_TRANSITION && same_mode {
                        return (segment.mode, segment.mode, 1.0);
                    }
                    if gap > 0.01 {
                        SceneMode::Default
                    } else {
                        prev_seg.mode
                    }
                } else {
                    SceneMode::Default
                };
                let progress = (cursor.time - transition_start) / SCENE_TRANSITION_DURATION;
                return (prev_mode, segment.mode, ease_fn(progress as f32) as f64);
            } else if cursor.time >= transition_end && cursor.time < segment.end_ms as f64 / 1000.0
            {
                // Transitioning out of segment
                if let Some(next_seg) = cursor.next_segment() {
                    let gap = next_seg.start_ms as f64 / 1000.0 - segment.end_ms as f64 / 1000.0;
                    let same_mode = segment.mode == next_seg.mode;
                    if gap < MIN_GAP_FOR_TRANSITION && same_mode {
                        return (segment.mode, segment.mode, 1.0);
                    }
                    let target = if gap > 0.01 {
                        SceneMode::Default
                    } else {
                        next_seg.mode
                    };
                    let progress =
                        ((cursor.time - transition_end) / SCENE_TRANSITION_DURATION).min(1.0);
                    return (segment.mode, target, ease_fn(progress as f32) as f64);
                } else {
                    let progress =
                        ((cursor.time - transition_end) / SCENE_TRANSITION_DURATION).min(1.0);
                    return (
                        segment.mode,
                        SceneMode::Default,
                        ease_fn(progress as f32) as f64,
                    );
                }
            } else {
                return (segment.mode, segment.mode, 1.0);
            }
        } else if let Some(next_segment) = cursor.next_segment() {
            let transition_start =
                next_segment.start_ms as f64 / 1000.0 - SCENE_TRANSITION_DURATION;

            if let Some(prev_seg) = cursor.prev_segment {
                let gap = next_segment.start_ms as f64 / 1000.0 - prev_seg.end_ms as f64 / 1000.0;
                let same_mode = prev_seg.mode == next_segment.mode;
                if gap < MIN_GAP_FOR_TRANSITION && same_mode {
                    return (prev_seg.mode, prev_seg.mode, 1.0);
                }
                if cursor.time >= transition_start {
                    let prev_mode = if gap > 0.01 {
                        SceneMode::Default
                    } else {
                        prev_seg.mode
                    };
                    let progress = (cursor.time - transition_start) / SCENE_TRANSITION_DURATION;
                    return (
                        prev_mode,
                        next_segment.mode,
                        ease_fn(progress as f32) as f64,
                    );
                }
            } else if cursor.time >= transition_start {
                let progress = (cursor.time - transition_start) / SCENE_TRANSITION_DURATION;
                return (
                    SceneMode::Default,
                    next_segment.mode,
                    ease_fn(progress as f32) as f64,
                );
            }
        }

        (SceneMode::Default, SceneMode::Default, 1.0)
    }

    fn get_scene_values(mode: &SceneMode) -> (f64, f64, f64) {
        match mode {
            SceneMode::Default => (1.0, 1.0, 1.0),
            SceneMode::CameraOnly => (1.0, 1.0, 1.0),
            SceneMode::ScreenOnly => (0.0, 1.0, 1.0),
        }
    }

    fn lerp(start: f64, end: f64, t: f64) -> f64 {
        start + (end - start) * t
    }

    pub fn should_render_camera(&self) -> bool {
        self.camera_opacity > 0.01
    }

    pub fn should_render_screen(&self) -> bool {
        self.screen_opacity > 0.01 || self.screen_blur > 0.01
    }

    pub fn is_transitioning_camera_only(&self) -> bool {
        matches!(self.from_mode, SceneMode::CameraOnly)
            || matches!(self.to_mode, SceneMode::CameraOnly)
    }

    pub fn camera_only_transition_opacity(&self) -> f64 {
        if matches!(self.from_mode, SceneMode::CameraOnly)
            && !matches!(self.to_mode, SceneMode::CameraOnly)
        {
            1.0 - self.transition_progress
        } else if !matches!(self.from_mode, SceneMode::CameraOnly)
            && matches!(self.to_mode, SceneMode::CameraOnly)
        {
            self.transition_progress
        } else if matches!(self.from_mode, SceneMode::CameraOnly)
            && matches!(self.to_mode, SceneMode::CameraOnly)
        {
            1.0
        } else {
            0.0
        }
    }

    pub fn regular_camera_transition_opacity(&self) -> f64 {
        if matches!(self.to_mode, SceneMode::CameraOnly)
            && !matches!(self.from_mode, SceneMode::CameraOnly)
        {
            let fast_fade = (1.0 - self.transition_progress * 1.5).max(0.0);
            fast_fade * self.camera_opacity
        } else if matches!(self.from_mode, SceneMode::CameraOnly)
            && !matches!(self.to_mode, SceneMode::CameraOnly)
        {
            let fast_fade = (self.transition_progress * 1.5).min(1.0);
            fast_fade * self.camera_opacity
        } else if matches!(self.from_mode, SceneMode::CameraOnly)
            && matches!(self.to_mode, SceneMode::CameraOnly)
        {
            0.0
        } else {
            self.camera_opacity
        }
    }
}

/// Scene interpolator that calculates scene state for any timestamp.
pub struct SceneInterpolator {
    segments: Vec<SceneSegment>,
}

impl SceneInterpolator {
    pub fn new(segments: Vec<SceneSegment>) -> Self {
        let mut segments = segments;
        segments.sort_by_key(|s| s.start_ms);
        Self { segments }
    }

    pub fn get_scene_at(&self, timestamp_ms: u64) -> InterpolatedScene {
        if self.segments.is_empty() {
            return InterpolatedScene::from_single_mode(SceneMode::Default);
        }

        let time_s = timestamp_ms as f64 / 1000.0;
        let cursor = SceneSegmentsCursor::new(time_s, &self.segments);
        InterpolatedScene::new(cursor)
    }
}
