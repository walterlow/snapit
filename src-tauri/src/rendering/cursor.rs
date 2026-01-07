//! Cursor interpolation with spring physics for smooth cursor rendering.
//!
//! Implements cursor smoothing similar to Cap's approach:
//! 1. Spring-mass-damper physics for natural movement
//! 2. Different spring profiles (default, snappy near clicks, drag when held)
//! 3. Cursor movement densification for sparse data

// Allow unused fields - kept for potential future use
#![allow(dead_code)]

use super::coord::{Coord, FrameSpace, ScreenUVSpace, Size, ZoomedFrameSpace};
use super::zoom::InterpolatedZoom;
use crate::commands::video_recording::cursor::events::{
    CursorEvent, CursorEventType, CursorImage, CursorRecording,
};
use std::collections::HashMap;

// ============================================================================
// Spring Physics Configuration
// ============================================================================

/// Spring configuration for cursor movement.
#[derive(Debug, Clone, Copy)]
struct SpringConfig {
    tension: f32,  // Spring stiffness
    mass: f32,     // Object mass
    friction: f32, // Damping coefficient
}

/// Default spring configuration (tuned for smooth cursor following).
const DEFAULT_SPRING: SpringConfig = SpringConfig {
    tension: 180.0,
    mass: 1.0,
    friction: 26.0,
};

/// Snappy profile - used within 160ms of a click (quick response).
fn snappy_spring() -> SpringConfig {
    SpringConfig {
        tension: DEFAULT_SPRING.tension * 1.65,
        mass: (DEFAULT_SPRING.mass * 0.65).max(0.1),
        friction: DEFAULT_SPRING.friction * 1.25,
    }
}

/// Drag profile - used when mouse button is held down (less bouncy).
fn drag_spring() -> SpringConfig {
    SpringConfig {
        tension: DEFAULT_SPRING.tension * 1.25,
        mass: (DEFAULT_SPRING.mass * 0.85).max(0.1),
        friction: DEFAULT_SPRING.friction * 1.1,
    }
}

/// Time window for snappy response after click.
const CLICK_REACTION_WINDOW_MS: u64 = 160;

/// Simulation tick rate (60fps internal).
const SIMULATION_TICK_MS: f32 = 1000.0 / 60.0;

/// Gap interpolation threshold - densify if gap is larger than this.
const GAP_INTERPOLATION_THRESHOLD_MS: f32 = SIMULATION_TICK_MS * 4.0;

/// Minimum cursor travel distance for interpolation (2% of screen).
const MIN_CURSOR_TRAVEL_FOR_INTERPOLATION: f32 = 0.02;

/// Maximum interpolated steps to insert.
const MAX_INTERPOLATED_STEPS: usize = 120;

// ============================================================================
// Types
// ============================================================================

/// 2D position.
#[derive(Debug, Clone, Copy, Default)]
struct XY {
    x: f32,
    y: f32,
}

/// Pre-computed smoothed cursor event.
#[derive(Debug, Clone)]
struct SmoothedCursorEvent {
    time_ms: u64,
    target_position: XY,
    position: XY,
    velocity: XY,
}

/// Interpolated cursor state at a point in time.
#[derive(Debug, Clone)]
pub struct InterpolatedCursor {
    /// Normalized position (0-1).
    pub x: f32,
    pub y: f32,
    /// Velocity for motion blur effects.
    pub velocity_x: f32,
    pub velocity_y: f32,
    /// Active cursor image ID (references cursor_images map).
    pub cursor_id: Option<String>,
}

impl Default for InterpolatedCursor {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            velocity_x: 0.0,
            velocity_y: 0.0,
            cursor_id: None,
        }
    }
}

impl InterpolatedCursor {
    /// Get position as a normalized UV coordinate.
    pub fn as_uv_coord(&self) -> Coord<ScreenUVSpace> {
        Coord::new(self.x as f64, self.y as f64)
    }

