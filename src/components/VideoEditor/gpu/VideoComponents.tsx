/**
 * Video helper components for GPUVideoPreview.
 *
 * These memoized components handle video display without zoom transform.
 * Zoom is applied at the frame wrapper level in SceneModeRenderer.
 */

import { memo, useRef, useEffect, useState, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useVideoEditorStore } from '../../../stores/videoEditorStore';
import { usePreviewOrPlaybackTime } from '../../../hooks/usePlaybackEngine';
import { useWebCodecsPreview } from '../../../hooks/useWebCodecsPreview';

// Selectors to prevent re-renders from unrelated store changes
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;

/**
 * WebCodecs-accelerated preview canvas for instant scrubbing.
 * Shows pre-decoded frames during timeline scrubbing for zero-latency preview.
 * Uses RAF polling instead of state-driven updates to avoid re-render overhead.
 * Zoom is applied at the frame wrapper level, not individually.
 */
export const WebCodecsCanvasNoZoom = memo(function WebCodecsCanvasNoZoom({
  videoPath,
  cropStyle,
}: {
  videoPath: string | null;
  cropStyle?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number>(0);
  const [hasFrame, setHasFrame] = useState(false);

  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const { getFrame, prefetchAround, isReady } = useWebCodecsPreview(videoPath);

  // Prefetch frames when preview position changes
  useEffect(() => {
    if (!isReady || isPlaying || previewTimeMs === null) return;
    prefetchAround(previewTimeMs);
  }, [isReady, isPlaying, previewTimeMs, prefetchAround]);

  // RAF-based canvas drawing - polls for frames without causing React re-renders
  useEffect(() => {
    if (!isReady || isPlaying || previewTimeMs === null) {
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
  }, [isReady, isPlaying, previewTimeMs, getFrame]);

  const showCanvas = !isPlaying && previewTimeMs !== null && isReady && hasFrame;

  if (!showCanvas) return null;

  // Check if crop style is applied (object-cover with position)
  const hasCrop = cropStyle && cropStyle.objectFit === 'cover';

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{
        zIndex: 5,
        objectFit: hasCrop ? 'cover' : 'contain',
        ...cropStyle,
      }}
    />
  );
});

/**
 * Memoized video element without zoom transform.
 * Zoom is applied at the frame wrapper level instead.
 * Keeps video seeked for scrubbing and mask overlay sampling.
 */
export const VideoNoZoom = memo(function VideoNoZoom({
  videoRef,
  videoSrc,
  onVideoClick,
  hidden,
  cropStyle,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string;
  onVideoClick: () => void;
  hidden?: boolean;
  cropStyle?: React.CSSProperties;
}) {
  const currentTimeMs = usePreviewOrPlaybackTime();
  const isPlaying = useVideoEditorStore(selectIsPlaying);

  // Keep video seeked even when hidden (needed for mask overlay sampling)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;

    const targetTime = currentTimeMs / 1000;
    const diff = Math.abs(video.currentTime - targetTime);

    // Seek when difference is noticeable
    if (diff > 0.05) {
      video.currentTime = targetTime;
    }
  }, [videoRef, currentTimeMs, isPlaying]);

  // Default to contain, but crop style can override with cover + position
  const hasCrop = cropStyle && cropStyle.objectFit === 'cover';

  return (
    <video
      ref={videoRef}
      src={videoSrc}
      className="w-full h-full cursor-pointer bg-[var(--polar-ice)]"
      style={{
        minWidth: 320,
        minHeight: 180,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
        objectFit: hasCrop ? 'cover' : 'contain',
        ...cropStyle,
      }}
      onClick={onVideoClick}
      playsInline
      preload="auto"
    />
  );
});

/**
 * Fullscreen webcam display for cameraOnly scene mode.
 */
export const FullscreenWebcam = memo(function FullscreenWebcam({
  webcamVideoPath,
  mirror,
  onClick,
}: {
  webcamVideoPath: string;
  mirror?: boolean;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentTimeMs = usePreviewOrPlaybackTime();
  const isPlaying = useVideoEditorStore(selectIsPlaying);

  const videoSrc = useMemo(() => convertFileSrc(webcamVideoPath), [webcamVideoPath]);

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

    // Use smaller threshold for more responsive scrubbing
    if (diff > 0.05) {
      video.currentTime = targetTime;
    }
  }, [currentTimeMs, isPlaying]);

  return (
    <video
      ref={videoRef}
      src={videoSrc}
      className="w-full h-full object-cover cursor-pointer bg-[var(--polar-mist)]"
      style={{
        transform: mirror ? 'scaleX(-1)' : 'none',
      }}
      onClick={onClick}
      muted
      playsInline
      preload="auto"
    />
  );
});
