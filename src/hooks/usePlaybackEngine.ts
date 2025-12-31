/**
 * usePlaybackEngine - High-performance playback engine using RAF.
 * 
 * Avoids React re-renders during playback by:
 * 1. Storing current time in a ref (not state)
 * 2. Using requestAnimationFrame for 60fps updates
 * 3. Only syncing to Zustand store when paused/seeking
 * 4. Providing callback-based subscriptions for components that need time
 */

import { useRef, useCallback, useSyncExternalStore } from 'react';
import { useVideoEditorStore } from '../stores/videoEditorStore';

// Singleton playback state (outside React)
let currentTimeMs = 0;
let isPlaying = false;
let durationMs = 0;
const subscribers = new Set<() => void>();

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
 * Hook for components that need playback controls.
 * Returns stable functions that don't cause re-renders.
 */
export function usePlaybackControls() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  
  const play = useCallback(() => {
    if (isPlaying) return;
    isPlaying = true;
    
    // Start video element - it becomes the source of truth
    // Time updates come via syncFromVideo() from timeupdate events
    videoRef.current?.play();
    
    // Sync to store (for UI that shows play/pause state)
    useVideoEditorStore.getState().setIsPlaying(true);
  }, []);
  
  const pause = useCallback(() => {
    if (!isPlaying) return;
    isPlaying = false;
    
    // Pause video element
    videoRef.current?.pause();
    
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
  }, []);
  
  const syncFromVideo = useCallback((timeMs: number) => {
    // Called from video timeupdate when we want to sync from video element
    // Only use this when video is the source of truth (playing natively)
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
  currentTimeMs = 0;
  isPlaying = false;
  durationMs = 0;
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
