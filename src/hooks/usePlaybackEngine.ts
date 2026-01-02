/**
 * usePlaybackEngine - High-performance playback engine using RAF.
 *
 * Avoids React re-renders during playback by:
 * 1. Storing current time in a ref (not state)
 * 2. Using requestAnimationFrame for 60fps updates during playback
 * 3. Only syncing to Zustand store when paused/seeking
 * 4. Providing callback-based subscriptions for components that need time
 */

import { useRef, useCallback, useSyncExternalStore } from 'react';
import { useVideoEditorStore } from '../stores/videoEditorStore';

// Singleton playback state (outside React)
let currentTimeMs = 0;
let isPlaying = false;
let durationMs = 0;
let rafId: number | null = null;
let videoElement: HTMLVideoElement | null = null;

// For smooth time interpolation during playback
let playbackStartWallTime = 0;  // performance.now() when play started
let playbackStartVideoTime = 0; // video time (ms) when play started
let lastVideoSyncTime = 0;      // Last time we synced with video.currentTime

const subscribers = new Set<() => void>();

/**
 * RAF loop that interpolates time for smooth 60fps animation.
 *
 * Instead of polling video.currentTime (which only updates at video frame rate),
 * we interpolate based on wall clock time since playback started.
 * Periodically re-sync with video.currentTime to correct any drift.
 */
function rafLoop() {
  if (!isPlaying) {
    rafId = null;
    return;
  }

  const now = performance.now();

  // Interpolate time based on wall clock
  const elapsed = now - playbackStartWallTime;
  let interpolatedTimeMs = playbackStartVideoTime + elapsed;

  // Clamp to duration
  interpolatedTimeMs = Math.min(interpolatedTimeMs, durationMs);

  // Periodically sync with actual video time to correct drift (every 500ms)
  // Only if we have a video element to sync with
  if (videoElement && now - lastVideoSyncTime > 500) {
    const actualVideoTimeMs = videoElement.currentTime * 1000;
    const drift = Math.abs(interpolatedTimeMs - actualVideoTimeMs);

    // If drift is significant (>100ms), resync our reference point
    if (drift > 100) {
      playbackStartWallTime = now;
      playbackStartVideoTime = actualVideoTimeMs;
      interpolatedTimeMs = actualVideoTimeMs;
    }
    lastVideoSyncTime = now;
  }

  // Update current time
  currentTimeMs = interpolatedTimeMs;
  notifySubscribers();

  // Continue loop
  rafId = requestAnimationFrame(rafLoop);
}

function startRAFLoop() {
  if (rafId !== null) return; // Already running

  // Initialize interpolation reference points
  playbackStartWallTime = performance.now();
  playbackStartVideoTime = videoElement ? videoElement.currentTime * 1000 : currentTimeMs;
  lastVideoSyncTime = playbackStartWallTime;

  rafId = requestAnimationFrame(rafLoop);
}

function stopRAFLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  // Keep currentTimeMs as-is (the interpolated value)
  // Don't reset to video.currentTime which may lag behind
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function getSnapshot() {
  return currentTimeMs;
}

function notifySubscribers() {
  subscribers.forEach(cb => cb());
}

/**
 * Hook for components that need the current playback time at 60fps.
 * Uses useSyncExternalStore for tear-free reads.
 */
export function usePlaybackTime(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Hook that returns preview time when scrubbing, or playback time otherwise.
 * Use this for video elements that should sync with timeline scrubbing.
 */
export function usePreviewOrPlaybackTime(): number {
  const playbackTime = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);

  // Return preview time if scrubbing, otherwise playback time
  return previewTimeMs !== null ? previewTimeMs : playbackTime;
}

/**
 * Hook for components that need playback controls.
 * Returns stable functions that don't cause re-renders.
 */
export function usePlaybackControls() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const play = useCallback(() => {
    if (isPlaying) return;
    isPlaying = true;

    // Start video element
    videoRef.current?.play();

    // Start RAF loop for 60fps time updates (instead of relying on ~4Hz timeupdate)
    startRAFLoop();

    // Sync to store (for UI that shows play/pause state)
    useVideoEditorStore.getState().setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    if (!isPlaying) return;
    isPlaying = false;

    // Stop RAF loop (keeps currentTimeMs at interpolated value)
    stopRAFLoop();

    // Pause video element and sync it to our interpolated time
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = currentTimeMs / 1000;
    }

    // Sync final time to store
    useVideoEditorStore.getState().setIsPlaying(false);
    useVideoEditorStore.getState().setCurrentTime(currentTimeMs);
  }, []);
  
  const seek = useCallback((timeMs: number) => {
    const clampedTime = Math.max(0, Math.min(timeMs, durationMs));
    currentTimeMs = clampedTime;
    
    // Sync video element
    if (videoRef.current) {
      videoRef.current.currentTime = clampedTime / 1000;
    }
    
    // Notify subscribers
    notifySubscribers();
    
    // Sync to store if paused
    if (!isPlaying) {
      useVideoEditorStore.getState().setCurrentTime(clampedTime);
    }
  }, []);
  
  const toggle = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [play, pause]);
  
  const setDuration = useCallback((ms: number) => {
    durationMs = ms;
  }, []);
  
  const setVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    videoElement = el; // Store for RAF loop access
  }, []);
  
  const syncFromVideo = useCallback((timeMs: number) => {
    // During playback, we use interpolation for smooth animation.
    // The RAF loop handles drift correction, so ignore timeupdate events.
    if (isPlaying) return;

    // During preview (hover scrubbing), don't update the red playhead position.
    // The video seeks to show the preview, but the playhead should stay put.
    const previewTimeMs = useVideoEditorStore.getState().previewTimeMs;
    if (previewTimeMs !== null) return;

    // When paused and not previewing, sync directly from video
    currentTimeMs = timeMs;
    notifySubscribers();
  }, []);
  
  return {
    play,
    pause,
    seek,
    toggle,
    setDuration,
    setVideoElement,
    syncFromVideo,
    isPlaying: () => isPlaying,
    getCurrentTime: () => currentTimeMs,
  };
}

/**
 * Initialize playback engine with project data.
 * Call this when project loads.
 */
export function initPlaybackEngine(projectDurationMs: number, initialTimeMs = 0) {
  stopRAFLoop(); // Stop any existing loop
  durationMs = projectDurationMs;
  currentTimeMs = initialTimeMs;
  isPlaying = false;
  notifySubscribers();
}

/**
 * Reset playback engine state.
 * Call this when project unloads.
 */
export function resetPlaybackEngine() {
  stopRAFLoop();
  currentTimeMs = 0;
  isPlaying = false;
  durationMs = 0;
  videoElement = null;
  notifySubscribers();
}

/**
 * Get current playback state without subscribing.
 * Useful for one-off reads in event handlers.
 */
export function getPlaybackState() {
  return {
    currentTimeMs,
    isPlaying,
    durationMs,
  };
}
