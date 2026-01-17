/**
 * UnifiedTextOverlay - Unified text preview with automatic fallback.
 *
 * Tries native wgpu surface rendering first (Windows-only, zero-latency),
 * falls back to WebSocket-based GlyphonTextOverlay if native is unavailable.
 *
 * Usage:
 * <UnifiedTextOverlay
 *   segments={textSegments}
 *   currentTime={currentTimeMs / 1000}
 *   containerWidth={containerWidth}
 *   containerHeight={containerHeight}
 *   videoWidth={videoWidth}
 *   videoHeight={videoHeight}
 *   enabled={true}
 * />
 */

import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TextSegment } from '../../types';
import { GlyphonTextOverlay } from './GlyphonTextOverlay';
import { videoEditorLogger } from '@/utils/logger';

interface UnifiedTextOverlayProps {
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

  if (timeInSegment < fadeDuration) {
    return Math.max(0, Math.min(1, timeInSegment / fadeDuration));
  }

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
      const opacity = Math.round(calculateOpacity(s, time) * 100) / 100;
      visible.push(
        `${i}:${s.content}:${s.fontFamily}:${s.fontWeight}:${s.italic}:${s.fontSize}:${s.color}:${s.center.x.toFixed(3)}:${s.center.y.toFixed(3)}:${opacity}`
      );
    }
  }
  return visible.join('||');
}

/**
 * Native text preview component (Windows-only).
 * Creates a wgpu surface behind the webview for zero-latency rendering.
 */
const NativeTextPreview = memo(function NativeTextPreview({
  segments,
  currentTime,
  containerWidth,
  containerHeight,
  enabled = true,
  onError,
}: {
  segments: TextSegment[];
  currentTime: number;
  containerWidth: number;
  containerHeight: number;
  enabled?: boolean;
  onError: (err: Error) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const lastKeyRef = useRef<string>('');
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const lastPositionRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Get the absolute position of the container element within the window
  const getContainerPosition = useCallback(() => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    // Account for window scroll and scaling
    const x = Math.floor(rect.left);
    const y = Math.floor(rect.top);
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    return { x, y, w, h };
  }, []);

  // Initialize native preview
  useEffect(() => {
    if (!enabled || containerWidth === 0 || containerHeight === 0) return;

    // Wait for container to be mounted
    if (!containerRef.current) return;

    // Avoid duplicate initialization
    if (initPromiseRef.current) return;

    const init = async () => {
      try {
        const pos = getContainerPosition();
        if (!pos) throw new Error('Container not mounted');

        lastPositionRef.current = pos;

        await invoke('init_native_text_preview', {
          x: pos.x,
          y: pos.y,
          width: pos.w,
          height: pos.h,
        });
        setIsInitialized(true);
        videoEditorLogger.info('NativeTextPreview initialized at', pos);
      } catch (err) {
        videoEditorLogger.warn('NativeTextPreview failed to initialize:', err);
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    initPromiseRef.current = init();

    return () => {
      initPromiseRef.current = null;
      setIsInitialized(false);
      invoke('destroy_native_text_preview').catch(() => {});
    };
  }, [enabled, containerWidth, containerHeight, getContainerPosition, onError]);

  // Handle resize/reposition
  useEffect(() => {
    if (!isInitialized) return;

    const pos = getContainerPosition();
    if (!pos) return;

    const last = lastPositionRef.current;
    if (last && last.x === pos.x && last.y === pos.y && last.w === pos.w && last.h === pos.h) {
      return; // No change
    }

    lastPositionRef.current = pos;

    invoke('resize_native_text_preview', {
      x: pos.x,
      y: pos.y,
      width: pos.w,
      height: pos.h,
    }).catch((err) => videoEditorLogger.error('Failed to resize native text preview:', err));
  }, [isInitialized, containerWidth, containerHeight, getContainerPosition]);

  // Update text segments
  useEffect(() => {
    if (!isInitialized || !enabled) return;

    const visKey = computeVisibilityKey(segments, currentTime);

    // Skip if same as last update
    if (visKey === lastKeyRef.current) return;
    lastKeyRef.current = visKey;

    // Filter to visible segments
    const visibleSegments = segments.filter(
      s => s.enabled && currentTime >= s.start && currentTime <= s.end
    );

    invoke('update_native_text_preview', {
      segments: visibleSegments,
      timeMs: Math.floor(currentTime * 1000),
    }).catch((err) => videoEditorLogger.error('Failed to update native text preview:', err));
  }, [segments, currentTime, enabled, isInitialized]);

  // Render a transparent placeholder that marks the position
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width: containerWidth, height: containerHeight }}
    />
  );
});

/**
 * UnifiedTextOverlay - Tries native rendering first, falls back to WebSocket.
 */
export const UnifiedTextOverlay = memo(function UnifiedTextOverlay({
  segments,
  currentTime,
  containerWidth,
  containerHeight,
  videoWidth,
  videoHeight,
  enabled = true,
}: UnifiedTextOverlayProps) {
  const [useNative, setUseNative] = useState(true);
  const [nativeError, setNativeError] = useState<Error | null>(null);

  // Handle native preview error - fall back to WebSocket
  const handleNativeError = useCallback((err: Error) => {
    videoEditorLogger.warn('Native preview failed, falling back to WebSocket:', err);
    setNativeError(err);
    setUseNative(false);
  }, []);

  // Don't render if disabled or no container
  if (!enabled || containerWidth === 0 || containerHeight === 0) {
    return null;
  }

  // Try native first (Windows-only, zero-latency)
  if (useNative && !nativeError) {
    return (
      <NativeTextPreview
        segments={segments}
        currentTime={currentTime}
        containerWidth={containerWidth}
        containerHeight={containerHeight}
        enabled={enabled}
        onError={handleNativeError}
      />
    );
  }

  // Fall back to WebSocket-based rendering
  return (
    <GlyphonTextOverlay
      segments={segments}
      currentTime={currentTime}
      containerWidth={containerWidth}
      containerHeight={containerHeight}
      videoWidth={videoWidth}
      videoHeight={videoHeight}
      enabled={enabled}
    />
  );
});

export default UnifiedTextOverlay;
