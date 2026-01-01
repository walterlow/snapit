/**
 * useSceneMode - Gets the active scene mode at the current timestamp.
 *
 * Scene modes control what is displayed:
 * - default: Screen with webcam overlay
 * - cameraOnly: Fullscreen webcam (hide screen)
 * - screenOnly: Screen only (hide webcam)
 */

import { useMemo } from 'react';
import type { SceneSegment, SceneMode } from '../types';

/**
 * Get the active scene mode at a specific timestamp.
 */
export function getSceneModeAt(
  segments: SceneSegment[],
  defaultMode: SceneMode,
  timestampMs: number
): SceneMode {
  if (!segments || segments.length === 0) {
    return defaultMode;
  }

  // Find segment that contains the current timestamp
  for (const segment of segments) {
    if (timestampMs >= segment.startMs && timestampMs <= segment.endMs) {
      return segment.mode;
    }
  }

  return defaultMode;
}

/**
 * Hook to get the scene mode at the current timestamp.
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