    /// Convert normalized position to frame space coordinates.
    ///
    /// # Arguments
    /// * `frame_size` - Size of the output frame in pixels
    pub fn to_frame_space(&self, frame_size: Size<FrameSpace>) -> Coord<FrameSpace> {
        Coord::new(
            self.x as f64 * frame_size.width,
            self.y as f64 * frame_size.height,
        )
    }

    /// Convert to zoomed frame space, applying zoom transformation.
    ///
    /// # Arguments
    /// * `frame_size` - Size of the output frame in pixels
    /// * `zoom` - Current interpolated zoom state
    /// * `padding` - Frame padding offset
    pub fn to_zoomed_frame_space(
        &self,
        frame_size: Size<FrameSpace>,
        zoom: &InterpolatedZoom,
        padding: Coord<FrameSpace>,
    ) -> Coord<ZoomedFrameSpace> {
        let frame_pos = self.to_frame_space(frame_size);
        frame_pos.apply_zoom_bounds(zoom, frame_size, padding)
    }

    /// Get velocity as a frame space coordinate (for motion blur).
    pub fn velocity_in_frame_space(&self, frame_size: Size<FrameSpace>) -> Coord<FrameSpace> {
        Coord::new(
            self.velocity_x as f64 * frame_size.width,
            self.velocity_y as f64 * frame_size.height,
        )
    }
}

// ============================================================================
// Spring Physics Simulation
// ============================================================================

/// Spring-mass-damper simulation for smooth cursor movement.
struct SpringSimulation {
    tension: f32,
    mass: f32,
    friction: f32,
    position: XY,
    velocity: XY,
    target_position: XY,
}

impl SpringSimulation {
    fn new(config: SpringConfig) -> Self {
        Self {
            tension: config.tension,
            mass: config.mass,
            friction: config.friction,
            position: XY::default(),
            velocity: XY::default(),
            target_position: XY::default(),
        }
    }

    fn set_config(&mut self, config: SpringConfig) {
        self.tension = config.tension;
        self.mass = config.mass;
        self.friction = config.friction;
    }

    fn set_position(&mut self, pos: XY) {
        self.position = pos;
    }

    fn set_velocity(&mut self, vel: XY) {
        self.velocity = vel;
    }

    fn set_target_position(&mut self, target: XY) {
        self.target_position = target;
    }

    /// Run simulation for given duration.
    /// Uses fixed timestep internally for stability.
    fn run(&mut self, dt_ms: f32) -> XY {
        if dt_ms <= 0.0 {
            return self.position;
        }

        let mut remaining = dt_ms;

        while remaining > 0.0 {
            let step_ms = remaining.min(SIMULATION_TICK_MS);
            let tick = step_ms / 1000.0;

            // Spring force: F = -k * (position - target)
            let dx = self.target_position.x - self.position.x;
            let dy = self.target_position.y - self.position.y;

            let spring_force_x = dx * self.tension;
            let spring_force_y = dy * self.tension;

            // Damping force: F = -c * velocity
            let damping_force_x = -self.velocity.x * self.friction;
            let damping_force_y = -self.velocity.y * self.friction;

            // Total force
            let total_force_x = spring_force_x + damping_force_x;
            let total_force_y = spring_force_y + damping_force_y;

            // Acceleration: a = F / m
            let mass = self.mass.max(0.001);
            let accel_x = total_force_x / mass;
            let accel_y = total_force_y / mass;

            // Update velocity and position
            self.velocity.x += accel_x * tick;
            self.velocity.y += accel_y * tick;
            self.position.x += self.velocity.x * tick;
            self.position.y += self.velocity.y * tick;

            remaining -= step_ms;
        }

        self.position
    }
}

// ============================================================================
// Cursor Interpolator
// ============================================================================

