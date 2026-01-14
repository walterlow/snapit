/**
 * useSceneMode - Gets interpolated scene state at the current timestamp.
 *
 * Ports Cap's scene interpolation logic for smooth transitions between modes.
 * Uses bezier easing for natural-feeling transitions.
 *
 * Scene modes control what is displayed:
 * - default: Screen with webcam overlay
 * - cameraOnly: Fullscreen webcam (blur/fade screen)
 * - screenOnly: Screen only (hide webcam)
 */

import { useMemo } from 'react';
import type { SceneSegment, SceneMode } from '../types';

/** Scene transition duration in seconds (matches Cap) */
const SCENE_TRANSITION_DURATION = 0.3;
/** Minimum gap to trigger a transition through default mode */
const MIN_GAP_FOR_TRANSITION = 0.5;

// ============================================================================
// Bezier Easing - Proper cubic bezier implementation
// ============================================================================

/**
 * Attempt to solve the cubic bezier curve for a given t value.
 * Uses Newton-Raphson iteration for accuracy (same approach as bezier-easing crate).
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const sampleCurveX = (t: number): number => {
    return ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t;
  };
  
  const sampleCurveY = (t: number): number => {
    return ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t;
  };
  
  const sampleCurveDerivativeX = (t: number): number => {
    return (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1;
  };
  
  const solveCurveX = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const xEstimate = sampleCurveX(t) - x;
      if (Math.abs(xEstimate) < 1e-6) return t;
      const derivative = sampleCurveDerivativeX(t);
      if (Math.abs(derivative) < 1e-6) break;
      t = t - xEstimate / derivative;
    }
    let lo = 0, hi = 1;
    t = x;
    while (lo < hi) {
      const xEstimate = sampleCurveX(t);
      if (Math.abs(xEstimate - x) < 1e-6) return t;
      if (x > xEstimate) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  
  return (x: number): number => {
    if (x === 0 || x === 1) return x;
    return sampleCurveY(solveCurveX(x));
  };
}

// CSS ease-in-out: cubic-bezier(0.42, 0, 0.58, 1)
const easeInOutCurve = cubicBezier(0.42, 0.0, 0.58, 1.0);

/**
 * CSS ease-in-out bezier curve: cubic-bezier(0.42, 0, 0.58, 1)
 */
function easeInOut(t: number): number {
  return easeInOutCurve(t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ============================================================================
// Scene Cursor (tracks position in scene timeline)
// ============================================================================

interface SceneSegmentsCursor {
  timeS: number;
  segment: SceneSegment | null;
  prevSegment: SceneSegment | null;
  segments: SceneSegment[];
}

function createSceneCursor(timeS: number, segments: SceneSegment[]): SceneSegmentsCursor {
  const timeMs = timeS * 1000;
  
  // Find active segment
  const activeIdx = segments.findIndex(s => timeMs >= s.startMs && timeMs < s.endMs);
  
  if (activeIdx >= 0) {
    return {
      timeS,
      segment: segments[activeIdx],
      prevSegment: activeIdx > 0 ? segments[activeIdx - 1] : null,
      segments,
    };
  }

  // Not in a segment - find previous segment
  let prevSegment: SceneSegment | null = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].endMs / 1000 <= timeS) {
      prevSegment = segments[i];
      break;
    }
  }

  return {
    timeS,
    segment: null,
    prevSegment,
    segments,
  };
}

function getNextSegment(cursor: SceneSegmentsCursor): SceneSegment | null {
  const timeMs = cursor.timeS * 1000;
  return cursor.segments.find(s => s.startMs > timeMs) ?? null;
}

// ============================================================================
// Interpolated Scene (Cap's approach)
// ============================================================================

export interface InterpolatedScene {
  /** Webcam opacity (0-1) */
  cameraOpacity: number;
  /** Screen opacity (0-1) */
  screenOpacity: number;
  /** Webcam scale factor */
  cameraScale: number;
  /** Current scene mode (for discrete decisions) */
  sceneMode: SceneMode;
  /** Transition progress (0-1) */
  transitionProgress: number;
  /** Mode transitioning from */
  fromMode: SceneMode;
  /** Mode transitioning to */
  toMode: SceneMode;
  /** Screen blur amount (0-1) for camera-only transitions */
  screenBlur: number;
  /** Camera zoom during camera-only transition */
  cameraOnlyZoom: number;
  /** Camera blur during camera-only transition */
  cameraOnlyBlur: number;
}

