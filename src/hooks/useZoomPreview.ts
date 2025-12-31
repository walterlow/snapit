/**
 * useZoomPreview - Calculates CSS transforms for zoom preview.
 * 
 * Ports the Rust zoom interpolation logic to TypeScript for real-time
 * preview in the video player using CSS transforms.
 */

import { useMemo } from 'react';
import type { ZoomRegion, EasingFunction } from '../types';

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
 * Calculate the zoom state at a specific timestamp.
 */
export function getZoomStateAt(
  regions: ZoomRegion[],
  timestampMs: number
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
      const targetState = getRegionState(region);
      
      return interpolateZoom(prevState, targetState, eased);
    }

    // Active zoom phase
    if (timestampMs >= region.startMs && timestampMs <= region.endMs) {
      return getRegionState(region);
    }

    // Transition-out phase
    if (timestampMs > region.endMs && timestampMs <= transitionOutEnd) {
      const progress = (timestampMs - region.endMs) / region.transition.durationOutMs;
      const eased = applyEasing(progress, region.transition.easing);
      
      const currentState = getRegionState(region);
      const nextState = (i + 1 < sorted.length) 
        ? getRegionState(sorted[i + 1])
        : identity;
      
      return interpolateZoom(currentState, nextState, eased);
    }
  }

  return identity;
}

function getRegionState(region: ZoomRegion): ZoomState {
  return {
    scale: region.scale,
    centerX: region.targetX,
    centerY: region.targetY,
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

  // Calculate translation to keep the target point centered
  // When zoomed, we need to pan so the target (centerX, centerY) appears at screen center
  const translateX = (0.5 - state.centerX) * 100 * (state.scale - 1) / state.scale;
  const translateY = (0.5 - state.centerY) * 100 * (state.scale - 1) / state.scale;

  return {
    transform: `scale(${state.scale}) translate(${translateX}%, ${translateY}%)`,
    transformOrigin: `${state.centerX * 100}% ${state.centerY * 100}%`,
  };
}

/**
 * Hook to get zoom transform style for the current timestamp.
 */
export function useZoomPreview(
  regions: ZoomRegion[] | undefined,
  currentTimeMs: number
): ZoomTransformStyle {
  return useMemo(() => {
    if (!regions || regions.length === 0) {
      return { transform: 'none', transformOrigin: 'center center' };
    }
    
    const state = getZoomStateAt(regions, currentTimeMs);
    return zoomStateToTransform(state);
  }, [regions, currentTimeMs]);
}

/**
 * Check if any zoom is active at the given timestamp.
 */
export function isZoomedAt(regions: ZoomRegion[] | undefined, timestampMs: number): boolean {
  if (!regions || regions.length === 0) return false;
  const state = getZoomStateAt(regions, timestampMs);
  return state.scale > 1.001;
}
