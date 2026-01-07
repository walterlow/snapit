/**
 * useCursorInterpolation - Smooth cursor position interpolation with spring physics.
 *
 * Implements cursor smoothing similar to Cap's approach:
 * 1. Spring-mass-damper physics for natural movement
 * 2. Different spring profiles (default, snappy near clicks, drag when held)
 * 3. Cursor movement densification for sparse data
 */

import { useMemo, useCallback } from 'react';
import type { CursorRecording, CursorEvent } from '../types';

// ============================================================================
// Spring Physics Configuration
// ============================================================================

interface SpringConfig {
  tension: number;   // Spring stiffness
  mass: number;      // Object mass
  friction: number;  // Damping coefficient
}

// Base spring configuration (tuned for smooth cursor following)
const DEFAULT_SPRING: SpringConfig = {
  tension: 180,
  mass: 1.0,
  friction: 26,
};

// Snappy profile - used within 160ms of a click (quick response)
const SNAPPY_SPRING: SpringConfig = {
  tension: DEFAULT_SPRING.tension * 1.65,
  mass: Math.max(DEFAULT_SPRING.mass * 0.65, 0.1),
  friction: DEFAULT_SPRING.friction * 1.25,
};

// Drag profile - used when mouse button is held down (less bouncy)
const DRAG_SPRING: SpringConfig = {
  tension: DEFAULT_SPRING.tension * 1.25,
  mass: Math.max(DEFAULT_SPRING.mass * 0.85, 0.1),
  friction: DEFAULT_SPRING.friction * 1.1,
};

// Time window for snappy response after click
const CLICK_REACTION_WINDOW_MS = 160;

// Simulation tick rate (60fps internal)
const SIMULATION_TICK_MS = 1000 / 60;

// Gap interpolation thresholds
const GAP_INTERPOLATION_THRESHOLD_MS = SIMULATION_TICK_MS * 4; // ~67ms
const MIN_CURSOR_TRAVEL_FOR_INTERPOLATION = 0.02; // 2% of screen
const MAX_INTERPOLATED_STEPS = 120;

// ============================================================================
// Types
// ============================================================================

interface XY {
  x: number;
  y: number;
}

interface SmoothedCursorEvent {
  timeMs: number;
  targetPosition: XY;
  position: XY;
  velocity: XY;
}

export interface InterpolatedCursor {
  /** Normalized position (0-1) */
  x: number;
  y: number;
  /** Velocity for motion blur effects */
  velocityX: number;
  velocityY: number;
  /** Active cursor image ID (references cursorImages map) */
  cursorId: string | null;
}

// ============================================================================
// Spring Physics Simulation
// ============================================================================

class SpringSimulation {
  private tension: number;
  private mass: number;
  private friction: number;

  position: XY = { x: 0, y: 0 };
  velocity: XY = { x: 0, y: 0 };
  targetPosition: XY = { x: 0, y: 0 };

  constructor(config: SpringConfig) {
    this.tension = config.tension;
    this.mass = config.mass;
    this.friction = config.friction;
  }

  setConfig(config: SpringConfig) {
    this.tension = config.tension;
    this.mass = config.mass;
    this.friction = config.friction;
  }

  setPosition(pos: XY) {
    this.position = { ...pos };
  }

  setVelocity(vel: XY) {
    this.velocity = { ...vel };
  }

  setTargetPosition(target: XY) {
    this.targetPosition = { ...target };
  }

  /**
   * Run simulation for given duration.
   * Uses fixed timestep internally for stability.
   */
  run(dtMs: number): XY {
    if (dtMs <= 0) return this.position;

    let remaining = dtMs;

    while (remaining > 0) {
      const stepMs = Math.min(remaining, SIMULATION_TICK_MS);
      const tick = stepMs / 1000;

      // Spring force: F = -k * (position - target)
      const dx = this.targetPosition.x - this.position.x;
      const dy = this.targetPosition.y - this.position.y;

      const springForceX = dx * this.tension;
      const springForceY = dy * this.tension;

      // Damping force: F = -c * velocity
      const dampingForceX = -this.velocity.x * this.friction;
      const dampingForceY = -this.velocity.y * this.friction;

      // Total force
      const totalForceX = springForceX + dampingForceX;
      const totalForceY = springForceY + dampingForceY;

      // Acceleration: a = F / m
      const mass = Math.max(this.mass, 0.001);
      const accelX = totalForceX / mass;
      const accelY = totalForceY / mass;

      // Update velocity and position
      this.velocity.x += accelX * tick;
      this.velocity.y += accelY * tick;
      this.position.x += this.velocity.x * tick;
      this.position.y += this.velocity.y * tick;

      remaining -= stepMs;
    }

    return this.position;
  }
}

// ============================================================================
// Cursor Data Processing
// ============================================================================

/**
 * Get position as XY from a cursor event.
 * Events already have normalized (0-1) coordinates.
 */
function getPosition(event: CursorEvent): XY {
  return { x: event.x, y: event.y };
}

