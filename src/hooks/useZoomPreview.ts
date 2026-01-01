/**
 * useZoomPreview - Calculates CSS transforms for zoom preview.
 *
 * Ports the Rust zoom interpolation logic to TypeScript for real-time
 * preview in the video player using CSS transforms.
 *
 * Supports two zoom modes:
 * - Manual: Fixed zoom position (targetX/targetY)
 * - Auto: Follows cursor position during playback (like Cap)
 */

import { useMemo } from 'react';
import type { ZoomRegion, EasingFunction, CursorRecording } from '../types';
import { useCursorInterpolation, type InterpolatedCursor } from './useCursorInterpolation';

interface ZoomState {
  scale: number;
  centerX: number;
  centerY: number;
}

interface ZoomTransformStyle {
  transform: string;
  transformOrigin: string;
}

/**
 * Get cursor position for a region, using interpolated cursor if in auto mode.
 */
function getCursorPosition(
  region: ZoomRegion,
  timestampMs: number,
  getCursorAt: ((timeMs: number) => InterpolatedCursor) | null
): { x: number; y: number } {
  // If mode is 'auto' and we have cursor data, follow the cursor
  if (region.mode === 'auto' && getCursorAt) {
    const cursor = getCursorAt(timestampMs);
    return { x: cursor.x, y: cursor.y };
  }

  // Otherwise use fixed position
  return { x: region.targetX, y: region.targetY };
}

/**
 * Calculate the zoom state at a specific timestamp.
 *
 * @param regions - Zoom regions
 * @param timestampMs - Current playback time
 * @param getCursorAt - Optional cursor interpolation function for auto mode
 */
export function getZoomStateAt(
  regions: ZoomRegion[],
  timestampMs: number,
  getCursorAt?: ((timeMs: number) => InterpolatedCursor) | null
): ZoomState {
  const identity: ZoomState = { scale: 1, centerX: 0.5, centerY: 0.5 };

  if (!regions || regions.length === 0) {
    return identity;
  }

  // Sort regions by start time
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);

  for (let i = 0; i < sorted.length; i++) {
    const region = sorted[i];
    const transitionInStart = Math.max(0, region.startMs - region.transition.durationInMs);
    const transitionOutEnd = region.endMs + region.transition.durationOutMs;

    // Transition-in phase
    if (timestampMs >= transitionInStart && timestampMs < region.startMs) {
      const progress = (timestampMs - transitionInStart) / region.transition.durationInMs;
      const eased = applyEasing(progress, region.transition.easing);

      const prevState = i > 0 ? getRegionEndState(sorted[i - 1]) : identity;
      const targetState = getRegionState(region, timestampMs, getCursorAt);

      return interpolateZoom(prevState, targetState, eased);
    }

    // Active zoom phase
    if (timestampMs >= region.startMs && timestampMs <= region.endMs) {
      return getRegionState(region, timestampMs, getCursorAt);
    }

    // Transition-out phase
    if (timestampMs > region.endMs && timestampMs <= transitionOutEnd) {
      const progress = (timestampMs - region.endMs) / region.transition.durationOutMs;
      const eased = applyEasing(progress, region.transition.easing);

      const currentState = getRegionState(region, region.endMs, getCursorAt);
      const nextState = (i + 1 < sorted.length)
        ? getRegionState(sorted[i + 1], timestampMs, getCursorAt)
        : identity;

      return interpolateZoom(currentState, nextState, eased);
    }
  }

  return identity;
}

function getRegionState(
  region: ZoomRegion,
  timestampMs: number,
  getCursorAt?: ((timeMs: number) => InterpolatedCursor) | null
): ZoomState {
  const pos = getCursorPosition(region, timestampMs, getCursorAt ?? null);
  return {
    scale: region.scale,
    centerX: pos.x,
    centerY: pos.y,
  };
}

