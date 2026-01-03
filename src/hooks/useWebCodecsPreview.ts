/**
 * useWebCodecsPreview - WebCodecs-based video frame decoder for instant scrubbing.
 *
 * Uses mediabunny for hardware-accelerated frame decoding via WebCodecs.
 * Maintains a cache of decoded frames for instant preview during scrubbing.
 *
 * Benefits over video element seeking:
 * - Parallel decoding of multiple frames
 * - No seeking latency - frames are pre-decoded and cached
 * - Hardware acceleration via WebCodecs
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Input, ALL_FORMATS, UrlSource, VideoSampleSink } from 'mediabunny';
import type { InputVideoTrack } from 'mediabunny';
import { videoEditorLogger } from '@/utils/logger';

interface FrameCache {
  [timestampMs: number]: ImageBitmap;
}

// How many frames to keep in cache
const MAX_CACHE_SIZE = 30;
// How far ahead to pre-decode (ms)
const PREFETCH_RANGE_MS = 500;
// Interval between pre-decoded frames (ms)
const PREFETCH_INTERVAL_MS = 250;
// Max concurrent decode operations
const MAX_CONCURRENT_DECODES = 1;
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
 */
export function useWebCodecsPreview(videoPath: string | null): WebCodecsPreviewResult {
  const frameCache = useRef<FrameCache>({});
  const pendingDecodes = useRef<Set<number>>(new Set());
  const sinkRef = useRef<VideoSampleSink | null>(null);
  const videoTrackRef = useRef<InputVideoTrack | null>(null);
  const durationRef = useRef<number>(0);
  const lastPrefetchTimeRef = useRef<number>(0);
  const lastPrefetchPositionRef = useRef<number>(0);
  const decodeQueueRef = useRef<number[]>([]);
  const isDecodingRef = useRef<boolean>(false);
  
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  // Process decode queue with rate limiting - only decode one at a time
  const processDecodeQueue = useCallback(async () => {
    if (isDecodingRef.current) return;
    
    const sink = sinkRef.current;
    if (!sink) return;

    isDecodingRef.current = true;

    try {
      while (decodeQueueRef.current.length > 0 && pendingDecodes.current.size < MAX_CONCURRENT_DECODES) {
        const timestampMs = decodeQueueRef.current.shift();
        if (timestampMs === undefined) break;
        
        // Skip if already cached or pending
        if (frameCache.current[timestampMs] || pendingDecodes.current.has(timestampMs)) {
          continue;
        }

        pendingDecodes.current.add(timestampMs);

        try {
          const timestampSec = timestampMs / 1000;
          const sample = await sink.getSample(timestampSec);
          
          if (sample) {
            const videoFrame = sample.toVideoFrame();
            const bitmap = await createImageBitmap(videoFrame);
            videoFrame.close();
            sample.close();

            const cacheKey = Math.round(timestampMs);
            frameCache.current[cacheKey] = bitmap;

            // Evict old frames if cache is full
            const keys = Object.keys(frameCache.current).map(Number);
            if (keys.length > MAX_CACHE_SIZE) {
              keys.sort((a, b) => Math.abs(a - timestampMs) - Math.abs(b - timestampMs));
              const toRemove = keys.slice(MAX_CACHE_SIZE);
              for (const ts of toRemove) {
                frameCache.current[ts]?.close();
                delete frameCache.current[ts];
              }
            }
          }
        } catch {
          // Ignore decode errors
        } finally {
          pendingDecodes.current.delete(timestampMs);
        }
      }
    } finally {
      isDecodingRef.current = false;
    }
  }, []);

  // Initialize mediabunny input and decoder
  useEffect(() => {
    if (!videoPath) {
      setIsReady(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let currentSink: VideoSampleSink | null = null;

    const init = async () => {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const url = convertFileSrc(videoPath);

        const source = new UrlSource(url, {
          maxCacheSize: 16 * 1024 * 1024, // 16 MB cache
        });

        const input = new Input({
          formats: ALL_FORMATS,
          source,
        });

        if (cancelled) return;

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
          throw new Error('No video track found');
        }

        const canDecode = await videoTrack.canDecode();
        if (!canDecode) {
          throw new Error('Video codec not supported by WebCodecs');
        }

        const duration = await videoTrack.computeDuration();
        const width = videoTrack.displayWidth;
        const height = videoTrack.displayHeight;

        if (cancelled) return;

        const sink = new VideoSampleSink(videoTrack);
        currentSink = sink;

        videoTrackRef.current = videoTrack;
        sinkRef.current = sink;
        durationRef.current = duration;
        
        setDimensions({ width, height });
        setIsReady(true);
        setError(null);

        videoEditorLogger.debug('WebCodecs initialized:', { duration, width, height });
      } catch (err) {
        if (cancelled) return;
        videoEditorLogger.error('WebCodecs init error:', err);
        setError(err instanceof Error ? err.message : 'Failed to initialize');
        setIsReady(false);
      }
    };

    init();

    return () => {
      cancelled = true;
      
      if (currentSink && 'close' in currentSink) {
        try {
          (currentSink as { close: () => void }).close();
        } catch {
          // Ignore
        }
      }
      sinkRef.current = null;
      videoTrackRef.current = null;
      decodeQueueRef.current = [];
      
      for (const bitmap of Object.values(frameCache.current)) {
        bitmap.close();
      }
      frameCache.current = {};
      pendingDecodes.current.clear();
    };
  }, [videoPath]);

  // Get frame from cache
  const getFrame = useCallback((timestampMs: number): ImageBitmap | null => {
    const exact = frameCache.current[timestampMs];
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
  const prefetchAround = useCallback((timestampMs: number) => {
    if (!sinkRef.current || !isReady) return;

    const now = Date.now();
    const timeSinceLastPrefetch = now - lastPrefetchTimeRef.current;
    
    // Throttle: only prefetch every PREFETCH_THROTTLE_MS
    if (timeSinceLastPrefetch < PREFETCH_THROTTLE_MS) return;
    
    // Fast scrubbing detection: if moved too far since last prefetch, user is scrubbing fast
    // Skip prefetching to avoid queueing work that will be obsolete
    const distanceMoved = Math.abs(timestampMs - lastPrefetchPositionRef.current);
    if (distanceMoved > FAST_SCRUB_DISTANCE_MS && lastPrefetchPositionRef.current > 0) {
      // Still update refs so we can detect when scrubbing slows down
      lastPrefetchTimeRef.current = now;
      lastPrefetchPositionRef.current = timestampMs;
      // Clear pending queue since user moved far away
      decodeQueueRef.current = [];
      return;
    }
    
    lastPrefetchTimeRef.current = now;
    lastPrefetchPositionRef.current = timestampMs;

    const duration = durationRef.current * 1000;
    
    // Clear old queue and add new timestamps
    decodeQueueRef.current = [];
    
    // Current position first
    if (!frameCache.current[timestampMs] && !pendingDecodes.current.has(timestampMs)) {
      decodeQueueRef.current.push(timestampMs);
    }
    
    // Then nearby positions
    for (let offset = PREFETCH_INTERVAL_MS; offset <= PREFETCH_RANGE_MS; offset += PREFETCH_INTERVAL_MS) {
      const before = timestampMs - offset;
      const after = timestampMs + offset;
      
      if (before >= 0 && !frameCache.current[before] && !pendingDecodes.current.has(before)) {
        decodeQueueRef.current.push(before);
      }
      if (after <= duration && !frameCache.current[after] && !pendingDecodes.current.has(after)) {
        decodeQueueRef.current.push(after);
      }
    }

    // Process queue
    processDecodeQueue();
  }, [isReady, processDecodeQueue]);

  return {
    getFrame,
    prefetchAround,
    isReady,
    error,
    dimensions,
  };
}
