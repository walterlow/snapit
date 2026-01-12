/**
 * useWebCodecsPreview - WebCodecs-based video frame decoder for instant scrubbing.
 *
 * Uses a Web Worker for hardware-accelerated frame decoding via WebCodecs.
 * Decoding happens off the main thread to prevent UI blocking during scrubbing.
 * Maintains a cache of decoded frames for instant preview.
 *
 * Benefits over video element seeking:
 * - Off-main-thread decoding via Web Worker
 * - No seeking latency - frames are pre-decoded and cached
 * - Hardware acceleration via WebCodecs
 * - Zero-copy frame transfer via ImageBitmap
 */

import { useEffect, useRef, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useWebCodecsWorker } from './useWebCodecsWorker';
import { videoEditorLogger } from '@/utils/logger';
import type { FrameDecodedMessage } from '../workers/webcodecs-decoder.types';

interface FrameCache {
  [timestampMs: number]: ImageBitmap;
}

// How many frames to keep in cache
const MAX_CACHE_SIZE = 30;
// How far ahead to pre-decode (ms)
const PREFETCH_RANGE_MS = 500;
// Interval between pre-decoded frames (ms)
const PREFETCH_INTERVAL_MS = 250;
// Throttle interval for prefetch calls (ms)
const PREFETCH_THROTTLE_MS = 200;
// Fast scrubbing detection: if position changes more than this in PREFETCH_THROTTLE_MS, skip prefetch
const FAST_SCRUB_DISTANCE_MS = 500;

export interface WebCodecsPreviewResult {
  /** Get a frame at the given timestamp. Returns null if not yet decoded. */
  getFrame: (timestampMs: number) => ImageBitmap | null;
  /** Request frames to be decoded around a timestamp */
  prefetchAround: (timestampMs: number) => void;
  /** Whether the decoder is ready */
  isReady: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Video dimensions */
  dimensions: { width: number; height: number } | null;
}

/**
 * Hook for WebCodecs-based video preview.
 * Provides instant frame access by pre-decoding frames around the cursor.
 * Uses Web Worker for off-main-thread decoding.
 */
