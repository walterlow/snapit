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
import { useZoomPreview, getZoomStateAt } from '../../hooks/useZoomPreview';
import { WINDOWS_CURSORS, DEFAULT_CURSOR, type CursorDefinition } from '../../constants/cursors';
import { editorLogger } from '../../utils/logger';
import type { CursorRecording, CursorConfig, CursorImage, WindowsCursorShape, ZoomRegion } from '../../types';

// Default cursor config values
const DEFAULT_CURSOR_SCALE = 1.0;
const DEFAULT_CIRCLE_SIZE = 20; // Circle diameter in pixels at scale 1.0

// Cursor scaling constants - MUST match export (src-tauri/src/rendering/exporter/mod.rs)
const BASE_CURSOR_HEIGHT = 24.0; // Base cursor height in pixels
const REFERENCE_HEIGHT = 720.0;  // Reference video height for scaling

// SVG rasterization height (matches Cap's SVG_CURSOR_RASTERIZED_HEIGHT = 200)
// Larger value = higher quality when zoomed, but more memory
const SVG_RASTERIZATION_HEIGHT = 200;


interface CursorOverlayProps {
  cursorRecording: CursorRecording | null | undefined;
  cursorConfig: CursorConfig | undefined;
  /** Container width in pixels */
  containerWidth: number;
  /** Container height in pixels */
  containerHeight: number;
  /** Actual output video width (for WYSIWYG cursor scaling) */
  videoWidth: number;
  /** Actual output video height (for WYSIWYG cursor scaling) */
  videoHeight: number;
  /** Video aspect ratio (width/height) for object-contain offset calculation */
  videoAspectRatio?: number;
  /** Zoom regions for applying the same transform as the video */
  zoomRegions?: ZoomRegion[];
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
 * Load an SVG cursor by shape at high resolution.
 * Fetches the SVG, modifies dimensions for high-quality rasterization (like Cap's 200px),
 * then creates an Image from the modified SVG.
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

  // Fetch SVG and modify dimensions for high-quality rasterization
  fetch(definition.svg)
    .then(response => response.text())
    .then(svgText => {
      // Parse the SVG to get original dimensions
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgText, 'image/svg+xml');
      const svgElement = doc.querySelector('svg');

      if (!svgElement) {
        throw new Error('Invalid SVG');
      }

      // Get original dimensions
      const origWidth = parseFloat(svgElement.getAttribute('width') || '24');
      const origHeight = parseFloat(svgElement.getAttribute('height') || '24');

      // Calculate new dimensions maintaining aspect ratio (target: SVG_RASTERIZATION_HEIGHT)
      const scale = SVG_RASTERIZATION_HEIGHT / origHeight;
      const newWidth = Math.round(origWidth * scale);
      const newHeight = SVG_RASTERIZATION_HEIGHT;

      // Update SVG dimensions for high-res rasterization
      svgElement.setAttribute('width', String(newWidth));
      svgElement.setAttribute('height', String(newHeight));

      // Create data URL from modified SVG
      const serializer = new XMLSerializer();
      const modifiedSvg = serializer.serializeToString(doc);
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(modifiedSvg)}`;

      // Load as Image
      const img = new Image();
      img.onload = () => {
        cursorImageCache.set(key, img);
        onLoad();
      };
      img.onerror = () => {
        editorLogger.warn(`Failed to load high-res SVG cursor: ${shape}`);
      };
      img.src = dataUrl;
    })
    .catch(err => {
      editorLogger.warn(`Failed to fetch SVG cursor ${shape}:`, err);
      // Fallback: load at original size
      const img = new Image();
      img.onload = () => {
        cursorImageCache.set(key, img);
        onLoad();
      };
      img.src = definition.svg;
    });

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
 * Priority order (matches Cap):
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
  videoWidth: _videoWidth, // Used for aspect ratio, actual scaling uses videoHeight
  videoHeight: actualVideoHeight,
  videoAspectRatio,
  zoomRegions,
}: CursorOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentTimeMs = usePreviewOrPlaybackTime();

  // Get zoom transform - must match video exactly for cursor alignment at all zoom levels
  const zoomStyle = useZoomPreview(zoomRegions, currentTimeMs, cursorRecording);

  // Simple counter to force re-render when images load
  // This counter is included in render useEffect deps to ensure canvas redraws after SVG load
  const [imageLoadCounter, forceUpdate] = useState(0);
  const triggerUpdate = useCallback(() => forceUpdate((n) => n + 1), []);

  // Get interpolated cursor data
  const { getCursorAt, hasCursorData, cursorImages } = useCursorInterpolation(cursorRecording);

  // Default cursor shape fallback when shape detection fails.
  // Uses 'arrow' as the universal default (most common cursor in general usage).
  // Previously used "most common shape in recording" which caused issues:
  // If recording in a text editor, iBeam would be most common, so any cursor
  // without detected shape (custom cursors) would show as I-beam incorrectly.
  const fallbackCursorShape: WindowsCursorShape = 'arrow';

  // Preload SVG cursors for all shapes found in recording + default arrow
  useEffect(() => {
    // Clear bitmap cache entries when cursor images change (new project loaded)
    // SVG entries (keys starting with __svg_) are project-independent and can stay
    // Bitmap entries use cursor IDs like "cursor_0" which can collide between projects
    for (const key of cursorImageCache.keys()) {
      if (!key.startsWith('__svg_')) {
        cursorImageCache.delete(key);
      }
    }

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

  // Get current cursor shape directly from cursor data
  // Note: Cursor shape stabilization (debouncing short-lived shapes) should happen
  // at recording time in Rust (stabilize_short_lived_cursor_shapes), not here.
  // Previous debouncing logic here was buggy and caused random cursor display.
  const currentCursor = useMemo(() => {
    if (!cursorData?.cursorId) {
      return { cursorId: null, shape: null };
    }

    const cursorId = cursorData.cursorId;
    const cursorImageData = cursorImages[cursorId];
    // Use cursor's detected shape, or fallback to arrow
    const shape = cursorImageData?.cursorShape ?? fallbackCursorShape;

    return { cursorId, shape };
  }, [cursorData?.cursorId, cursorImages, fallbackCursorShape]);

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

  // Calculate current zoom scale for high-resolution canvas rendering
  const zoomScale = useMemo(() => {
    if (!zoomRegions || zoomRegions.length === 0) return 1;
    const state = getZoomStateAt(zoomRegions, currentTimeMs);
    return state.scale;
  }, [zoomRegions, currentTimeMs]);

  // Draw cursor on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cursorData || !visible || (hideWhenIdle && isIdle)) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Calculate the render scale: DPR * zoom scale
    // This ensures the cursor remains sharp when zoomed in
    const dpr = window.devicePixelRatio || 1;
    const renderScale = dpr * Math.max(1, zoomScale);

    // Set canvas size at higher resolution for sharpness
    const targetWidth = Math.round(containerWidth * renderScale);
    const targetHeight = Math.round(containerHeight * renderScale);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    // Scale the context to draw at the higher resolution
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);

    // Enable high-quality image smoothing for SVG cursor rendering
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Calculate pixel position from normalized coordinates
    // The cursor coordinates are normalized (0-1) relative to the capture region.
    // IMPORTANT: Use cursor recording dimensions (not video dimensions) for positioning,
    // as cursor coordinates are normalized to the capture region, not the video file.
    // These can differ for area selection recordings (FFmpeg may force even dimensions, etc.)
    let pixelX: number;
    let pixelY: number;
    let previewVideoHeight: number;

    // Use cursor recording's aspect ratio for cursor positioning
    // This ensures cursor positions match the capture region they were normalized to
    const cursorAspectRatio = cursorRecording?.width && cursorRecording?.height
      ? cursorRecording.width / cursorRecording.height
      : videoAspectRatio;

    if (cursorAspectRatio && cursorAspectRatio > 0) {
      // Calculate actual video bounds within the container (accounting for object-contain)
      const bounds = calculateVideoBounds(containerWidth, containerHeight, cursorAspectRatio);
      pixelX = bounds.offsetX + cursorData.x * bounds.width;
      pixelY = bounds.offsetY + cursorData.y * bounds.height;
      previewVideoHeight = bounds.height;
    } else {
      // Fallback: assume container matches video aspect ratio exactly
      pixelX = cursorData.x * containerWidth;
      pixelY = cursorData.y * containerHeight;
      previewVideoHeight = containerHeight;
    }

    // Calculate cursor size for WYSIWYG with export
    // Step 1: Calculate at EXPORT resolution (matches exporter/mod.rs exactly)
    const exportSizeScale = actualVideoHeight / REFERENCE_HEIGHT;
    const exportCursorHeight = Math.min(Math.max(BASE_CURSOR_HEIGHT * exportSizeScale * scale, 16), 256);

    // Step 2: Scale to preview resolution
    const previewScale = previewVideoHeight / actualVideoHeight;
    const finalCursorHeight = exportCursorHeight * previewScale;

    // Helper to draw circle cursor
    const drawCircle = () => {
      ctx.clearRect(0, 0, containerWidth, containerHeight);
      // Circle uses the same resolution-dependent scaling as cursor
      // Calculate at export resolution, then scale to preview
      const exportCircleSize = DEFAULT_CIRCLE_SIZE * exportSizeScale * scale;
      const radius = (exportCircleSize / 2) * previewScale;
      ctx.beginPath();
      ctx.arc(pixelX, pixelY, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    // Helper to draw cursor with image and definition (for SVG cursors)
    // SVG cursors use fractional hotspot (0-1)
    const drawCursor = (img: HTMLImageElement, def: CursorDefinition) => {
      ctx.clearRect(0, 0, containerWidth, containerHeight);
      const drawHeight = finalCursorHeight;
      const drawWidth = (img.width / img.height) * drawHeight;
      const drawX = pixelX - drawWidth * def.hotspotX;
      const drawY = pixelY - drawHeight * def.hotspotY;
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    };

    // Helper to draw bitmap cursor with pixel hotspot
    // Bitmap cursors are scaled to match finalCursorHeight (same as export)
    const drawBitmap = (img: HTMLImageElement, hotspotX: number, hotspotY: number) => {
      ctx.clearRect(0, 0, containerWidth, containerHeight);
      // Scale bitmap to finalCursorHeight, matching export formula:
      // bitmap_scale = final_cursor_height / cursor_image.height
      const bitmapScale = finalCursorHeight / img.height;
      const drawWidth = img.width * bitmapScale;
      const drawHeight = img.height * bitmapScale;
      const drawX = pixelX - hotspotX * bitmapScale;
      const drawY = pixelY - hotspotY * bitmapScale;
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    };

    if (cursorType === 'circle') {
      drawCircle();
      return;
    }

    // Get cursor data for current frame
    const { cursorId, shape } = currentCursor;
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
    currentCursor,
    visible,
    cursorType,
    scale,
    containerWidth,
    containerHeight,
    actualVideoHeight, // For WYSIWYG cursor sizing
    videoAspectRatio,
    cursorImages,
    hideWhenIdle,
    isIdle,
    currentTimeMs,
    cursorRecording?.width,
    cursorRecording?.height,
    imageLoadCounter, // Re-run when SVG/bitmap images finish loading
    zoomScale, // Re-render at higher resolution when zoomed
  ]);

  // Don't render if no cursor data or not visible
  if (!hasCursorData || !visible) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{
        zIndex: 15,
        // Use CSS dimensions for visual size (canvas internal resolution is higher for sharpness)
        width: containerWidth,
        height: containerHeight,
        // Apply the same zoom transform as the video for cursor alignment at all zoom levels
        ...zoomStyle,
      }}
    />
  );
});

export default CursorOverlay;
