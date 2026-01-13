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

  // Load fonts when segments change
  useEffect(() => {
    if (!isReady) {
      return;
    }

    // Extract unique font families from segments
    const fonts = new Set<string>();
    for (const segment of segments) {
      if (segment.fontFamily) {
        fonts.add(segment.fontFamily);
      }
    }

    // Load any new fonts
    for (const fontFamily of fonts) {
      if (!loadedFontsRef.current.has(fontFamily)) {
        loadedFontsRef.current.add(fontFamily);
        loadFont(fontFamily)
          .then((success) => {
            if (success) {
              // Reset throttle and trigger re-render when font loads
              lastRenderRef.current = 0;
              setFontsVersion((v) => v + 1);
            }
          })
          .catch(() => {
            // Font load failed, remove from loaded set so it can be retried
            loadedFontsRef.current.delete(fontFamily);
          });
      }
    }
  }, [isReady, segments, loadFont]);

  // Render on time changes (and when fonts load)
  useEffect(() => {
    if (!enabled || !isReady || segments.length === 0) {
      return;
    }

    // Throttle rendering during rapid updates
    const now = performance.now();
    if (now - lastRenderRef.current < 16) { // ~60fps max
      return;
    }
    lastRenderRef.current = now;

    const timeSec = currentTimeMs / 1000;
    render(segments, timeSec);
  }, [enabled, isReady, segments, currentTimeMs, render, fontsVersion]);

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
