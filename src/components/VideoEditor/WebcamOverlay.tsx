import { memo, useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePreviewOrPlaybackTime } from '../../hooks/usePlaybackEngine';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { useWebCodecsPreview } from '../../hooks/useWebCodecsPreview';
import { webcamLogger } from '../../utils/logger';
import type { WebcamConfig, VisibilitySegment, CornerStyle } from '../../types';

const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;

interface WebcamOverlayProps {
  webcamVideoPath: string;
  config: WebcamConfig;
  containerWidth: number;
  containerHeight: number;
}

/**
 * Check if webcam should be visible at given timestamp.
 */
function isWebcamVisibleAt(segments: VisibilitySegment[], timestampMs: number): boolean {
  // If no segments defined, webcam is always visible
  if (segments.length === 0) return true;

  // Check if current time falls within any visible segment
  return segments.some(
    seg => seg.visible && timestampMs >= seg.startMs && timestampMs <= seg.endMs
  );
}

/**
 * Get position style based on position preset.
 * Handles corner presets and custom positions with proper centering.
 */
function getPositionStyle(
  position: WebcamConfig['position'],
  customX: number,
  customY: number,
  containerWidth: number,
  containerHeight: number,
  webcamWidth: number,
  webcamHeight: number
): React.CSSProperties {
  const margin = 16;

  switch (position) {
    case 'topLeft':
      return { top: margin, left: margin };
    case 'topRight':
      return { top: margin, right: margin };
    case 'bottomLeft':
      return { bottom: margin, left: margin };
    case 'bottomRight':
      return { bottom: margin, right: margin };
    case 'custom': {
      // Calculate position with centering support
      // customX/Y of 0.5 means centered on that axis
      // customX/Y near 0 or 1 means edge-aligned with margin
      let left: number;
      let top: number;

      // Horizontal positioning
      if (customX <= 0.1) {
        left = margin;
      } else if (customX >= 0.9) {
        left = containerWidth - webcamWidth - margin;
      } else {
        // Center the webcam at the specified X position
        left = customX * containerWidth - webcamWidth / 2;
      }

      // Vertical positioning
      if (customY <= 0.1) {
        top = margin;
      } else if (customY >= 0.9) {
        top = containerHeight - webcamHeight - margin;
      } else {
        // Center the webcam at the specified Y position
        top = customY * containerHeight - webcamHeight / 2;
      }

      return { top, left };
    }
    default:
      return { bottom: margin, right: margin };
  }
}

/**
 * Generate a superellipse (squircle) clip-path polygon.
 * Uses the parametric form: x = a * sign(cos(t)) * |cos(t)|^(2/n)
 * where n=4 for squircle (Cap uses power=4 in their shader).
 *
 * @param rounding - Rounding percentage (0-100), controls how much the corners are rounded
 * @param width - Width of the element in pixels (for aspect ratio calculation)
 * @param height - Height of the element in pixels (for aspect ratio calculation)
 * @param numPoints - Number of points per corner for smoothness
 */