/// Cursor interpolator with pre-computed smoothed positions.
pub struct CursorInterpolator {
    /// Pre-computed smoothed events.
    smoothed_events: Vec<SmoothedCursorEvent>,
    /// Original events for cursor ID lookup.
    original_events: Vec<CursorEvent>,
    /// Cursor images keyed by ID.
    cursor_images: HashMap<String, CursorImage>,
    /// Decoded cursor images (RGBA data).
    decoded_images: HashMap<String, DecodedCursorImage>,
    /// Region dimensions for normalization.
    region_width: u32,
    region_height: u32,
    region_offset_x: i32,
    region_offset_y: i32,
}

/// Decoded cursor image ready for compositing.
#[derive(Debug, Clone)]
pub struct DecodedCursorImage {
    pub width: u32,
    pub height: u32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub data: Vec<u8>, // RGBA
}

impl CursorInterpolator {
    /// Create a new cursor interpolator from a recording.
    pub fn new(recording: &CursorRecording) -> Self {
        let smoothed_events = compute_smoothed_events(recording);

        // Decode cursor images from base64 PNG
        let decoded_images = decode_cursor_images(&recording.cursor_images);

        Self {
            smoothed_events,
            original_events: recording.events.clone(),
            cursor_images: recording.cursor_images.clone(),
            decoded_images,
            region_width: recording.region_width,
            region_height: recording.region_height,
            region_offset_x: recording.region_offset_x,
            region_offset_y: recording.region_offset_y,
        }
    }

    /// Get interpolated cursor position at a specific timestamp.
    pub fn get_cursor_at(&self, time_ms: u64) -> InterpolatedCursor {
        let cursor_id = get_active_cursor_id(&self.original_events, time_ms);
        interpolate_at_time(&self.smoothed_events, time_ms, cursor_id)
    }

    /// Get decoded cursor image by ID.
    pub fn get_cursor_image(&self, cursor_id: &str) -> Option<&DecodedCursorImage> {
        self.decoded_images.get(cursor_id)
    }

    /// Get cursor image metadata by ID.
    pub fn get_cursor_image_meta(&self, cursor_id: &str) -> Option<&CursorImage> {
        self.cursor_images.get(cursor_id)
    }

    /// Check if there is any cursor data.
    pub fn has_cursor_data(&self) -> bool {
        !self.smoothed_events.is_empty()
    }

