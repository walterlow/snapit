import { memo, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Play } from 'lucide-react';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { videoEditorLogger } from '../../utils/logger';
import { usePreviewOrPlaybackTime, usePlaybackControls, initPlaybackEngine, startPlaybackLoop, stopPlaybackLoop } from '../../hooks/usePlaybackEngine';
import { useZoomPreview } from '../../hooks/useZoomPreview';
import { useInterpolatedScene, shouldRenderScreen, shouldRenderCursor, getCameraOnlyTransitionOpacity, getRegularCameraTransitionOpacity } from '../../hooks/useSceneMode';
import { useWebCodecsPreview } from '../../hooks/useWebCodecsPreview';
import { WebcamOverlay } from './WebcamOverlay';
import { CursorOverlay } from './CursorOverlay';
import { ClickHighlightOverlay } from './ClickHighlightOverlay';
import { MaskOverlay } from './MaskOverlay';
import { TextOverlay } from './TextOverlay';
import type { SceneSegment, SceneMode, WebcamConfig, ZoomRegion, CursorRecording, CursorConfig, MaskSegment, TextSegment } from '../../types';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;
const selectCurrentTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.currentTimeMs;
const selectCursorRecording = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.cursorRecording;

/**
 * WebCodecs-accelerated preview canvas for instant scrubbing.
 * Shows pre-decoded frames during timeline scrubbing for zero-latency preview.
 * Uses RAF polling instead of state-driven updates to avoid re-render overhead.
 */
const WebCodecsCanvas = memo(function WebCodecsCanvas({
  videoPath,
  zoomRegions,
  cursorRecording,
}: {
  videoPath: string | null;
  zoomRegions: ZoomRegion[] | undefined;
  cursorRecording: CursorRecording | null | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number>(0);
  const [hasFrame, setHasFrame] = useState(false);
  
  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const { getFrame, prefetchAround, isReady } = useWebCodecsPreview(videoPath);
  
  // Get zoom style for the current preview time
  const zoomStyle = useZoomPreview(zoomRegions, previewTimeMs ?? 0, cursorRecording);

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
    const maxAttempts = 10; // Stop polling after ~500ms
    
    const tryDraw = () => {
      if (!active) return;
      
      const canvas = canvasRef.current;
      if (!canvas) return;

      const frame = getFrame(previewTimeMs);
      
      if (frame) {
        // Only redraw if time changed
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
        // Frame not ready yet - poll a few more times
        attempts++;
        if (attempts < maxAttempts) {
          rafIdRef.current = requestAnimationFrame(tryDraw);
        } else {
          setHasFrame(false);
        }
      }
    };

    // Try immediately
    tryDraw();

    return () => {
      active = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [isReady, isPlaying, previewTimeMs, getFrame]);

  // Only show canvas during scrubbing when we have a cached frame
  const showCanvas = !isPlaying && previewTimeMs !== null && isReady && hasFrame;

  if (!showCanvas) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={{
        ...zoomStyle,
        zIndex: 5, // Above video but below controls
      }}
    />
  );
});

/**
 * Memoized video element with zoom transform.
 * Re-renders at 60fps via usePreviewOrPlaybackTime, syncs with scrubbing.
 * Supports auto-zoom mode that follows cursor position.
 */