function generateSquircleClipPath(
  rounding: number,
  width: number = 100,
  height: number = 100,
  numPoints: number = 16
): string {
  // At 0% rounding, it's a rectangle; at 100%, it's a full squircle
  // The rounding controls the "inset" of the superellipse from the corners
  const radiusFactor = (rounding / 100) * 0.5; // 0 to 0.5

  if (radiusFactor <= 0.01) {
    // Nearly rectangular, use simple polygon
    return 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';
  }

  const points: string[] = [];
  const n = 4; // Superellipse power (4 = squircle, like Cap)
  const exp = 2 / n; // = 0.5 for n=4

  // For non-square elements, we want circular corners (same pixel radius in both directions)
  // Use the smaller dimension to calculate radius, then convert to percentages
  const minDim = Math.min(width, height);
  const radiusPx = radiusFactor * minDim; // radius in pixels (based on smaller dimension)

  // Convert to percentages for clip-path
  const rx = (radiusPx / width) * 100; // radius as percentage of width
  const ry = (radiusPx / height) * 100; // radius as percentage of height

  // Helper to calculate superellipse point
  const superellipsePoint = (t: number): { x: number; y: number } => {
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const x = Math.sign(cosT) * Math.pow(Math.abs(cosT), exp);
    const y = Math.sign(sinT) * Math.pow(Math.abs(sinT), exp);
    return { x, y };
  };

  // Generate points for each corner
  // We generate a quarter arc for each corner

  // Top-right corner (t: -PI/2 to 0)
  for (let i = 0; i <= numPoints; i++) {
    const t = -Math.PI / 2 + (Math.PI / 2) * (i / numPoints);
    const p = superellipsePoint(t);
    const x = 100 - rx + p.x * rx;
    const y = ry + p.y * ry;
    points.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }

  // Bottom-right corner (t: 0 to PI/2)
  for (let i = 1; i <= numPoints; i++) {
    const t = (Math.PI / 2) * (i / numPoints);
    const p = superellipsePoint(t);
    const x = 100 - rx + p.x * rx;
    const y = 100 - ry + p.y * ry;
    points.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }

  // Bottom-left corner (t: PI/2 to PI)
  for (let i = 1; i <= numPoints; i++) {
    const t = Math.PI / 2 + (Math.PI / 2) * (i / numPoints);
    const p = superellipsePoint(t);
    const x = rx + p.x * rx;
    const y = 100 - ry + p.y * ry;
    points.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }

  // Top-left corner (t: PI to 3*PI/2)
  for (let i = 1; i <= numPoints; i++) {
    const t = Math.PI + (Math.PI / 2) * (i / numPoints);
    const p = superellipsePoint(t);
    const x = rx + p.x * rx;
    const y = ry + p.y * ry;
    points.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }

  return `polygon(${points.join(', ')})`;
}

/**
 * Generate CSS drop-shadow filter from a single shadow intensity value.
 * Creates an even spread shadow around all edges with sensible defaults.
 */
function getShadowFilter(
  shadow: number,
  width: number,
  height: number
): string {
  if (shadow <= 0) return 'none';

  const minDim = Math.min(width, height);
  const strength = shadow / 100;

  // Sensible defaults baked in:
  // - Blur scales with size for natural look
  // - Opacity stays subtle but visible
  const blur = strength * minDim * 0.15;
  const opacity = strength * 0.5; // Max 50% opacity at full strength

  // CSS drop-shadow with 0 offset for even spread around all edges
  return `drop-shadow(0 0 ${blur}px rgba(0, 0, 0, ${opacity}))`;
}

/**
 * Get shape style based on shape, rounding percentage, and corner style.
 * Implements proper squircle (superellipse) support like Cap.
 *
 * @param shape - The shape type (circle, roundedRectangle, rectangle, source)
 * @param rounding - Rounding percentage (0-100)
 * @param cornerStyle - Corner style (squircle or rounded)
 * @param width - Width of the element in pixels
 * @param height - Height of the element in pixels
 */
function getShapeStyle(
  shape: WebcamConfig['shape'],
  rounding: number,
  _cornerStyle: CornerStyle,
  width: number,
  height: number
): React.CSSProperties {
  switch (shape) {
    case 'circle':
      // True circle - always use borderRadius: 50%
      return { borderRadius: '50%' };

    case 'roundedRectangle': {
      // Squircle - use superellipse clip-path for proper squircle corners
      // The rounding controls how rounded the corners are (0-100%)
      return { clipPath: generateSquircleClipPath(rounding, width, height) };
    }

    case 'source': {
      // Source: native aspect ratio with configurable rounding
      // 0% rounding = sharp rectangle, 100% = full squircle
      if (rounding <= 2) {
        return { borderRadius: '0' };
      }
      return { clipPath: generateSquircleClipPath(rounding, width, height) };
    }

    case 'rectangle':
      // No rounding - sharp corners
      return { borderRadius: '0' };

    default:
      return { borderRadius: '50%' };
  }
}