    /// Get region dimensions.
    pub fn region_dimensions(&self) -> (u32, u32) {
        (self.region_width, self.region_height)
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Convert screen coordinates to normalized (0-1) coordinates.
fn normalize_position(x: i32, y: i32, recording: &CursorRecording) -> XY {
    let region_x = (x - recording.region_offset_x) as f32;
    let region_y = (y - recording.region_offset_y) as f32;

    XY {
        x: region_x / recording.region_width as f32,
        y: region_y / recording.region_height as f32,
    }
}

/// Check if we should fill the gap between two cursor events.
fn should_fill_gap(from: &CursorEvent, to: &CursorEvent, recording: &CursorRecording) -> bool {
    let dt_ms = (to.timestamp_ms as i64 - from.timestamp_ms as i64) as f32;
    if dt_ms < GAP_INTERPOLATION_THRESHOLD_MS {
        return false;
    }

    let from_norm = normalize_position(from.x, from.y, recording);
    let to_norm = normalize_position(to.x, to.y, recording);

    let dx = to_norm.x - from_norm.x;
    let dy = to_norm.y - from_norm.y;
    let distance = (dx * dx + dy * dy).sqrt();

    distance >= MIN_CURSOR_TRAVEL_FOR_INTERPOLATION
}

/// Densify cursor moves by inserting interpolated samples for large gaps.
fn densify_cursor_moves(events: &[CursorEvent], recording: &CursorRecording) -> Vec<CursorEvent> {
    if events.len() < 2 {
        return events.to_vec();
    }

    let moves: Vec<_> = events
        .iter()
        .filter(|e| matches!(e.event_type, CursorEventType::Move))
        .collect();

    if moves.len() < 2 {
        return events.to_vec();
    }

    let requires_interpolation = moves
        .windows(2)
        .any(|w| should_fill_gap(w[0], w[1], recording));

    if !requires_interpolation {
        return events.to_vec();
    }

    let mut dense_moves: Vec<CursorEvent> = vec![moves[0].clone()];

    for i in 0..moves.len() - 1 {
        let current = moves[i];
        let next = moves[i + 1];

        if should_fill_gap(current, next, recording) {
            let dt_ms = (next.timestamp_ms - current.timestamp_ms) as f32;
            let segments =
                ((dt_ms / SIMULATION_TICK_MS).ceil() as usize).clamp(2, MAX_INTERPOLATED_STEPS);

            for step in 1..segments {
                let t = step as f32 / segments as f32;
                dense_moves.push(CursorEvent {
                    timestamp_ms: current.timestamp_ms + (dt_ms * t) as u64,
                    x: current.x + ((next.x - current.x) as f32 * t) as i32,
                    y: current.y + ((next.y - current.y) as f32 * t) as i32,
                    event_type: CursorEventType::Move,
                    cursor_id: None,
                });
            }
        }

        dense_moves.push(next.clone());
    }

    dense_moves
}

/// Get spring profile based on click context.
fn get_spring_profile(
    time_ms: u64,
    clicks: &[&CursorEvent],
    is_primary_button_down: bool,
) -> SpringConfig {
    let recent_click = clicks.iter().find(|c| {
        let diff = time_ms.abs_diff(c.timestamp_ms);
        diff <= CLICK_REACTION_WINDOW_MS
    });

    if recent_click.is_some() {
        return snappy_spring();
    }

    if is_primary_button_down {
        return drag_spring();
    }

    DEFAULT_SPRING
}

/// Pre-compute smoothed cursor events for the entire recording.
fn compute_smoothed_events(recording: &CursorRecording) -> Vec<SmoothedCursorEvent> {
    let moves = densify_cursor_moves(&recording.events, recording);
    let clicks: Vec<_> = recording
        .events
        .iter()
        .filter(|e| {
            matches!(
                e.event_type,
                CursorEventType::LeftClick { .. }
                    | CursorEventType::RightClick { .. }
                    | CursorEventType::MiddleClick { .. }
            )
        })
        .collect();

    if moves.is_empty() {
        return Vec::new();
    }

    let mut sim = SpringSimulation::new(DEFAULT_SPRING);
    let mut events: Vec<SmoothedCursorEvent> = Vec::with_capacity(moves.len() + 1);

    let mut primary_button_down = false;
    let mut click_index = 0;

    // Initialize at first position
    let first_pos = normalize_position(moves[0].x, moves[0].y, recording);
    sim.set_position(first_pos);
    sim.set_velocity(XY::default());

    let mut last_time_ms = 0u64;

    // Add initial event if there's time before first move
    if moves[0].timestamp_ms > 0 {
        events.push(SmoothedCursorEvent {
            time_ms: 0,
            target_position: first_pos,
            position: first_pos,
            velocity: XY::default(),
        });
    }

    for i in 0..moves.len() {
        let mov = &moves[i];
        let target_pos = normalize_position(mov.x, mov.y, recording);

        // Look ahead for next target
        let next_target = if i + 1 < moves.len() {
            normalize_position(moves[i + 1].x, moves[i + 1].y, recording)
        } else {
            target_pos
        };

        sim.set_target_position(next_target);

        // Update click state
        while click_index < clicks.len() && clicks[click_index].timestamp_ms <= mov.timestamp_ms {
            if let CursorEventType::LeftClick { pressed } = clicks[click_index].event_type {
                primary_button_down = pressed;
            }
            click_index += 1;
        }

        // Get appropriate spring profile
        let profile = get_spring_profile(mov.timestamp_ms, &clicks, primary_button_down);
        sim.set_config(profile);

        // Run simulation
        let dt = (mov.timestamp_ms - last_time_ms) as f32;
        sim.run(dt);
        last_time_ms = mov.timestamp_ms;

        events.push(SmoothedCursorEvent {
            time_ms: mov.timestamp_ms,
            target_position: next_target,
            position: sim.position,
            velocity: sim.velocity,
        });
    }

    events
}

/// Find the active cursor ID at a given timestamp.
fn get_active_cursor_id(events: &[CursorEvent], time_ms: u64) -> Option<String> {
    let mut active_cursor_id: Option<String> = None;

    for event in events {
        if event.timestamp_ms > time_ms {
            break;
        }
        if event.cursor_id.is_some() {
            active_cursor_id = event.cursor_id.clone();
        }
    }

    active_cursor_id
}

/// Interpolate smoothed position at a specific timestamp.
fn interpolate_at_time(
    events: &[SmoothedCursorEvent],
    time_ms: u64,
    cursor_id: Option<String>,
) -> InterpolatedCursor {
    if events.is_empty() {
        return InterpolatedCursor {
            cursor_id,
            ..Default::default()
        };
    }

    // Before first event
    if time_ms <= events[0].time_ms {
        let e = &events[0];
        return InterpolatedCursor {
            x: e.position.x,
            y: e.position.y,
            velocity_x: e.velocity.x,
            velocity_y: e.velocity.y,
            cursor_id,
        };
    }

    // After last event
    let last = &events[events.len() - 1];
    if time_ms >= last.time_ms {
        return InterpolatedCursor {
            x: last.position.x,
            y: last.position.y,
            velocity_x: last.velocity.x,
            velocity_y: last.velocity.y,
            cursor_id,
        };
    }

    // Find surrounding events and interpolate
    for i in 0..events.len() - 1 {
        let curr = &events[i];
        let next = &events[i + 1];

        if time_ms >= curr.time_ms && time_ms < next.time_ms {
            // Continue simulation from curr to exact time
            let mut sim = SpringSimulation::new(DEFAULT_SPRING);
            sim.set_position(curr.position);
            sim.set_velocity(curr.velocity);
            sim.set_target_position(curr.target_position);

            let dt = (time_ms - curr.time_ms) as f32;
            sim.run(dt);

            return InterpolatedCursor {
                x: sim.position.x,
                y: sim.position.y,
                velocity_x: sim.velocity.x,
                velocity_y: sim.velocity.y,
                cursor_id,
            };
        }
    }

    // Fallback
    InterpolatedCursor {
        x: last.position.x,
        y: last.position.y,
        velocity_x: last.velocity.x,
        velocity_y: last.velocity.y,
        cursor_id,
    }
}

/// Decode cursor images from base64 PNG to RGBA.
fn decode_cursor_images(
    cursor_images: &HashMap<String, CursorImage>,
) -> HashMap<String, DecodedCursorImage> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::ImageReader;
    use std::io::Cursor;

    let mut decoded = HashMap::new();

    for (id, img) in cursor_images {
        // Decode base64 to PNG bytes
        let png_bytes = match STANDARD.decode(&img.data_base64) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!("[CURSOR] Failed to decode base64 for cursor {}: {}", id, e);
                continue;
            },
        };