function getRegionEndState(_region: ZoomRegion): ZoomState {
  // After a region ends (past transition-out), return to identity
  // The region parameter is kept for potential future use (e.g., sticky zoom)
  return { scale: 1, centerX: 0.5, centerY: 0.5 };
}

function interpolateZoom(from: ZoomState, to: ZoomState, t: number): ZoomState {
  return {
    scale: lerp(from.scale, to.scale, t),
    centerX: lerp(from.centerX, to.centerX, t),
    centerY: lerp(from.centerY, to.centerY, t),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function applyEasing(t: number, easing: EasingFunction): number {
  switch (easing) {
    case 'linear':
      return t;
    case 'easeIn':
      return t * t * t;
    case 'easeOut':
      return 1 - Math.pow(1 - t, 3);
    case 'easeInOut':
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'smooth':
      return t * t * (3 - 2 * t);
    case 'snappy':
      return 1 - (1 - t) * (1 - t);
    case 'bouncy':
      if (t < 0.7) {
        const normalized = t / 0.7;
        return 1.1 * normalized * normalized;
      } else {
        const normalized = (t - 0.7) / 0.3;
        return 1.1 - 0.1 * (1 - Math.pow(1 - normalized, 2));
      }
    default:
      return t;
  }
}

/**
 * Convert zoom state to CSS transform properties.
 *
 * The transform simulates zooming into the video at the target position.
 * - scale: How much to zoom (1 = no zoom, 2 = 2x zoom)
 * - centerX/Y: Where to zoom (0-1 normalized, 0.5 = center)
 */
export function zoomStateToTransform(state: ZoomState): ZoomTransformStyle {
  if (state.scale <= 1.001) {
    return {
      transform: 'none',
      transformOrigin: 'center center',
    };
  }

  // Clamp center position to prevent showing empty areas at edges
  // At scale S, visible area is 1/S, so center must be between 0.5/S and 1-0.5/S
  const halfVisible = 0.5 / state.scale;
  const clampedCenterX = Math.max(halfVisible, Math.min(1 - halfVisible, state.centerX));
  const clampedCenterY = Math.max(halfVisible, Math.min(1 - halfVisible, state.centerY));

  // Calculate translation to keep the target point centered
  // When zoomed, we need to pan so the target (centerX, centerY) appears at screen center
  const translateX = (0.5 - clampedCenterX) * 100 * (state.scale - 1) / state.scale;
  const translateY = (0.5 - clampedCenterY) * 100 * (state.scale - 1) / state.scale;

  return {
    transform: `scale(${state.scale}) translate(${translateX}%, ${translateY}%)`,
    transformOrigin: `${clampedCenterX * 100}% ${clampedCenterY * 100}%`,
  };
}

/**
 * Hook to get zoom transform style for the current timestamp.
 *
 * For auto-zoom mode, this reads cursor recording from the video editor store
 * and uses spring-physics cursor interpolation for smooth following.
 */
export function useZoomPreview(
  regions: ZoomRegion[] | undefined,
  currentTimeMs: number,
  cursorRecording?: CursorRecording | null
): ZoomTransformStyle {
  // Use cursor interpolation for auto mode (with spring physics)
  const { getCursorAt, hasCursorData } = useCursorInterpolation(cursorRecording);

  return useMemo(() => {
    if (!regions || regions.length === 0) {
      return { transform: 'none', transformOrigin: 'center center' };
    }

    // Pass cursor interpolation function for auto mode regions
    const state = getZoomStateAt(
      regions,
      currentTimeMs,
      hasCursorData ? getCursorAt : null
    );
    return zoomStateToTransform(state);
  }, [regions, currentTimeMs, getCursorAt, hasCursorData]);
}

/**
 * Check if any zoom is active at the given timestamp.
 */
export function isZoomedAt(regions: ZoomRegion[] | undefined, timestampMs: number): boolean {
  if (!regions || regions.length === 0) return false;
  const state = getZoomStateAt(regions, timestampMs);
  return state.scale > 1.001;
}
