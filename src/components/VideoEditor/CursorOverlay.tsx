/**
 * CursorOverlay - Renders cursor on top of video preview.
 *
 * Uses SVG as PRIMARY cursor rendering (when cursor_shape is detected).
 * Falls back to captured bitmap for custom/unknown cursors.
 * 
 * This matches Cap's approach for consistent, resolution-independent cursors.
 */

import { memo, useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useCursorInterpolation } from '../../hooks/useCursorInterpolation';
import { usePreviewOrPlaybackTime } from '../../hooks/usePlaybackEngine';
import { WINDOWS_CURSORS, DEFAULT_CURSOR, type CursorDefinition } from '../../constants/cursors';
import { editorLogger } from '../../utils/logger';
import type { CursorRecording, CursorConfig, CursorImage, WindowsCursorShape } from '../../types';

// Default cursor config values
const DEFAULT_CURSOR_SCALE = 1.0;
const DEFAULT_CIRCLE_SIZE = 20; // Circle diameter in pixels at scale 1.0
const DEFAULT_CURSOR_SIZE = 24; // Default cursor size in pixels

// Cursor shape change debouncing
// Prevents rapid flickering when hovering over resize handles, etc.
const CURSOR_SHAPE_DEBOUNCE_MS = 80;

interface CursorOverlayProps {
  cursorRecording: CursorRecording | null | undefined;
  cursorConfig: CursorConfig | undefined;
  /** Container width in pixels */
  containerWidth: number;
  /** Container height in pixels */
  containerHeight: number;
  /** Video aspect ratio (width/height) for object-contain offset calculation */
  videoAspectRatio?: number;
}

/**
 * Global cache for decoded cursor images (both SVGs and bitmaps).
 * Persists across component re-renders.
 */
const cursorImageCache = new Map<string, HTMLImageElement>();

/**
 * Generate cache key for SVG cursors.
 */
function svgCacheKey(shape: WindowsCursorShape): string {
  return `__svg_${shape}__`;
}

/**
 * Load an SVG cursor by shape.
 */
function loadSvgCursor(
  shape: WindowsCursorShape,
  onLoad: () => void
): HTMLImageElement | null {
  const key = svgCacheKey(shape);
  const cached = cursorImageCache.get(key);
  if (cached) {
    return cached;
  }

  const definition = WINDOWS_CURSORS[shape];
  if (!definition) {
    return null;
  }

  const img = new Image();
  img.onload = () => {
    cursorImageCache.set(key, img);
    onLoad();
  };
  img.onerror = () => {
    editorLogger.warn(`Failed to load SVG cursor: ${shape}`);
  };
  img.src = definition.svg;

  return null;
}

/**
 * Load a cursor bitmap from base64 data.
 */
function loadBitmapCursor(
  id: string,
  image: CursorImage,
  onLoad: () => void
): HTMLImageElement | null {
  const cached = cursorImageCache.get(id);
  if (cached) {
    return cached;
  }

  const img = new Image();
  img.onload = () => {
    cursorImageCache.set(id, img);
    onLoad();
  };
  img.onerror = () => {
    editorLogger.warn(`Failed to load bitmap cursor: ${id}`);
  };
  img.src = `data:image/png;base64,${image.dataBase64}`;

  return null;
}

/**
 * CursorOverlay component - renders cursor on video preview.
 * 
 * Priority order:
 * 1. SVG cursor (if cursorShape is detected) - PRIMARY
 * 2. Bitmap cursor (fallback for custom cursors)
 * 3. Default arrow SVG (fallback when nothing else available)
 */
/**
 * Calculate the actual video bounds within a container using object-contain.
 * Returns the offset and dimensions of the video area.
 */
function calculateVideoBounds(
  containerWidth: number,
  containerHeight: number,
  videoAspectRatio: number
): { offsetX: number; offsetY: number; width: number; height: number } {
  const containerAspect = containerWidth / containerHeight;

  if (containerAspect > videoAspectRatio) {
    // Container is wider than video - letterboxing on sides (pillarboxing)
    const videoWidth = containerHeight * videoAspectRatio;
    const offsetX = (containerWidth - videoWidth) / 2;
    return { offsetX, offsetY: 0, width: videoWidth, height: containerHeight };
  } else {
    // Container is taller than video - letterboxing on top/bottom
    const videoHeight = containerWidth / videoAspectRatio;
    const offsetY = (containerHeight - videoHeight) / 2;
    return { offsetX: 0, offsetY, width: containerWidth, height: videoHeight };
  }
}

