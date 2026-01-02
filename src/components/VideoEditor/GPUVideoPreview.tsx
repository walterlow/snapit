import { memo, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Play } from 'lucide-react';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { usePreviewOrPlaybackTime, usePlaybackControls, initPlaybackEngine, startPlaybackLoop, stopPlaybackLoop } from '../../hooks/usePlaybackEngine';
import { useZoomPreview } from '../../hooks/useZoomPreview';
import { useSceneMode } from '../../hooks/useSceneMode';
import { WebcamOverlay } from './WebcamOverlay';
import type { SceneSegment, SceneMode, WebcamConfig, ZoomRegion, CursorRecording } from '../../types';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;
const selectCurrentTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.currentTimeMs;
const selectCursorRecording = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.cursorRecording;

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
      className="w-full h-full object-contain cursor-pointer bg-zinc-900"
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

    if (diff > 0.1) {
      video.currentTime = targetTime;
    }
  }, [currentTimeMs, isPlaying]);

  return (
    <div className="absolute inset-0 z-10">
      <video
        ref={videoRef}
        src={videoSrc}
        className="w-full h-full object-cover cursor-pointer bg-zinc-800"
        style={{
          transform: mirror ? 'scaleX(-1)' : 'none',
        }}
        onClick={onClick}
        muted
        playsInline
        preload="auto"
      />
    </div>
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
  webcamVideoPath,
  webcamConfig,
  sceneSegments,
  defaultSceneMode,
  containerWidth,
  containerHeight,
  onVideoClick,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string | null | undefined;
  zoomRegions: ZoomRegion[] | undefined;
  cursorRecording: CursorRecording | null | undefined;
  webcamVideoPath: string | undefined;
  webcamConfig: WebcamConfig | undefined;
  sceneSegments: SceneSegment[] | undefined;
  defaultSceneMode: SceneMode;
  containerWidth: number;
  containerHeight: number;
  onVideoClick: () => void;
}) {
  const currentTimeMs = usePreviewOrPlaybackTime();
  const sceneMode = useSceneMode(sceneSegments, defaultSceneMode, currentTimeMs);

  const showScreen = sceneMode !== 'cameraOnly';
  const showWebcam = sceneMode !== 'screenOnly';
  const webcamFullscreen = sceneMode === 'cameraOnly';

  return (
    <>
      {/* Screen video - hidden when cameraOnly */}
      {videoSrc && (
        <VideoWithZoom
          videoRef={videoRef}
          videoSrc={videoSrc}
          zoomRegions={zoomRegions}
          cursorRecording={cursorRecording}
          onVideoClick={onVideoClick}
          hidden={!showScreen}
        />
      )}

      {/* Fullscreen webcam - shown when cameraOnly */}
      {webcamFullscreen && webcamVideoPath && (
        <FullscreenWebcam
          webcamVideoPath={webcamVideoPath}
          mirror={webcamConfig?.mirror}
          onClick={onVideoClick}
        />
      )}

      {/* Webcam overlay - shown when default mode (not screenOnly or cameraOnly) */}
      {showWebcam && !webcamFullscreen && webcamVideoPath && webcamConfig && containerWidth > 0 && (
        <WebcamOverlay
          webcamVideoPath={webcamVideoPath}
          config={webcamConfig}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
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
      console.error('Video error:', error);
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
          console.error('Play failed:', e);
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
    <div className="flex items-center justify-center h-full bg-zinc-950 rounded-lg overflow-hidden">
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
            webcamVideoPath={project?.sources.webcamVideo ?? undefined}
            webcamConfig={project?.webcam}
            sceneSegments={project?.scene?.segments}
            defaultSceneMode={project?.scene?.defaultMode ?? 'default'}
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
            onVideoClick={handleVideoClick}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-zinc-500">No video loaded</span>
          </div>
        )}

        {/* Error overlay */}
        {videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
            <span className="text-red-400 text-sm mb-2">Video Error</span>
            <span className="text-zinc-500 text-xs">{videoError}</span>
            <span className="text-zinc-600 text-xs mt-2 max-w-xs text-center break-all">
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
