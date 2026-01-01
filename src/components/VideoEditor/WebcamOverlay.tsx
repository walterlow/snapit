import { memo, useMemo, useRef, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlaybackTime } from '../../hooks/usePlaybackEngine';
import type { WebcamConfig, VisibilitySegment } from '../../types';

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
 * Get shape style based on shape preset.
 * Uses larger radius for roundedRectangle (squircle effect like Cap).
 */
function getShapeStyle(shape: WebcamConfig['shape']): React.CSSProperties {
  switch (shape) {
    case 'circle':
      return { borderRadius: '50%' };
    case 'roundedRectangle':
      // Squircle-style radius like Cap uses (rounded-3xl = 24px)
      return { borderRadius: '24px' };
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
  const currentTimeMs = usePlaybackTime();
  
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
  
  // Shape style
  const shapeStyle = useMemo(() => getShapeStyle(config.shape), [config.shape]);
  
  // Border style
  const borderStyle = useMemo((): React.CSSProperties => {
    if (!config.border.enabled) return {};
    return {
      border: `${config.border.width}px solid ${config.border.color}`,
    };
  }, [config.border]);
  
  // Sync webcam video time with main playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    
    const targetTime = currentTimeMs / 1000;
    const diff = Math.abs(video.currentTime - targetTime);
    
    // Only seek if difference is significant
    if (diff > 0.1) {
      video.currentTime = targetTime;
    }
  }, [currentTimeMs]);
  
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
        filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.4))',
      }}
    >
      <video
        ref={videoRef}
        src={videoSrc}
        className="w-full h-full object-cover bg-zinc-800"
        style={{
          transform: config.mirror ? 'scaleX(-1)' : 'none',
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
