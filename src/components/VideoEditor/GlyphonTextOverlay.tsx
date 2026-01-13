/**
 * GlyphonTextOverlay - WYSIWYG text rendering via Rust backend.
 *
 * Optimizations:
 * 1. Frame caching - render once per unique text state, reuse bitmap
 * 2. Render at display size - not video size (4x fewer pixels)
 * 3. Skip stale requests - only process latest during rapid scrubbing
 * 4. Visibility-based rendering - only re-render when text changes
 */

import { memo, useRef, useEffect, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TextSegment } from '../../types';

// RGBA magic number (must match Rust)
const RGBA_MAGIC = 0x52474241;

// Max cache size (LRU eviction)
const MAX_CACHE_SIZE = 20;

interface GlyphonTextOverlayProps {
  segments: TextSegment[];
  currentTime: number;
  containerWidth: number;
  containerHeight: number;
  videoWidth: number;
  videoHeight: number;
  enabled?: boolean;
}

/**
 * Calculate fade opacity for a segment at a given time.
 */
function calculateOpacity(segment: TextSegment, time: number): number {
  const fadeDuration = segment.fadeDuration || 0;
  if (fadeDuration <= 0) return 1.0;

  const timeInSegment = time - segment.start;
  const timeToEnd = segment.end - time;
  const segmentDuration = segment.end - segment.start;

  // Fade in at start
  if (timeInSegment < fadeDuration) {
    return Math.max(0, Math.min(1, timeInSegment / fadeDuration));
  }

  // Fade out at end
  if (timeToEnd < fadeDuration && segmentDuration > fadeDuration * 2) {
    return Math.max(0, Math.min(1, timeToEnd / fadeDuration));
  }

  return 1.0;
}

/**
 * Compute visibility key - changes when visible text OR opacity changes.
 */
function computeVisibilityKey(segments: TextSegment[], time: number): string {
  const visible: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.enabled && time >= s.start && time <= s.end) {
      // Calculate opacity (round to 2 decimals to limit cache entries)
      const opacity = Math.round(calculateOpacity(s, time) * 100) / 100;
      // Include all properties that affect rendering + opacity
      visible.push(
        `${i}:${s.content}:${s.fontFamily}:${s.fontWeight}:${s.italic}:${s.fontSize}:${s.color}:${s.center.x.toFixed(3)}:${s.center.y.toFixed(3)}:${opacity}`
      );
    }
  }
  return visible.join('||');
}

/**
 * Parse frame metadata from WebSocket binary message.
 */
function parseFrameMetadata(data: ArrayBuffer): { width: number; height: number } | null {
  if (data.byteLength < 28) return null;

  const view = new DataView(data);
  const offset = data.byteLength - 28;

  const magic = view.getUint32(offset + 24, true);
  if (magic !== RGBA_MAGIC) return null;

  return {
    width: view.getUint32(offset + 8, true),
    height: view.getUint32(offset + 4, true),
  };
}

/**
 * LRU cache for rendered frames.
 */
class FrameCache {
  private cache = new Map<string, ImageBitmap>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): ImageBitmap | undefined {
    const bitmap = this.cache.get(key);
    if (bitmap) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, bitmap);
    }
    return bitmap;
  }

  set(key: string, bitmap: ImageBitmap): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.get(oldest)?.close();
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, bitmap);
  }

  clear(): void {
    this.cache.forEach(b => b.close());
    this.cache.clear();
  }
}