const VideoWithZoom = memo(function VideoWithZoom({
  videoRef,
  videoSrc,
  zoomRegions,
  cursorRecording,
  onVideoClick,
  hidden,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string;
  zoomRegions: ZoomRegion[] | undefined;
  cursorRecording: CursorRecording | null | undefined;
  onVideoClick: () => void;
  hidden?: boolean;
}) {
  const currentTimeMs = usePreviewOrPlaybackTime();
  const zoomStyle = useZoomPreview(zoomRegions, currentTimeMs, cursorRecording);

  return (
    <video
      ref={videoRef}
      src={videoSrc}
      className="w-full h-full object-contain cursor-pointer bg-[var(--polar-ice)]"
      style={{
        minWidth: 320,
        minHeight: 180,
        ...zoomStyle,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
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
const FullscreenWebcam = memo(function FullscreenWebcam({
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

/**
 * Scene mode aware renderer that shows/hides content based on current scene mode.
 */
const SceneModeRenderer = memo(function SceneModeRenderer({
  videoRef,
  videoSrc,
  zoomRegions,
  cursorRecording,
  cursorConfig,
  webcamVideoPath,
  webcamConfig,
  sceneSegments,
  defaultSceneMode,
  containerWidth,
  containerHeight,
  videoAspectRatio,
  maskSegments,
  textSegments,
  onVideoClick,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string | null | undefined;
  zoomRegions: ZoomRegion[] | undefined;
  cursorRecording: CursorRecording | null | undefined;
  cursorConfig: CursorConfig | undefined;
  webcamVideoPath: string | undefined;
  webcamConfig: WebcamConfig | undefined;
  sceneSegments: SceneSegment[] | undefined;
  defaultSceneMode: SceneMode;
  containerWidth: number;
  containerHeight: number;
  /** Video aspect ratio for cursor offset calculation */
  videoAspectRatio: number;
  /** Mask segments for blur/pixelate overlays */
  maskSegments: MaskSegment[] | undefined;
  /** Text segments for text overlays */
  textSegments: TextSegment[] | undefined;
  onVideoClick: () => void;
}) {
  const currentTimeMs = usePreviewOrPlaybackTime();
  const scene = useInterpolatedScene(sceneSegments, defaultSceneMode, currentTimeMs);

  // Use interpolated values for smooth transitions
  const showScreen = shouldRenderScreen(scene);
  const showCursor = shouldRenderCursor(scene); // Hide cursor in Camera Only mode
  const cameraOnlyOpacity = getCameraOnlyTransitionOpacity(scene);
  // Regular webcam overlay opacity - fades at 1.5x speed during cameraOnly transitions
  const regularCameraOpacity = getRegularCameraTransitionOpacity(scene);

  // Get the original video path for WebCodecs (before convertFileSrc)
  const originalVideoPath = useVideoEditorStore((s) => s.project?.sources.screenVideo ?? null);

  // Calculate transition styles - no CSS transitions, JS interpolation handles smoothness
  const screenStyle: React.CSSProperties = {
    opacity: scene.screenOpacity,
    filter: scene.screenBlur > 0.01 ? `blur(${scene.screenBlur * 20}px)` : undefined,
  };

  const webcamOverlayStyle: React.CSSProperties = {
    opacity: regularCameraOpacity,
  };

  const fullscreenWebcamStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    opacity: cameraOnlyOpacity,
    transform: `scale(${scene.cameraOnlyZoom})`,
    filter: scene.cameraOnlyBlur > 0.01 ? `blur(${scene.cameraOnlyBlur * 10}px)` : undefined,
  };

  return (
    <>
      {/* Screen video - with smooth opacity/blur transitions */}
      {videoSrc && showScreen && (
        <div style={screenStyle}>
          <VideoWithZoom
            videoRef={videoRef}
            videoSrc={videoSrc}
            zoomRegions={zoomRegions}
            cursorRecording={cursorRecording}
            onVideoClick={onVideoClick}
            hidden={false}
          />
        </div>
      )}

      {/* WebCodecs preview canvas - shown during scrubbing for instant preview */}
      {showScreen && originalVideoPath && (
        <div style={screenStyle}>
          <WebCodecsCanvas
            videoPath={originalVideoPath}
            zoomRegions={zoomRegions}
            cursorRecording={cursorRecording}
          />
        </div>
      )}

      {/* Fullscreen webcam - always rendered (hidden when not needed) for instant scrubbing response */}
      {webcamVideoPath && (
        <div style={{
          ...fullscreenWebcamStyle,
          visibility: cameraOnlyOpacity > 0.01 ? 'visible' : 'hidden',
          pointerEvents: cameraOnlyOpacity > 0.01 ? 'auto' : 'none',
        }}>
          <FullscreenWebcam
            webcamVideoPath={webcamVideoPath}
            mirror={webcamConfig?.mirror}
            onClick={onVideoClick}
          />
        </div>
      )}

      {/* Webcam overlay - shown with regularCameraOpacity during transitions (both layers visible) */}
      {regularCameraOpacity > 0.01 && webcamVideoPath && webcamConfig && containerWidth > 0 && (
        <div style={webcamOverlayStyle}>
          <WebcamOverlay
            webcamVideoPath={webcamVideoPath}
            config={webcamConfig}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
          />
        </div>
      )}

      {/* Click highlight overlay - rendered below cursor (hidden in Camera Only mode) */}
      {showCursor && containerWidth > 0 && containerHeight > 0 && (
        <ClickHighlightOverlay
          cursorRecording={cursorRecording}
          clickHighlightConfig={cursorConfig?.clickHighlight}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          videoAspectRatio={videoAspectRatio}
          zoomRegions={zoomRegions}
        />
      )}

      {/* Cursor overlay - rendered on top of video content (hidden in Camera Only mode) */}
      {showCursor && containerWidth > 0 && containerHeight > 0 && (
        <CursorOverlay
          cursorRecording={cursorRecording}
          cursorConfig={cursorConfig}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          videoAspectRatio={videoAspectRatio}
          zoomRegions={zoomRegions}
        />
      )}

      {/* Mask overlay - blur/pixelate regions on top of video (only when screen visible) */}
      {showScreen && maskSegments && maskSegments.length > 0 && containerWidth > 0 && containerHeight > 0 && (
        <MaskOverlay
          segments={maskSegments}
          currentTimeMs={currentTimeMs}
          previewWidth={containerWidth}
          previewHeight={containerHeight}
        />
      )}

      {/* Text overlay - text annotations on top of everything (only when screen visible) */}
      {showScreen && textSegments && textSegments.length > 0 && containerWidth > 0 && containerHeight > 0 && (
        <TextOverlay
          segments={textSegments}
          currentTimeMs={currentTimeMs}
          previewWidth={containerWidth}
          previewHeight={containerHeight}
        />
      )}
    </>
  );
});

/**
 * Main video preview component.
 * Optimized to minimize re-renders during playback.
 */
export function GPUVideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Use selectors for stable subscriptions
  const project = useVideoEditorStore(selectProject);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);
  const currentTimeMs = useVideoEditorStore(selectCurrentTimeMs);
  const cursorRecording = useVideoEditorStore(selectCursorRecording);
  const controls = usePlaybackControls();

  // Track container size for webcam overlay positioning
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Convert file path to asset URL (memoized)
  const videoSrc = useMemo(() => {
    return project?.sources.screenVideo 
      ? convertFileSrc(project.sources.screenVideo)
      : null;
  }, [project?.sources.screenVideo]);
  
  // Get aspect ratio from project (memoized)
  const aspectRatio = useMemo(() => {
    return project?.sources.originalWidth && project?.sources.originalHeight
      ? project.sources.originalWidth / project.sources.originalHeight
      : 16 / 9;
  }, [project?.sources.originalWidth, project?.sources.originalHeight]);

  // Container style (memoized)
  const containerStyle = useMemo(() => ({
    aspectRatio,
    maxWidth: '100%',
    maxHeight: '100%',
    filter: 'drop-shadow(0 4px 16px rgba(0, 0, 0, 0.4))',
  }), [aspectRatio]);

  // Initialize playback engine when project loads
  useEffect(() => {
    if (project?.timeline.durationMs) {
      initPlaybackEngine(project.timeline.durationMs);
    }
  }, [project?.timeline.durationMs]);

  // Register video element with playback engine
  // Use layout effect to ensure video ref is set after child renders
  useEffect(() => {
    // Check immediately
    if (videoRef.current) {
      controls.setVideoElement(videoRef.current);
      return;
    }
    // If not available yet, check on next frame (after children render)
    const id = requestAnimationFrame(() => {
      if (videoRef.current) {
        controls.setVideoElement(videoRef.current);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [controls, videoSrc]);

  // Set duration when project loads
  useEffect(() => {
    if (project?.timeline.durationMs) {
      controls.setDuration(project.timeline.durationMs);
    }
  }, [project?.timeline.durationMs, controls]);

  // Handle video element events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Note: We don't use timeupdate for syncing time anymore.
    // The playback engine uses interpolation for smooth 60fps updates.
    // Syncing from timeupdate caused issues when preview ended (playhead jumped).

    const onEnded = () => {
      controls.pause();
    };

    const onError = (e: Event) => {
      const videoEl = e.target as HTMLVideoElement;
      const error = videoEl.error;
      videoEditorLogger.error('Video error:', error);
      setVideoError(error?.message || 'Failed to load video');
    };

    const onLoadedData = () => {
      setVideoError(null);
    };

    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);

    return () => {
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
    };
  }, [controls]);

  // Sync play/pause state from store to video element and RAF loop
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      if (video.paused) {
        video.play().catch(e => {
          videoEditorLogger.error('Play failed:', e);
          controls.pause();
        });
      }
      // Start RAF loop to update currentTimeMs in store
      startPlaybackLoop();
    } else {
      if (!video.paused) {
        video.pause();
      }
      stopPlaybackLoop();
    }
  }, [isPlaying, controls]);

  // Seek video when preview time or current time changes (for timeline scrubbing/clicking)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;

    // Use preview time when hovering, otherwise use current time (from clicking)
    const targetTime = previewTimeMs !== null ? previewTimeMs : currentTimeMs;
    video.currentTime = targetTime / 1000;
  }, [previewTimeMs, currentTimeMs, isPlaying]);

  const handleVideoClick = useCallback(() => {
    controls.toggle();
  }, [controls]);

  return (
    <div className="flex items-center justify-center h-full bg-[var(--polar-snow)] rounded-lg overflow-hidden">
      <div
        ref={containerRef}
        className="relative bg-black rounded-md overflow-hidden"
        style={containerStyle}
      >
        {videoSrc || project?.sources.webcamVideo ? (
          <SceneModeRenderer
            videoRef={videoRef}
            videoSrc={videoSrc ?? undefined}
            zoomRegions={project?.zoom?.regions}
            cursorRecording={cursorRecording}
            cursorConfig={project?.cursor}
            webcamVideoPath={project?.sources.webcamVideo ?? undefined}
            webcamConfig={project?.webcam}
            sceneSegments={project?.scene?.segments}
            defaultSceneMode={project?.scene?.defaultMode ?? 'default'}
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
            videoAspectRatio={aspectRatio}
            maskSegments={project?.mask?.segments}
            textSegments={project?.text?.segments}
            onVideoClick={handleVideoClick}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[var(--ink-subtle)]">No video loaded</span>
          </div>
        )}

        {/* Error overlay */}
        {videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
            <span className="text-[var(--error)] text-sm mb-2">Video Error</span>
            <span className="text-[var(--ink-subtle)] text-xs">{videoError}</span>
            <span className="text-[var(--ink-faint)] text-xs mt-2 max-w-xs text-center break-all">
              {videoSrc}
            </span>
          </div>
        )}

        {/* Play button overlay */}
        {!isPlaying && videoSrc && !videoError && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 hover:opacity-100 transition-opacity cursor-pointer"
            onClick={handleVideoClick}
          >
            <div className="w-16 h-16 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center">
              <Play className="w-8 h-8 text-white ml-1" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