/**
 * Check if we should fill the gap between two cursor events.
 * Events already have normalized (0-1) coordinates.
 */
function shouldFillGap(from: CursorEvent, to: CursorEvent): boolean {
  const dtMs = to.timestampMs - from.timestampMs;
  if (dtMs < GAP_INTERPOLATION_THRESHOLD_MS) {
    return false;
  }

  // Calculate distance (coordinates are already normalized 0-1)
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  return distance >= MIN_CURSOR_TRAVEL_FOR_INTERPOLATION;
}

/**
 * Densify cursor moves by inserting interpolated samples for large gaps.
 * This ensures smooth animation even with sparse input data.
 */
function densifyCursorMoves(events: CursorEvent[]): CursorEvent[] {
  if (events.length < 2) return events;

  // Filter to only move events for densification
  const moves = events.filter(e => e.eventType.type === 'move');
  if (moves.length < 2) return events;

  const requiresInterpolation = moves.some((move, i) => {
    if (i === 0) return false;
    return shouldFillGap(moves[i - 1], move);
  });

  if (!requiresInterpolation) return events;

  const denseMoves: CursorEvent[] = [moves[0]];

  for (let i = 0; i < moves.length - 1; i++) {
    const current = moves[i];
    const next = moves[i + 1];

    if (shouldFillGap(current, next)) {
      const dtMs = next.timestampMs - current.timestampMs;
      const segments = Math.min(
        Math.max(Math.ceil(dtMs / SIMULATION_TICK_MS), 2),
        MAX_INTERPOLATED_STEPS
      );

      for (let step = 1; step < segments; step++) {
        const t = step / segments;
        denseMoves.push({
          timestampMs: current.timestampMs + dtMs * t,
          x: current.x + (next.x - current.x) * t,
          y: current.y + (next.y - current.y) * t,
          eventType: { type: 'move' },
          cursorId: null,
        });
      }
    }

    denseMoves.push(next);
  }

  return denseMoves;
}

/**
 * Get spring profile based on click context.
 */
function getSpringProfile(
  timeMs: number,
  clicks: CursorEvent[],
  isPrimaryButtonDown: boolean
): SpringConfig {
  // Check for recent click
  const recentClick = clicks.find(
    c => Math.abs(timeMs - c.timestampMs) <= CLICK_REACTION_WINDOW_MS
  );

  if (recentClick) {
    return SNAPPY_SPRING;
  }

  if (isPrimaryButtonDown) {
    return DRAG_SPRING;
  }

  return DEFAULT_SPRING;
}

/**
 * Pre-compute smoothed cursor events for the entire recording.
 * This runs spring simulation once and caches results.
 */
function computeSmoothedEvents(
  recording: CursorRecording
): SmoothedCursorEvent[] {
  const moves = densifyCursorMoves(recording.events);
  const clicks = recording.events.filter(
    e => e.eventType.type === 'leftClick' ||
         e.eventType.type === 'rightClick' ||
         e.eventType.type === 'middleClick'
  );

  if (moves.length === 0) return [];

  const sim = new SpringSimulation(DEFAULT_SPRING);
  const events: SmoothedCursorEvent[] = [];

  // Track primary button state
  let primaryButtonDown = false;
  let clickIndex = 0;

  // Initialize at first position (events already have normalized 0-1 coords)
  const firstPos = getPosition(moves[0]);
  sim.setPosition(firstPos);
  sim.setVelocity({ x: 0, y: 0 });

  let lastTimeMs = 0;

  // Add initial event
  if (moves[0].timestampMs > 0) {
    events.push({
      timeMs: 0,
      targetPosition: firstPos,
      position: { ...firstPos },
      velocity: { x: 0, y: 0 },
    });
  }

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const targetPos = getPosition(move);

    // Look ahead for next target
    const nextTarget = moves[i + 1]
      ? getPosition(moves[i + 1])
      : targetPos;

    sim.setTargetPosition(nextTarget);

    // Update click state
    while (clickIndex < clicks.length && clicks[clickIndex].timestampMs <= move.timestampMs) {
      const click = clicks[clickIndex];
      if (click.eventType.type === 'leftClick') {
        primaryButtonDown = (click.eventType as { type: 'leftClick'; pressed: boolean }).pressed;
      }
      clickIndex++;
    }

    // Get appropriate spring profile
    const profile = getSpringProfile(move.timestampMs, clicks, primaryButtonDown);
    sim.setConfig(profile);

    // Run simulation
    const dt = move.timestampMs - lastTimeMs;
    sim.run(dt);
    lastTimeMs = move.timestampMs;

    events.push({
      timeMs: move.timestampMs,
      targetPosition: nextTarget,
      position: { ...sim.position },
      velocity: { ...sim.velocity },
    });
  }

  return events;
}

/**
 * Find the active cursor ID at a given timestamp.
 * Returns the cursor ID from the most recent event with a non-null cursorId.
 */
