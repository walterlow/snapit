/**
 * usePlaybackEngine - Simple playback engine that updates Zustand store.
 *
 * Uses RAF to poll video.currentTime during playback and update the store.
 * Components subscribe to store.currentTimeMs for reactive updates.
 */

import { useCallback } from 'react';
import { useVideoEditorStore } from '../stores/videoEditorStore';

// Module-level state for RAF loop
let rafId: number | null = null;
let videoElement: HTMLVideoElement | null = null;
let isPlayingInternal = false;

/**
 * RAF loop that updates store with current video time.
 */
function rafLoop() {
  if (!isPlayingInternal) {
    rafId = null;
    return;
  }

  // Update store with current video time
  if (videoElement) {
    const timeMs = videoElement.currentTime * 1000;
    useVideoEditorStore.getState().setCurrentTime(timeMs);
  }

  // Continue loop
  rafId = requestAnimationFrame(rafLoop);
}

function startRAFLoop() {
  if (rafId !== null) return;
  isPlayingInternal = true;
  rafId = requestAnimationFrame(rafLoop);
}

function stopRAFLoop() {
  isPlayingInternal = false;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/**
 * Start the RAF loop for playback time updates.
 * Called by GPUVideoPreview when isPlaying becomes true.
 */
export function startPlaybackLoop() {
  startRAFLoop();
}

/**
 * Stop the RAF loop.
 * Called by GPUVideoPreview when isPlaying becomes false.
 */
export function stopPlaybackLoop() {
  stopRAFLoop();
}

/**
 * Hook for components that need the current playback time.
 * Returns preview time when scrubbing, otherwise current time from store.
 */
export function usePlaybackTime(): number {
  const currentTimeMs = useVideoEditorStore((s) => s.currentTimeMs);
  return currentTimeMs;
}

/**
 * Hook that returns preview time when scrubbing, or playback time otherwise.
 */
export function usePreviewOrPlaybackTime(): number {
  const currentTimeMs = useVideoEditorStore((s) => s.currentTimeMs);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);
  return previewTimeMs !== null ? previewTimeMs : currentTimeMs;
}

/**
 * Hook for components that need playback controls.
 * Uses module-level videoElement so all callers operate on the same video.
 */
export function usePlaybackControls() {
  const play = useCallback(() => {
    if (isPlayingInternal) return;
    isPlayingInternal = true;

    // Start video element (use module-level variable)
    videoElement?.play();

    // Start RAF loop to update store
    startRAFLoop();

    // Update store
    useVideoEditorStore.getState().setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    if (!isPlayingInternal) return;
    isPlayingInternal = false;

    // Stop RAF loop
    stopRAFLoop();

    // Pause video element (use module-level variable)
    videoElement?.pause();

    // Sync final time to store
    if (videoElement) {
      useVideoEditorStore.getState().setCurrentTime(videoElement.currentTime * 1000);
    }
    useVideoEditorStore.getState().setIsPlaying(false);
  }, []);

  const seek = useCallback((timeMs: number) => {
    const duration = useVideoEditorStore.getState().project?.timeline.durationMs ?? 0;
    const clampedTime = Math.max(0, Math.min(timeMs, duration));

    // Sync video element (use module-level variable)
    if (videoElement) {
      videoElement.currentTime = clampedTime / 1000;
    }

    // Update store
    useVideoEditorStore.getState().setCurrentTime(clampedTime);
  }, []);

  const toggle = useCallback(() => {
    if (isPlayingInternal) {
      pause();
    } else {
      play();
    }
  }, [play, pause]);

  const setDuration = useCallback((_ms: number) => {
    // Duration comes from project, no need to store separately
  }, []);

  const setVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoElement = el;
  }, []);

  const syncFromVideo = useCallback((_timeMs: number) => {
    // Not used anymore - RAF loop handles syncing
  }, []);

  return {
    play,
    pause,
    seek,
    toggle,
    setDuration,
    setVideoElement,
    syncFromVideo,
    isPlaying: () => isPlayingInternal,
    getCurrentTime: () => useVideoEditorStore.getState().currentTimeMs,
  };
}

/**
 * Initialize playback engine with project data.
 */
export function initPlaybackEngine(_projectDurationMs: number, initialTimeMs = 0) {
  stopRAFLoop();
  isPlayingInternal = false;
  useVideoEditorStore.getState().setCurrentTime(initialTimeMs);
}

/**
 * Reset playback engine state.
 */
export function resetPlaybackEngine() {
  stopRAFLoop();
  isPlayingInternal = false;
  videoElement = null;
  useVideoEditorStore.getState().setCurrentTime(0);
}

/**
 * Get current playback state.
 */
export function getPlaybackState() {
  const state = useVideoEditorStore.getState();
  return {
    currentTimeMs: state.currentTimeMs,
    isPlaying: state.isPlaying,
    durationMs: state.project?.timeline.durationMs ?? 0,
  };
}
