import { memo, useMemo, useRef, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePreviewOrPlaybackTime } from '../../hooks/usePlaybackEngine';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import type { WebcamConfig, VisibilitySegment } from '../../types';

const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;

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
 * Calculate border radius from rounding percentage like Cap.
 * At 100%, radius = 50% of min dimension (perfect circle/squircle).
 */
function calculateRadius(rounding: number, width: number, height: number): number {
  const minDim = Math.min(width, height);
  return (rounding / 100) * 0.5 * minDim;
}

/**
 * Generate CSS drop-shadow filter from shadow settings like Cap.
 * Uses shadow strength as a multiplier for size, opacity, and blur.
 */
function getShadowFilter(
  shadow: number,
  shadowConfig: WebcamConfig['shadowConfig'],
  width: number,
  height: number
): string {
  if (shadow <= 0) return 'none';
  
  const minDim = Math.min(width, height);
  const strength = shadow / 100;
  
  // Calculate shadow parameters like Cap
  const size = strength * (shadowConfig.size / 100) * minDim * 0.3;
  const opacity = strength * (shadowConfig.opacity / 100);
  const blur = strength * (shadowConfig.blur / 100) * minDim * 0.5;
  
  // CSS drop-shadow: offset-x offset-y blur-radius color
  return `drop-shadow(0 ${size}px ${blur}px rgba(0, 0, 0, ${opacity}))`;
}

/**
 * Get shape style based on shape, rounding percentage, and corner style.
 * Matches Cap's approach: percentage-based rounding with squircle/rounded option.
 */
function getShapeStyle(
  shape: WebcamConfig['shape'],
  rounding: number,
  _cornerStyle: WebcamConfig['cornerStyle'],
  width: number,
  height: number
): React.CSSProperties {
  switch (shape) {
    case 'circle':
      return { borderRadius: '50%' };
    case 'roundedRectangle': {
      // Calculate radius from percentage like Cap
      const radiusPx = calculateRadius(rounding, width, height);
      return { borderRadius: `${radiusPx}px` };
    }
    case 'rectangle':
      return { borderRadius: '0' };
    default:
      return { borderRadius: '50%' };
  }
}

/**
 * Webcam overlay component that syncs with playback time.
 */
export const WebcamOverlay = memo(function WebcamOverlay({
  webcamVideoPath,
  config,
  containerWidth,
  containerHeight,
}: WebcamOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentTimeMs = usePreviewOrPlaybackTime();
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  
  // Debug: log webcam config on mount
  useEffect(() => {
    console.log('[WEBCAM] Config:', {
      path: webcamVideoPath,
      enabled: config.enabled,
      position: config.position,
      size: config.size,
      segments: config.visibilitySegments,
    });
  }, [webcamVideoPath, config]);
  
  // Check visibility at current time
  const isVisible = useMemo(() => {
    // Always show if enabled and no segments defined
    if (!config.enabled) {
      console.log('[WEBCAM] Hidden: not enabled');
      return false;
    }
    const visible = isWebcamVisibleAt(config.visibilitySegments, currentTimeMs);
    return visible;
  }, [config.enabled, config.visibilitySegments, currentTimeMs]);
  
  // Convert file path to asset URL
  const videoSrc = useMemo(() => {
    const src = convertFileSrc(webcamVideoPath);
    console.log('[WEBCAM] Video src:', src);
    return src;
  }, [webcamVideoPath]);
  
  // Calculate size - height stays consistent, rectangle extends width
  const baseSize = containerWidth * config.size;
  const isRectangle = config.shape === 'rectangle';
  // For rectangle: extend width to 16:9 while keeping same height
  // For circle/squircle: keep it square
  const webcamWidth = isRectangle ? baseSize * (16 / 9) : baseSize;
  const webcamHeight = baseSize;
  
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
  
  // Shape style - calculate radius from rounding percentage like Cap
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
  
  // Shadow filter - calculated from shadow settings like Cap
  const shadowFilter = useMemo(
    () => getShadowFilter(config.shadow, config.shadowConfig, webcamWidth, webcamHeight),
    [config.shadow, config.shadowConfig, webcamWidth, webcamHeight]
  );
  
  // Sync webcam video play/pause state with main playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying && video.paused) {
      // Sync time before playing to ensure alignment
      video.currentTime = currentTimeMs / 1000;
      video.play().catch(() => {});
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying, currentTimeMs]);

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
    <div
      className="absolute overflow-hidden z-20"
      style={{
        width: webcamWidth,
        height: webcamHeight,
        ...positionStyle,
        ...shapeStyle,
        ...borderStyle,
        filter: shadowFilter,
      }}
    >
      <video
        ref={videoRef}
        src={videoSrc}
        className="w-full h-full object-cover bg-zinc-800"
        style={{
          // Scale up 1.2x for squircle to fill corners (superellipse clips inside bounding box)
          // Mirror flips horizontally
          transform: `${config.shape === 'roundedRectangle' ? 'scale(1.2)' : ''} ${config.mirror ? 'scaleX(-1)' : ''}`.trim() || 'none',
        }}
        muted
        playsInline
        preload="auto"
        onError={(e) => {
          console.error('[WEBCAM] Video load error:', e.currentTarget.error);
        }}
        onLoadedData={() => {
          console.log('[WEBCAM] Video loaded OK');
        }}
      />
    </div>
  );
});