function getActiveCursorId(
  events: CursorEvent[],
  timeMs: number
): string | null {
  let activeCursorId: string | null = null;
  
  for (const event of events) {
    if (event.timestampMs > timeMs) break;
    if (event.cursorId !== null) {
      activeCursorId = event.cursorId;
    }
  }
  
  return activeCursorId;
}

/**
 * Interpolate smoothed position at a specific timestamp.
 */
function interpolateAtTime(
  events: SmoothedCursorEvent[],
  timeMs: number,
  cursorId: string | null
): InterpolatedCursor {
  if (events.length === 0) {
    return { x: 0.5, y: 0.5, velocityX: 0, velocityY: 0, cursorId };
  }

  // Before first event
  if (timeMs <= events[0].timeMs) {
    const e = events[0];
    return {
      x: e.position.x,
      y: e.position.y,
      velocityX: e.velocity.x,
      velocityY: e.velocity.y,
      cursorId,
    };
  }

  // After last event
  const last = events[events.length - 1];
  if (timeMs >= last.timeMs) {
    return {
      x: last.position.x,
      y: last.position.y,
      velocityX: last.velocity.x,
      velocityY: last.velocity.y,
      cursorId,
    };
  }

  // Find surrounding events and interpolate
  for (let i = 0; i < events.length - 1; i++) {
    const curr = events[i];
    const next = events[i + 1];

    if (timeMs >= curr.timeMs && timeMs < next.timeMs) {
      // Continue simulation from curr to exact time
      const sim = new SpringSimulation(DEFAULT_SPRING);
      sim.setPosition(curr.position);
      sim.setVelocity(curr.velocity);
      sim.setTargetPosition(curr.targetPosition);

      const dt = timeMs - curr.timeMs;
      sim.run(dt);

      return {
        x: sim.position.x,
        y: sim.position.y,
        velocityX: sim.velocity.x,
        velocityY: sim.velocity.y,
        cursorId,
      };
    }
  }

  // Fallback
  return {
    x: last.position.x,
    y: last.position.y,
    velocityX: last.velocity.x,
    velocityY: last.velocity.y,
    cursorId,
  };
}

// ============================================================================
// React Hook
// ============================================================================

/**
 * Hook to get interpolated cursor position with spring smoothing.
 *
 * @param cursorRecording - The cursor recording data
 * @returns A function to get interpolated cursor position at any timestamp
 */
export function useCursorInterpolation(
  cursorRecording: CursorRecording | null | undefined
) {
  // Pre-compute smoothed events once
  const smoothedEvents = useMemo(() => {
    if (!cursorRecording || cursorRecording.events.length === 0) {
      return [];
    }
    return computeSmoothedEvents(cursorRecording);
  }, [cursorRecording]);

  // Cache original events for cursor ID lookup
  const originalEvents = useMemo(() => {
    return cursorRecording?.events ?? [];
  }, [cursorRecording]);

  // Get fallback cursor ID from available cursor images
  // This handles old recordings where early events might not have cursor_id
  const fallbackCursorId = useMemo(() => {
    const images = cursorRecording?.cursorImages ?? {};
    const keys = Object.keys(images);
    return keys.length > 0 ? keys[0] : null;
  }, [cursorRecording?.cursorImages]);

  // Return interpolation function
  const getCursorAt = useCallback(
    (timeMs: number): InterpolatedCursor => {
      const cursorId = getActiveCursorId(originalEvents, timeMs) ?? fallbackCursorId;
      return interpolateAtTime(smoothedEvents, timeMs, cursorId);
    },
    [smoothedEvents, originalEvents, fallbackCursorId]
  );

  return {
    getCursorAt,
    hasCursorData: smoothedEvents.length > 0,
    cursorImages: cursorRecording?.cursorImages ?? {},
  };
}

/**
 * Get cursor position at a specific time without spring smoothing.
 * Useful for quick lookups or when performance is critical.
 */
export function getRawCursorAt(
  recording: CursorRecording | null | undefined,
  timeMs: number
): InterpolatedCursor {
  if (!recording || recording.events.length === 0) {
    return { x: 0.5, y: 0.5, velocityX: 0, velocityY: 0, cursorId: null };
  }

  const moves = recording.events.filter(e => e.eventType.type === 'move');
  if (moves.length === 0) {
    return { x: 0.5, y: 0.5, velocityX: 0, velocityY: 0, cursorId: null };
  }

  // Find the event closest to but not after timeMs
  let closest = moves[0];
  for (const move of moves) {
    if (move.timestampMs <= timeMs) {
      closest = move;
    } else {
      break;
    }
  }

  // Get cursor ID with fallback to first available image
  let cursorId = getActiveCursorId(recording.events, timeMs);
  if (cursorId === null && recording.cursorImages) {
    const keys = Object.keys(recording.cursorImages);
    if (keys.length > 0) {
      cursorId = keys[0];
    }
  }

  // Events already have normalized (0-1) coordinates
  return {
    x: closest.x,
    y: closest.y,
    velocityX: 0,
    velocityY: 0,
    cursorId,
  };
}