export const GlyphonTextOverlay = memo(function GlyphonTextOverlay({
  segments,
  currentTime,
  containerWidth,
  containerHeight,
  videoWidth,
  videoHeight,
  enabled = true,
}: GlyphonTextOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Frame cache (persists across renders)
  const cacheRef = useRef<FrameCache>(new FrameCache(MAX_CACHE_SIZE));

  // Request tracking for skip-stale
  const requestIdRef = useRef<number>(0);
  const pendingKeyRef = useRef<string | null>(null);
  const lastRenderedKeyRef = useRef<string>('');

  // Dimensions for rendering (use display size, not video size)
  const renderWidth = containerWidth > 0 ? containerWidth : videoWidth;
  const renderHeight = containerHeight > 0 ? containerHeight : videoHeight;

  // Draw bitmap to canvas
  const drawBitmap = useCallback((bitmap: ImageBitmap | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
  }, []);

  // Connect to WebSocket
  useEffect(() => {
    if (!enabled || renderWidth === 0 || renderHeight === 0) return;

    let mounted = true;
    let ws: WebSocket | null = null;

    const connect = async () => {
      try {
        const wsUrl = await invoke<string>('init_preview');
        if (!mounted) return;

        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          if (!mounted) return;
          setIsConnected(true);
          wsRef.current = ws;
        };

        ws.onmessage = async (event) => {
          if (!mounted) return;

          const data = event.data as ArrayBuffer;
          const meta = parseFrameMetadata(data);
          if (!meta) return;

          // Extract RGBA and create bitmap
          const rgbaData = new Uint8ClampedArray(data, 0, data.byteLength - 28);
          const imageData = new ImageData(rgbaData, meta.width, meta.height);

          try {
            const bitmap = await createImageBitmap(imageData, {
              premultiplyAlpha: 'none',
            });
            if (!mounted) return;

            // Cache the bitmap with the pending key
            const key = pendingKeyRef.current;
            if (key) {
              cacheRef.current.set(key, bitmap);
              pendingKeyRef.current = null;

              // Draw if still current
              if (key === lastRenderedKeyRef.current) {
                drawBitmap(bitmap);
              }
            }
          } catch (e) {
            console.error('[GlyphonText] Bitmap creation failed:', e);
          }
        };

        ws.onerror = () => setIsConnected(false);
        ws.onclose = () => {
          if (!mounted) return;
          setIsConnected(false);
          wsRef.current = null;
        };
      } catch (error) {
        console.error('[GlyphonText] Connection failed:', error);
      }
    };

    connect();

    return () => {
      mounted = false;
      ws?.close();
      cacheRef.current.clear();
    };
  }, [enabled, renderWidth, renderHeight, drawBitmap]);

  // Update canvas size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (canvas.width !== containerWidth || canvas.height !== containerHeight) {
      canvas.width = containerWidth;
      canvas.height = containerHeight;
    }
  }, [containerWidth, containerHeight]);

  // Main render effect - visibility-based
  useEffect(() => {
    if (!enabled) {
      drawBitmap(null);
      lastRenderedKeyRef.current = '';
      return;
    }

    const visKey = computeVisibilityKey(segments, currentTime);

    // Skip if same as last render
    if (visKey === lastRenderedKeyRef.current) {
      return;
    }
    lastRenderedKeyRef.current = visKey;

    // Empty = no visible text
    if (visKey === '') {
      drawBitmap(null);
      return;
    }

    // Check cache first - instant display
    const cached = cacheRef.current.get(visKey);
    if (cached) {
      drawBitmap(cached);
      return;
    }

    // Need to render - skip if not connected
    if (!isConnected || !wsRef.current) return;

    // Increment request ID (skip-stale)
    const thisRequestId = ++requestIdRef.current;
    pendingKeyRef.current = visKey;

    // Filter to visible segments
    const visibleSegments = segments.filter(
      s => s.enabled && currentTime >= s.start && currentTime <= s.end
    );

    // Request render at DISPLAY size (not video size)
    invoke('render_text_overlay', {
      timeMs: Math.floor(currentTime * 1000),
      width: Math.floor(renderWidth),
      height: Math.floor(renderHeight),
      segments: visibleSegments,
    }).catch(err => {
      // Only log if this is still the current request
      if (thisRequestId === requestIdRef.current) {
        console.error('[GlyphonText] Render failed:', err);
      }
      pendingKeyRef.current = null;
    });
  }, [segments, currentTime, enabled, isConnected, renderWidth, renderHeight, drawBitmap]);

  if (!enabled || containerWidth === 0 || containerHeight === 0) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      width={containerWidth}
      height={containerHeight}
      className="absolute inset-0 pointer-events-none"
      style={{ width: containerWidth, height: containerHeight }}
    />
  );
});

export default GlyphonTextOverlay;