function getSceneValues(mode: SceneMode): { cameraOpacity: number; screenOpacity: number; cameraScale: number } {
  switch (mode) {
    case 'default':
      return { cameraOpacity: 1, screenOpacity: 1, cameraScale: 1 };
    case 'cameraOnly':
      return { cameraOpacity: 1, screenOpacity: 1, cameraScale: 1 };
    case 'screenOnly':
      return { cameraOpacity: 0, screenOpacity: 1, cameraScale: 1 };
    default:
      return { cameraOpacity: 1, screenOpacity: 1, cameraScale: 1 };
  }
}

function fromSingleMode(mode: SceneMode): InterpolatedScene {
  const values = getSceneValues(mode);
  return {
    cameraOpacity: values.cameraOpacity,
    screenOpacity: values.screenOpacity,
    cameraScale: values.cameraScale,
    sceneMode: mode,
    transitionProgress: 1,
    fromMode: mode,
    toMode: mode,
    screenBlur: 0,
    cameraOnlyZoom: 1,
    cameraOnlyBlur: 0,
  };
}

function isSameMode(a: SceneMode, b: SceneMode): boolean {
  return a === b;
}

/**
 * Interpolate scene state at the given cursor position.
 */
function interpolateScene(cursor: SceneSegmentsCursor): InterpolatedScene {
  const { timeS, segment, prevSegment } = cursor;

  // Determine current mode, next mode, and transition progress
  let currentMode: SceneMode = 'default';
  let nextMode: SceneMode = 'default';
  let transitionProgress = 1;

  if (segment) {
    const transitionStart = segment.startMs / 1000 - SCENE_TRANSITION_DURATION;
    const transitionEnd = segment.endMs / 1000 - SCENE_TRANSITION_DURATION;

    if (timeS < segment.startMs / 1000 && timeS >= transitionStart) {
      // Transitioning into segment
      const prevMode = prevSegment ? (() => {
        const gap = segment.startMs / 1000 - prevSegment.endMs / 1000;
        if (gap < MIN_GAP_FOR_TRANSITION && isSameMode(prevSegment.mode, segment.mode)) {
          return null; // Skip transition for small gaps between same modes
        }
        return gap > 0.01 ? 'default' : prevSegment.mode;
      })() : 'default';

      if (prevMode === null) {
        return fromSingleMode(segment.mode);
      }

      const progress = (timeS - transitionStart) / SCENE_TRANSITION_DURATION;
      currentMode = prevMode as SceneMode;
      nextMode = segment.mode;
      transitionProgress = easeInOut(Math.min(1, Math.max(0, progress)));
    } else if (timeS >= transitionEnd && timeS < segment.endMs / 1000) {
      // Transitioning out of segment
      const nextSeg = getNextSegment(cursor);
      if (nextSeg) {
        const gap = nextSeg.startMs / 1000 - segment.endMs / 1000;
        if (gap < MIN_GAP_FOR_TRANSITION && isSameMode(segment.mode, nextSeg.mode)) {
          // Keep current mode
          currentMode = segment.mode;
          nextMode = segment.mode;
          transitionProgress = 1;
        } else if (gap > 0.01) {
          // Transition to default
          const progress = (timeS - transitionEnd) / SCENE_TRANSITION_DURATION;
          currentMode = segment.mode;
          nextMode = 'default';
          transitionProgress = easeInOut(Math.min(1, progress));
        } else {
          // Direct transition to next segment
          const progress = (timeS - transitionEnd) / SCENE_TRANSITION_DURATION;
          currentMode = segment.mode;
          nextMode = nextSeg.mode;
          transitionProgress = easeInOut(Math.min(1, progress));
        }
      } else {
        // No next segment, transition to default
        const progress = (timeS - transitionEnd) / SCENE_TRANSITION_DURATION;
        currentMode = segment.mode;
        nextMode = 'default';
        transitionProgress = easeInOut(Math.min(1, progress));
      }
    } else {
      // Fully in segment
      currentMode = segment.mode;
      nextMode = segment.mode;
      transitionProgress = 1;
    }
  } else {
    // Not in a segment
    const nextSeg = getNextSegment(cursor);
    if (nextSeg) {
      const transitionStart = nextSeg.startMs / 1000 - SCENE_TRANSITION_DURATION;

      if (prevSegment) {
        const gap = nextSeg.startMs / 1000 - prevSegment.endMs / 1000;
        if (gap < MIN_GAP_FOR_TRANSITION && isSameMode(prevSegment.mode, nextSeg.mode)) {
          // Stay in previous mode
          currentMode = prevSegment.mode;
          nextMode = prevSegment.mode;
          transitionProgress = 1;
        } else if (timeS >= transitionStart) {
          // Transitioning into next segment
          const prevMode = gap > 0.01 ? 'default' : prevSegment.mode;
          const progress = (timeS - transitionStart) / SCENE_TRANSITION_DURATION;
          currentMode = prevMode as SceneMode;
          nextMode = nextSeg.mode;
          transitionProgress = easeInOut(Math.min(1, Math.max(0, progress)));
        } else {
          // In gap, at default
          currentMode = 'default';
          nextMode = 'default';
          transitionProgress = 1;
        }
      } else if (timeS >= transitionStart) {
        // No previous segment, transitioning into first segment
        const progress = (timeS - transitionStart) / SCENE_TRANSITION_DURATION;
        currentMode = 'default';
        nextMode = nextSeg.mode;
        transitionProgress = easeInOut(Math.min(1, Math.max(0, progress)));
      }
    }
    // else: no segments, stay at default
  }

  // Calculate interpolated values
  const startValues = getSceneValues(currentMode);
  const endValues = getSceneValues(nextMode);

  const cameraOpacity = lerp(startValues.cameraOpacity, endValues.cameraOpacity, transitionProgress);
  const screenOpacity = lerp(startValues.screenOpacity, endValues.screenOpacity, transitionProgress);
  const cameraScale = lerp(startValues.cameraScale, endValues.cameraScale, transitionProgress);

  // Screen blur for camera-only transitions
  let screenBlur = 0;
  if (currentMode === 'cameraOnly' || nextMode === 'cameraOnly') {
    if (currentMode === 'cameraOnly' && nextMode !== 'cameraOnly') {
      screenBlur = lerp(1, 0, transitionProgress);
    } else if (currentMode !== 'cameraOnly' && nextMode === 'cameraOnly') {
      screenBlur = transitionProgress;
    }
  }

  // Camera zoom during camera-only transition (disabled - just fade)
  const cameraOnlyZoom = 1;

  // Camera blur during camera-only transition
  let cameraOnlyBlur = 0;
  if (nextMode === 'cameraOnly' && currentMode !== 'cameraOnly') {
    cameraOnlyBlur = lerp(1, 0, transitionProgress);
  } else if (currentMode === 'cameraOnly' && nextMode !== 'cameraOnly') {
    cameraOnlyBlur = transitionProgress;
  }

  return {
    cameraOpacity,
    screenOpacity,
    cameraScale,
    sceneMode: transitionProgress > 0.5 ? nextMode : currentMode,
    transitionProgress,
    fromMode: currentMode,
    toMode: nextMode,
    screenBlur,
    cameraOnlyZoom,
    cameraOnlyBlur,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get interpolated scene state at a specific timestamp.
 */
export function getInterpolatedSceneAt(
  segments: SceneSegment[],
  _defaultMode: SceneMode,
  timestampMs: number
): InterpolatedScene {
  if (!segments || segments.length === 0) {
    return fromSingleMode('default');
  }

  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const timeS = timestampMs / 1000;
  const cursor = createSceneCursor(timeS, sorted);

  return interpolateScene(cursor);
}

/**
 * Get the simple scene mode at a specific timestamp (no interpolation).
 * Kept for backward compatibility.
 */
export function getSceneModeAt(
  segments: SceneSegment[],
  defaultMode: SceneMode,
  timestampMs: number
): SceneMode {
  if (!segments || segments.length === 0) {
    return defaultMode;
  }

  for (const segment of segments) {
    if (timestampMs >= segment.startMs && timestampMs <= segment.endMs) {
      return segment.mode;
    }
  }

  return defaultMode;
}

/**
 * Hook to get the simple scene mode (backward compatible).
 */
export function useSceneMode(
  segments: SceneSegment[] | undefined,
  defaultMode: SceneMode | undefined,
  currentTimeMs: number
): SceneMode {
  return useMemo(() => {
    const mode = defaultMode ?? 'default';
    if (!segments || segments.length === 0) {
      return mode;
    }
    return getSceneModeAt(segments, mode, currentTimeMs);
  }, [segments, defaultMode, currentTimeMs]);
}

/**
 * Hook to get interpolated scene state with smooth transitions.
 */
export function useInterpolatedScene(
  segments: SceneSegment[] | undefined,
  defaultMode: SceneMode | undefined,
  currentTimeMs: number
): InterpolatedScene {
  return useMemo(() => {
    const mode = defaultMode ?? 'default';
    if (!segments || segments.length === 0) {
      return fromSingleMode(mode);
    }
    return getInterpolatedSceneAt(segments, mode, currentTimeMs);
  }, [segments, defaultMode, currentTimeMs]);
}

// ============================================================================
// Helper methods for InterpolatedScene
// ============================================================================

export function shouldRenderCamera(scene: InterpolatedScene): boolean {
  return scene.cameraOpacity > 0.01;
}

export function shouldRenderScreen(scene: InterpolatedScene): boolean {
  return scene.screenOpacity > 0.01 || scene.screenBlur > 0.01;
}

export function isTransitioningCameraOnly(scene: InterpolatedScene): boolean {
  return scene.fromMode === 'cameraOnly' || scene.toMode === 'cameraOnly';
}

export function getCameraOnlyTransitionOpacity(scene: InterpolatedScene): number {
  if (scene.fromMode === 'cameraOnly' && scene.toMode !== 'cameraOnly') {
    return 1 - scene.transitionProgress;
  } else if (scene.fromMode !== 'cameraOnly' && scene.toMode === 'cameraOnly') {
    return scene.transitionProgress;
  } else if (scene.fromMode === 'cameraOnly' && scene.toMode === 'cameraOnly') {
    return 1;
  }
  return 0;
}

export function getRegularCameraTransitionOpacity(scene: InterpolatedScene): number {
  if (scene.toMode === 'cameraOnly' && scene.fromMode !== 'cameraOnly') {
    const fastFade = Math.max(0, 1 - scene.transitionProgress * 1.5);
    return fastFade * scene.cameraOpacity;
  } else if (scene.fromMode === 'cameraOnly' && scene.toMode !== 'cameraOnly') {
    const fastFade = Math.min(1, scene.transitionProgress * 1.5);
    return fastFade * scene.cameraOpacity;
  } else if (scene.fromMode === 'cameraOnly' && scene.toMode === 'cameraOnly') {
    return 0;
  }
  return scene.cameraOpacity;
}

/**
 * Should cursor and click highlights be rendered?
 * Returns false when in Camera Only mode (cursor makes no sense without screen content).
 */
export function shouldRenderCursor(scene: InterpolatedScene): boolean {
  // Don't render cursor when fully in cameraOnly mode
  if (scene.fromMode === 'cameraOnly' && scene.toMode === 'cameraOnly') {
    return false;
  }
  // Don't render cursor when transitioning TO cameraOnly (fade out with screen)
  if (scene.toMode === 'cameraOnly') {
    return scene.transitionProgress < 0.5;
  }
  // Don't render cursor when transitioning FROM cameraOnly until screen is visible
  if (scene.fromMode === 'cameraOnly') {
    return scene.transitionProgress > 0.5;
  }
  // Otherwise, render cursor when screen is visible
  return shouldRenderScreen(scene);
}