        // Decode PNG to RGBA
        let reader = match ImageReader::new(Cursor::new(&png_bytes)).with_guessed_format() {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[CURSOR] Failed to read cursor image {}: {}", id, e);
                continue;
            },
        };

        let image = match reader.decode() {
            Ok(img) => img.to_rgba8(),
            Err(e) => {
                log::warn!("[CURSOR] Failed to decode cursor image {}: {}", id, e);
                continue;
            },
        };

        decoded.insert(
            id.clone(),
            DecodedCursorImage {
                width: image.width(),
                height: image.height(),
                hotspot_x: img.hotspot_x,
                hotspot_y: img.hotspot_y,
                data: image.into_raw(),
            },
        );

        log::debug!(
            "[CURSOR] Decoded cursor image: {} ({}x{}, hotspot: {},{})",
            id,
            img.width,
            img.height,
            img.hotspot_x,
            img.hotspot_y
        );
    }

    decoded
}

/// Composite cursor image onto frame (CPU-based).
///
/// # Arguments
/// * `frame_data` - Mutable reference to frame RGBA data
/// * `frame_width` - Frame width in pixels
/// * `frame_height` - Frame height in pixels
/// * `cursor` - Interpolated cursor position (normalized 0-1)
/// * `cursor_image` - Decoded cursor image
/// * `scale` - Cursor scale factor (1.0 = native size)
pub fn composite_cursor(
    frame_data: &mut [u8],
    frame_width: u32,
    frame_height: u32,
    cursor: &InterpolatedCursor,
    cursor_image: &DecodedCursorImage,
    scale: f32,
) {
    // Convert normalized position to pixel position
    let pixel_x = cursor.x * frame_width as f32;
    let pixel_y = cursor.y * frame_height as f32;

    // Apply hotspot offset and scale
    let draw_x = pixel_x - (cursor_image.hotspot_x as f32 * scale);
    let draw_y = pixel_y - (cursor_image.hotspot_y as f32 * scale);

    let scaled_width = (cursor_image.width as f32 * scale).round() as i32;
    let scaled_height = (cursor_image.height as f32 * scale).round() as i32;

    // Simple alpha blending (nearest-neighbor for speed)
    for sy in 0..scaled_height {
        for sx in 0..scaled_width {
            // Calculate destination pixel
            let dst_x = (draw_x + sx as f32).round() as i32;
            let dst_y = (draw_y + sy as f32).round() as i32;

            // Bounds check
            if dst_x < 0 || dst_y < 0 || dst_x >= frame_width as i32 || dst_y >= frame_height as i32
            {
                continue;
            }

            // Calculate source pixel (nearest-neighbor scaling)
            let src_x = ((sx as f32 / scale).floor() as u32).min(cursor_image.width - 1);
            let src_y = ((sy as f32 / scale).floor() as u32).min(cursor_image.height - 1);

            let src_idx = ((src_y * cursor_image.width + src_x) * 4) as usize;
            let dst_idx = ((dst_y as u32 * frame_width + dst_x as u32) * 4) as usize;

            if src_idx + 3 >= cursor_image.data.len() || dst_idx + 3 >= frame_data.len() {
                continue;
            }

            // Get source pixel (cursor)
            let src_r = cursor_image.data[src_idx];
            let src_g = cursor_image.data[src_idx + 1];
            let src_b = cursor_image.data[src_idx + 2];
            let src_a = cursor_image.data[src_idx + 3];

            // Skip fully transparent pixels
            if src_a == 0 {
                continue;
            }

            // Alpha blending
            let alpha = src_a as f32 / 255.0;
            let inv_alpha = 1.0 - alpha;

            frame_data[dst_idx] =
                ((src_r as f32 * alpha) + (frame_data[dst_idx] as f32 * inv_alpha)) as u8;
            frame_data[dst_idx + 1] =
                ((src_g as f32 * alpha) + (frame_data[dst_idx + 1] as f32 * inv_alpha)) as u8;
            frame_data[dst_idx + 2] =
                ((src_b as f32 * alpha) + (frame_data[dst_idx + 2] as f32 * inv_alpha)) as u8;
            // Keep destination alpha (frame_data[dst_idx + 3])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spring_simulation() {
        let mut sim = SpringSimulation::new(DEFAULT_SPRING);
        sim.set_position(XY { x: 0.0, y: 0.0 });
        sim.set_target_position(XY { x: 1.0, y: 1.0 });

        // Run simulation for 1 second
        sim.run(1000.0);

        // Position should be close to target
        assert!((sim.position.x - 1.0).abs() < 0.1);
        assert!((sim.position.y - 1.0).abs() < 0.1);
    }

    #[test]
    fn test_interpolated_cursor_default() {
        let cursor = InterpolatedCursor::default();
        assert_eq!(cursor.x, 0.5);
        assert_eq!(cursor.y, 0.5);
        assert_eq!(cursor.velocity_x, 0.0);
        assert_eq!(cursor.velocity_y, 0.0);
        assert!(cursor.cursor_id.is_none());
    }
}