export function useWebCodecsPreview(videoPath: string | null): WebCodecsPreviewResult {
  const frameCache = useRef<FrameCache>({});
  const pendingRequests = useRef<Set<number>>(new Set());
  const lastPrefetchTimeRef = useRef<number>(0);
  const lastPrefetchPositionRef = useRef<number>(0);
  const lastReceivedTimestampRef = useRef<number>(0);

  // Convert file path to URL for worker
  const videoUrl = videoPath ? convertFileSrc(videoPath) : null;

  // Handle frame received from worker - receives ownership of transferred ImageBitmap
  const handleFrameDecoded = useCallback((msg: FrameDecodedMessage) => {
    const cacheKey = Math.round(msg.timestampMs);
    pendingRequests.current.delete(msg.requestId);
    lastReceivedTimestampRef.current = msg.timestampMs;

    // Store in cache - we now own this ImageBitmap
    frameCache.current[cacheKey] = msg.bitmap;

    // Evict old frames if cache is full (LRU based on distance from current position)
    const keys = Object.keys(frameCache.current).map(Number);
    if (keys.length > MAX_CACHE_SIZE) {
      keys.sort(
        (a, b) => Math.abs(a - msg.timestampMs) - Math.abs(b - msg.timestampMs)
      );
      const toRemove = keys.slice(MAX_CACHE_SIZE);
      for (const ts of toRemove) {
        frameCache.current[ts]?.close();
        delete frameCache.current[ts];
      }
    }
  }, []);

  // Handle frame decode error
  const handleFrameError = useCallback(
    (requestId: number, _timestampMs: number, error: string) => {
      pendingRequests.current.delete(requestId);
      // Only log unexpected errors, not "no sample" which is normal at boundaries
      if (!error.includes('No sample')) {
        videoEditorLogger.warn('[WebCodecsPreview] Frame error:', error);
      }
    },
    []
  );

  // Handle cache eviction notification from worker (informational only)
  const handleCacheEvicted = useCallback((_timestampMs: number) => {
    // Worker evicted from its small cache - no action needed on main thread
  }, []);

  // Use worker hook for off-main-thread decoding
  const worker = useWebCodecsWorker(videoUrl, {
    onFrameDecoded: handleFrameDecoded,
    onFrameError: handleFrameError,
    onCacheEvicted: handleCacheEvicted,
  });

  // Clean up frame cache when video changes or on unmount
  useEffect(() => {
    return () => {
      for (const bitmap of Object.values(frameCache.current)) {
        bitmap.close();
      }
      frameCache.current = {};
      pendingRequests.current.clear();
    };
  }, [videoUrl]);

  // Get frame from cache
  const getFrame = useCallback((timestampMs: number): ImageBitmap | null => {
    const rounded = Math.round(timestampMs);
    const exact = frameCache.current[rounded];
    if (exact) return exact;

    // Find nearest within 250ms tolerance
    const keys = Object.keys(frameCache.current).map(Number);
    let nearest: number | null = null;
    let nearestDist = Infinity;

    for (const ts of keys) {
      const dist = Math.abs(ts - timestampMs);
      if (dist < nearestDist && dist < 250) {
        nearestDist = dist;
        nearest = ts;
      }
    }

    return nearest !== null ? frameCache.current[nearest] : null;
  }, []);

  // Prefetch frames around a timestamp (throttled, with fast-scrub detection)
  const prefetchAround = useCallback(
    (timestampMs: number) => {
      if (!worker.isReady) return;

      const now = Date.now();
      const timeSinceLastPrefetch = now - lastPrefetchTimeRef.current;

      // Throttle: only prefetch every PREFETCH_THROTTLE_MS
      if (timeSinceLastPrefetch < PREFETCH_THROTTLE_MS) return;

      // Fast scrubbing detection: if moved too far since last prefetch, user is scrubbing fast
      // Skip prefetching to avoid queueing work that will be obsolete
      const distanceMoved = Math.abs(
        timestampMs - lastPrefetchPositionRef.current
      );
      if (
        distanceMoved > FAST_SCRUB_DISTANCE_MS &&
        lastPrefetchPositionRef.current > 0
      ) {
        // Still update refs so we can detect when scrubbing slows down
        lastPrefetchTimeRef.current = now;
        lastPrefetchPositionRef.current = timestampMs;
        // Clear pending requests since user moved far away
        pendingRequests.current.clear();
        worker.clearCache();
        return;
      }

      lastPrefetchTimeRef.current = now;
      lastPrefetchPositionRef.current = timestampMs;

      const duration = worker.durationMs;
      const rounded = Math.round(timestampMs);

      // Request current position with immediate priority
      if (
        !frameCache.current[rounded] &&
        !pendingRequests.current.has(rounded)
      ) {
        const reqId = worker.requestFrame(timestampMs, 'immediate');
        if (reqId >= 0) pendingRequests.current.add(reqId);
      }

      // Request nearby positions with prefetch priority
      for (
        let offset = PREFETCH_INTERVAL_MS;
        offset <= PREFETCH_RANGE_MS;
        offset += PREFETCH_INTERVAL_MS
      ) {
        const before = Math.round(timestampMs - offset);
        const after = Math.round(timestampMs + offset);

        if (
          before >= 0 &&
          !frameCache.current[before] &&
          !pendingRequests.current.has(before)
        ) {
          const reqId = worker.requestFrame(before, 'prefetch');
          if (reqId >= 0) pendingRequests.current.add(reqId);
        }
        if (
          after <= duration &&
          !frameCache.current[after] &&
          !pendingRequests.current.has(after)
        ) {
          const reqId = worker.requestFrame(after, 'prefetch');
          if (reqId >= 0) pendingRequests.current.add(reqId);
        }
      }
    },
    [worker]
  );

  return {
    getFrame,
    prefetchAround,
    isReady: worker.isReady,
    error: worker.error,
    dimensions: worker.dimensions,
  };
}
