/**
 * WasmTextCanvas - Renders text overlays using WASM WebGPU renderer.
 *
 * This component renders text directly in the browser using wgpu + glyphon
 * compiled to WebAssembly, eliminating the Rust↔Browser round trip latency.
 *
 * Features:
 * - WebGPU-accelerated text rendering
 * - Exact match with Rust text.rs calculations
 * - Sub-frame latency (no WebSocket delay)
 * - Transparent background for compositing over video
 */

import { memo, useEffect, useRef, useMemo, useId, useState } from 'react';
import { useWasmTextRenderer } from '../../hooks/useWasmTextRenderer';
import type { TextSegment } from '../../types';

interface WasmTextCanvasProps {
  /** Text segments to render */
  segments: TextSegment[];
  /** Current time in milliseconds */
  currentTimeMs: number;
  /** Container width in pixels */
  containerWidth: number;
  /** Container height in pixels */
  containerHeight: number;
  /** Original video width */
  videoWidth: number;
  /** Original video height */
  videoHeight: number;
  /** Whether rendering is enabled */
  enabled?: boolean;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Fallback to display when WebGPU not supported */
  fallback?: React.ReactNode;
}

/**
 * Canvas-based text overlay using WASM WebGPU renderer.
 */
export const WasmTextCanvas = memo(function WasmTextCanvas({
  segments,
  currentTimeMs,
  containerWidth,
  containerHeight,
  videoWidth,
  videoHeight,
  enabled = true,
  onError,
  fallback,
}: WasmTextCanvasProps) {
  // Generate unique canvas ID for this instance
  const instanceId = useId();
  const canvasId = `wasm-text-canvas-${instanceId.replace(/:/g, '')}`;

  // Calculate display dimensions (fit video aspect ratio in container)
  const displaySize = useMemo(() => {
    if (containerWidth === 0 || containerHeight === 0) {
      return { width: videoWidth, height: videoHeight };
    }

    const containerAspect = containerWidth / containerHeight;
    const videoAspect = videoWidth / videoHeight;

    let width: number;
    let height: number;

    if (videoAspect < containerAspect) {
      // Video is taller - constrain by height
      height = containerHeight;
      width = height * videoAspect;
    } else {
      // Video is wider - constrain by width
      width = containerWidth;
      height = width / videoAspect;
    }

    return { width: Math.round(width), height: Math.round(height) };
  }, [containerWidth, containerHeight, videoWidth, videoHeight]);

  // Use WASM text renderer
  const { isReady, isSupported, render, loadFont } = useWasmTextRenderer({
    canvasId,
    width: displaySize.width,
    height: displaySize.height,
    onError,
  });

  // Track loaded fonts - use state to trigger re-render when fonts load
  const loadedFontsRef = useRef<Set<string>>(new Set());
  const [fontsVersion, setFontsVersion] = useState(0);

  // Track last render time to throttle during playback
  const lastRenderRef = useRef<number>(0);

  // Clear local font tracking when renderer is recreated
  // This ensures fonts are reloaded into the new renderer
  useEffect(() => {
    if (isReady) {
      loadedFontsRef.current.clear();
    }
  }, [isReady]);

  // Load fonts when segments change - now loads specific weights for WYSIWYG
  useEffect(() => {
    if (!isReady) {
      return;
    }

    // Extract unique font family + weight combinations from segments
    const fontKeys = new Set<string>();
    const fontRequests: Array<{ family: string; weight: number }> = [];

    for (const segment of segments) {
      if (segment.fontFamily) {
        // Round weight to nearest 100 (standard font weights)
        const weight = Math.round(segment.fontWeight / 100) * 100;
        const key = `${segment.fontFamily}:${weight}`;

        if (!fontKeys.has(key)) {
          fontKeys.add(key);
          fontRequests.push({ family: segment.fontFamily, weight });
        }
      }
    }

    // Load any new font/weight combinations
    for (const { family, weight } of fontRequests) {
      const key = `${family}:${weight}`;
      if (!loadedFontsRef.current.has(key)) {
        loadedFontsRef.current.add(key);
        loadFont(family, weight)
          .then((fontInfo) => {
            if (fontInfo) {
              // Reset throttle and trigger re-render when font loads
              lastRenderRef.current = 0;
              setFontsVersion((v) => v + 1);
            }
          })
          .catch(() => {
            // Font load failed, remove from loaded set so it can be retried
            loadedFontsRef.current.delete(key);
          });
      }
    }
  }, [isReady, segments, loadFont]);

  // Create a stable key for segments to detect property changes (not just reference changes)
  // This ensures re-render when font weight or other properties change
  const segmentsKey = useMemo(() => {
    return segments.map(s => `${s.fontFamily}:${s.fontWeight}:${s.fontSize}:${s.color}:${s.content}`).join('|');
  }, [segments]);

  // Render on time changes, segment changes, and when fonts load
  useEffect(() => {
    if (!enabled || !isReady || segments.length === 0) {
      return;
    }

    // Update render timestamp
    // Note: Throttling removed - the dependency array naturally limits re-renders
    // to when segments, time, or fonts actually change
    lastRenderRef.current = performance.now();

    const timeSec = currentTimeMs / 1000;

    // Debug: log when render is triggered with font info
    const activeSegment = segments.find(s => s.enabled && timeSec >= s.start && timeSec <= s.end);
    if (activeSegment) {
      console.debug(`[WasmText] Rendering: font="${activeSegment.fontFamily}" weight=${activeSegment.fontWeight} fontsVersion=${fontsVersion}`);
    }

    render(segments, timeSec);
  }, [enabled, isReady, segments, currentTimeMs, render, fontsVersion, segmentsKey]);

  // Show fallback if WebGPU not supported
  if (!isSupported) {
    return fallback ?? null;
  }

  if (!enabled) {
    return null;
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <canvas
        id={canvasId}
        width={displaySize.width}
        height={displaySize.height}
        style={{
          width: `${displaySize.width}px`,
          height: `${displaySize.height}px`,
        }}
      />
    </div>
  );
});

export default WasmTextCanvas;