/**
 * Webcam overlay component that syncs with playback time.
 * Supports proper squircle shapes using CSS clip-path with superellipse.
 */
export const WebcamOverlay = memo(function WebcamOverlay({
  webcamVideoPath,
  config,
  containerWidth,
  containerHeight,
}: WebcamOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number>(0);

  const currentTimeMs = usePreviewOrPlaybackTime();
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);

  // WebCodecs preview for instant scrubbing
  const { getFrame, prefetchAround, isReady: webCodecsReady } = useWebCodecsPreview(webcamVideoPath);
  const [hasFrame, setHasFrame] = useState(false);

  // Track native video dimensions for "source" shape
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);

  // Callback to update dimensions from video element
  const updateVideoDimensions = useCallback((video: HTMLVideoElement) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const newDims = { width: video.videoWidth, height: video.videoHeight };
      setVideoDimensions(prev => {
        // Only update if different to avoid unnecessary re-renders
        if (prev?.width !== newDims.width || prev?.height !== newDims.height) {
          return newDims;
        }
        return prev;
      });
    }
  }, []);

  // Try to get dimensions from video ref (handles already-loaded videos)
  // Only run once on mount, not every render
  useEffect(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 1) {
      updateVideoDimensions(video);
    }
  }, [updateVideoDimensions]);

  // Check visibility at current time
  const isVisible = useMemo(() => {
    if (!config.enabled) return false;
    return isWebcamVisibleAt(config.visibilitySegments, currentTimeMs);
  }, [config.enabled, config.visibilitySegments, currentTimeMs]);

  // Prefetch frames when preview position changes (scrubbing)
  useEffect(() => {
    if (!webCodecsReady || isPlaying || previewTimeMs === null) return;
    prefetchAround(previewTimeMs);
  }, [webCodecsReady, isPlaying, previewTimeMs, prefetchAround]);

  // RAF-based canvas drawing for WebCodecs preview frames
  useEffect(() => {
    if (!webCodecsReady || isPlaying || previewTimeMs === null) {
      setHasFrame(false);
      return;
    }

    let active = true;
    let attempts = 0;
    const maxAttempts = 10;

    const tryDraw = () => {
      if (!active) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const frame = getFrame(previewTimeMs);

      if (frame) {
        if (lastDrawnTimeRef.current !== previewTimeMs) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            if (canvas.width !== frame.width || canvas.height !== frame.height) {
              canvas.width = frame.width;
              canvas.height = frame.height;
            }
            ctx.drawImage(frame, 0, 0);
            lastDrawnTimeRef.current = previewTimeMs;
          }
        }
        setHasFrame(true);
      } else {
        attempts++;
        if (attempts < maxAttempts) {
          rafIdRef.current = requestAnimationFrame(tryDraw);
        } else {
          setHasFrame(false);
        }
      }
    };

    tryDraw();

    return () => {
      active = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [webCodecsReady, isPlaying, previewTimeMs, getFrame]);

  // Convert file path to asset URL
  const videoSrc = useMemo(() => convertFileSrc(webcamVideoPath), [webcamVideoPath]);

  // Calculate webcam dimensions based on shape
  // - Source: uses native video aspect ratio with squircle rounding (like Cap)
  // - Rectangle: forces 16:9 aspect ratio
  // - Circle/RoundedRectangle: forces 1:1 square
  const { webcamWidth, webcamHeight } = useMemo(() => {
    const baseSize = containerWidth * config.size;

    if (config.shape === 'source' && videoDimensions) {
      // Source shape: preserve native webcam aspect ratio (like Cap)
      const aspect = videoDimensions.width / videoDimensions.height;
      if (aspect >= 1.0) {
        // Landscape webcam: width = base * aspect, height = base
        return { webcamWidth: baseSize * aspect, webcamHeight: baseSize };
      } else {
        // Portrait webcam: width = base, height = base / aspect
        return { webcamWidth: baseSize, webcamHeight: baseSize / aspect };
      }
    } else if (config.shape === 'rectangle') {
      // Rectangle: force 16:9 aspect ratio
      return { webcamWidth: baseSize * (16 / 9), webcamHeight: baseSize };
    } else {
      // Circle, RoundedRectangle, or Source (before video loads): force 1:1 square
      return { webcamWidth: baseSize, webcamHeight: baseSize };
    }
  }, [containerWidth, config.size, config.shape, videoDimensions]);

  // Position style
  const positionStyle = useMemo(() =>
    getPositionStyle(
      config.position,
      config.customX,
      config.customY,
      containerWidth,
      containerHeight,
      webcamWidth,
      webcamHeight
    ),
    [config.position, config.customX, config.customY, containerWidth, containerHeight, webcamWidth, webcamHeight]
  );

  // Shape style - calculate shape from rounding percentage and corner style
  const shapeStyle = useMemo(
    () => getShapeStyle(config.shape, config.rounding, config.cornerStyle, webcamWidth, webcamHeight),
    [config.shape, config.rounding, config.cornerStyle, webcamWidth, webcamHeight]
  );

  // Border style
  const borderStyle = useMemo((): React.CSSProperties => {
    if (!config.border.enabled) return {};
    return {
      border: `${config.border.width}px solid ${config.border.color}`,
    };
  }, [config.border]);

  // Shadow filter - single slider controls everything
  const shadowFilter = useMemo(
    () => getShadowFilter(config.shadow, webcamWidth, webcamHeight),
    [config.shadow, webcamWidth, webcamHeight]
  );

  // Sync webcam video play/pause state with main playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying && video.paused) {
      // Read current time once from store, don't subscribe to updates
      const targetTime = useVideoEditorStore.getState().currentTimeMs / 1000;
      video.currentTime = targetTime;
      video.play().catch(() => {});
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying]); // Remove currentTimeMs - only respond to play/pause changes

  // Seek webcam video when scrubbing (not playing)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;

    const targetTime = currentTimeMs / 1000;
    const diff = Math.abs(video.currentTime - targetTime);

    // Only seek if difference is significant
    if (diff > 0.1) {
      video.currentTime = targetTime;
    }
  }, [currentTimeMs, isPlaying]);

  if (!isVisible) {
    return null;
  }

  return (
    // Outer wrapper for shadow filter (must be separate from clipped element)
    <div
      className="absolute z-20"
      style={{
        width: webcamWidth,
        height: webcamHeight,
        ...positionStyle,
        filter: shadowFilter,
      }}
    >
      {/* Inner container with shape clipping and border */}
      <div
        className="w-full h-full overflow-hidden"
        style={{
          ...shapeStyle,
          ...borderStyle,
        }}
      >
        <video
          ref={videoRef}
          src={videoSrc}
          className="w-full h-full object-cover bg-zinc-800"
          style={{
            // Mirror flips horizontally
            transform: config.mirror ? 'scaleX(-1)' : 'none',
          }}
          muted
          playsInline
          preload="auto"
          onError={(e) => {
            webcamLogger.error('Video load error:', e.currentTarget.error);
          }}
          onLoadedMetadata={(e) => {
            updateVideoDimensions(e.currentTarget);
          }}
          onLoadedData={(e) => {
            // Also try here in case metadata event was missed
            updateVideoDimensions(e.currentTarget);
          }}
        />
        {/* WebCodecs preview canvas - shown during scrubbing for instant preview */}
        {!isPlaying && previewTimeMs !== null && webCodecsReady && hasFrame && (
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            style={{
              transform: config.mirror ? 'scaleX(-1)' : 'none',
            }}
          />
        )}
      </div>
    </div>
  );
});