export const CursorOverlay = memo(function CursorOverlay({
  cursorRecording,
  cursorConfig,
  containerWidth,
  containerHeight,
  videoAspectRatio,
}: CursorOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentTimeMs = usePreviewOrPlaybackTime();

  // Simple counter to force re-render when images load
  const [, forceUpdate] = useState(0);
  const triggerUpdate = useCallback(() => forceUpdate((n) => n + 1), []);

  // Get interpolated cursor data
  const { getCursorAt, hasCursorData, cursorImages } = useCursorInterpolation(cursorRecording);

  // Preload SVG cursors for all shapes found in recording + default arrow
  useEffect(() => {
    // Always load default arrow as final fallback
    loadSvgCursor('arrow', triggerUpdate);

    // Load SVGs for all cursor shapes in the recording
    const shapesInRecording = new Set<WindowsCursorShape>();
    for (const image of Object.values(cursorImages)) {
      if (image?.cursorShape) {
        shapesInRecording.add(image.cursorShape);
      }
    }

    for (const shape of shapesInRecording) {
      loadSvgCursor(shape, triggerUpdate);
    }

    // Also load bitmap fallbacks for cursors without shapes
    for (const [id, image] of Object.entries(cursorImages)) {
      if (image && !image.cursorShape && !cursorImageCache.has(id)) {
        loadBitmapCursor(id, image, triggerUpdate);
      }
    }
  }, [cursorImages, triggerUpdate]);

  // Get cursor config values with defaults
  const visible = cursorConfig?.visible ?? true;
  const cursorType = cursorConfig?.cursorType ?? 'auto';
  const scale = cursorConfig?.scale ?? DEFAULT_CURSOR_SCALE;
  const hideWhenIdle = cursorConfig?.hideWhenIdle ?? false;
  const idleTimeoutMs = cursorConfig?.idleTimeoutMs ?? 3000;

  // Track if cursor is idle (no movement for idleTimeoutMs)
  const [isIdle, setIsIdle] = useState(false);
  const lastPositionRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // Get cursor position at current time
  const cursorData = hasCursorData ? getCursorAt(currentTimeMs) : null;

  // Cursor shape debouncing state
  // Prevents rapid flickering when cursor alternates between shapes (e.g., arrow ↔ resize)
  const stableCursorRef = useRef<{
    cursorId: string | null;
    shape: WindowsCursorShape | null;
    pendingShape: WindowsCursorShape | null;
    pendingCursorId: string | null;
    pendingSince: number;
  }>({
    cursorId: null,
    shape: null,
    pendingShape: null,
    pendingCursorId: null,
    pendingSince: 0,
  });

  // Compute the debounced/stable cursor to render
  const stableCursor = useMemo(() => {
    if (!cursorData?.cursorId) {
      return { cursorId: null, shape: null };
    }

    const cursorId = cursorData.cursorId;
    const cursorImageData = cursorImages[cursorId];
    const currentShape = cursorImageData?.cursorShape ?? null;
    const now = performance.now();
    const stable = stableCursorRef.current;

    // If cursor ID or shape matches current stable, keep it
    if (stable.cursorId === cursorId || stable.shape === currentShape) {
      // Reset pending since we're back to stable
      stable.pendingShape = null;
      stable.pendingCursorId = null;
      return { cursorId: stable.cursorId, shape: stable.shape };
    }

    // New cursor detected - check if it's the same as pending
    if (stable.pendingCursorId === cursorId || stable.pendingShape === currentShape) {
      // Same pending cursor - check if debounce period passed
      if (now - stable.pendingSince >= CURSOR_SHAPE_DEBOUNCE_MS) {
        // Debounce complete - promote to stable
        stable.cursorId = cursorId;
        stable.shape = currentShape;
        stable.pendingShape = null;
        stable.pendingCursorId = null;
        return { cursorId, shape: currentShape };
      }
      // Still waiting for debounce
      return { cursorId: stable.cursorId, shape: stable.shape };
    }

    // Different pending cursor - reset debounce timer
    stable.pendingCursorId = cursorId;
    stable.pendingShape = currentShape;
    stable.pendingSince = now;

    // Return current stable while we wait
    // If no stable yet, use the new one immediately
    if (stable.cursorId === null && stable.shape === null) {
      stable.cursorId = cursorId;
      stable.shape = currentShape;
      return { cursorId, shape: currentShape };
    }

    return { cursorId: stable.cursorId, shape: stable.shape };
  }, [cursorData?.cursorId, cursorImages]);

  useEffect(() => {
    if (!hideWhenIdle || !cursorData) {
      setIsIdle(false);
      return;
    }

    const { x, y } = cursorData;
    const now = Date.now();
    const lastPos = lastPositionRef.current;

    if (lastPos && Math.abs(lastPos.x - x) < 0.001 && Math.abs(lastPos.y - y) < 0.001) {
      if (now - lastPos.time > idleTimeoutMs) {
        setIsIdle(true);
      }
    } else {
      lastPositionRef.current = { x, y, time: now };
      setIsIdle(false);
    }
  }, [cursorData, hideWhenIdle, idleTimeoutMs]);

  // Draw cursor on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cursorData || !visible || (hideWhenIdle && isIdle)) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to match container
    if (canvas.width !== containerWidth || canvas.height !== containerHeight) {
      canvas.width = containerWidth;
      canvas.height = containerHeight;
    }

    // Calculate pixel position from normalized coordinates
    // The cursor coordinates are normalized (0-1) relative to the capture region.
    // When video uses object-contain, we need to account for letterboxing offset.
    let pixelX: number;
    let pixelY: number;

    if (videoAspectRatio && videoAspectRatio > 0) {
      // Calculate actual video bounds within the container (accounting for object-contain)
      const bounds = calculateVideoBounds(containerWidth, containerHeight, videoAspectRatio);
      pixelX = bounds.offsetX + cursorData.x * bounds.width;
      pixelY = bounds.offsetY + cursorData.y * bounds.height;
    } else {
      // Fallback: assume container matches video aspect ratio exactly
      pixelX = cursorData.x * containerWidth;
      pixelY = cursorData.y * containerHeight;
    }

    // Debug logging for cursor position issues - log first 5 frames and then occasionally
    if (process.env.NODE_ENV === 'development') {
      const shouldLog = currentTimeMs < 200 || Math.random() < 0.005;
      if (shouldLog) {
        editorLogger.debug(
          `[CursorOverlay] time=${currentTimeMs.toFixed(0)}ms ` +
          `norm=(${cursorData.x.toFixed(4)}, ${cursorData.y.toFixed(4)}) ` +
          `pixel=(${pixelX.toFixed(1)}, ${pixelY.toFixed(1)}) ` +
          `container=${containerWidth}x${containerHeight}` +
          (videoAspectRatio ? ` videoAR=${videoAspectRatio.toFixed(3)}` : '')
        );
      }
    }

    // Helper to draw circle cursor
    const drawCircle = () => {
      ctx.clearRect(0, 0, containerWidth, containerHeight);
      const radius = (DEFAULT_CIRCLE_SIZE / 2) * scale;
      ctx.beginPath();
      ctx.arc(pixelX, pixelY, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    // Helper to draw cursor with image and definition
    const drawCursor = (img: HTMLImageElement, def: CursorDefinition) => {
      ctx.clearRect(0, 0, containerWidth, containerHeight);
      const drawHeight = DEFAULT_CURSOR_SIZE * scale;
      const drawWidth = (img.width / img.height) * drawHeight;
      const drawX = pixelX - drawWidth * def.hotspotX;
      const drawY = pixelY - drawHeight * def.hotspotY;
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    };

    // Helper to draw bitmap cursor with pixel hotspot
    const drawBitmap = (img: HTMLImageElement, hotspotX: number, hotspotY: number) => {
      ctx.clearRect(0, 0, containerWidth, containerHeight);
      const drawWidth = img.width * scale;
      const drawHeight = img.height * scale;
      const drawX = pixelX - hotspotX * scale;
      const drawY = pixelY - hotspotY * scale;
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    };

    if (cursorType === 'circle') {
      drawCircle();
      return;
    }

    // Get debounced/stable cursor data for current frame
    // This prevents rapid flickering between cursor shapes (e.g., arrow ↔ resize)
    const { cursorId, shape } = stableCursor;
    const cursorImageData = cursorId ? cursorImages[cursorId] : null;

    // Priority 1: SVG cursor (if cursorShape is detected)
    if (shape) {
      const svgImage = cursorImageCache.get(svgCacheKey(shape));
      const definition: CursorDefinition | undefined = WINDOWS_CURSORS[shape as WindowsCursorShape];

      if (svgImage && definition) {
        drawCursor(svgImage, definition);
        return;
      }
      // SVG not loaded yet - continue to check bitmap
    }

    // Priority 2: Bitmap cursor (fallback for custom cursors)
    if (cursorId && cursorImageData) {
      const bitmapImage = cursorImageCache.get(cursorId);
      if (bitmapImage) {
        drawBitmap(bitmapImage, cursorImageData.hotspotX, cursorImageData.hotspotY);
        return;
      }
      // Bitmap not loaded yet - continue to default
    }

    // Priority 3: Default arrow SVG (final fallback)
    const defaultImage = cursorImageCache.get(svgCacheKey('arrow'));
    if (defaultImage) {
      drawCursor(defaultImage, DEFAULT_CURSOR);
      return;
    }

    // Nothing loaded yet - don't clear, keep previous frame
  }, [
    cursorData,
    stableCursor,
    visible,
    cursorType,
    scale,
    containerWidth,
    containerHeight,
    videoAspectRatio,
    cursorImages,
    hideWhenIdle,
    isIdle,
    currentTimeMs,
  ]);

  // Don't render if no cursor data or not visible
  if (!hasCursorData || !visible) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 15 }}
      width={containerWidth}
      height={containerHeight}
    />
  );
});

export default CursorOverlay;
