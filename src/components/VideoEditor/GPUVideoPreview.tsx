import { memo, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { resolveResource } from '@tauri-apps/api/path';
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
import { GPUPreviewCanvas } from './GPUPreviewCanvas';
import type { SceneSegment, SceneMode, WebcamConfig, ZoomRegion, CursorRecording, CursorConfig, MaskSegment, TextSegment, VideoProject } from '../../types';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;
const selectCurrentTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.currentTimeMs;
const selectCursorRecording = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.cursorRecording;
const selectAudioConfig = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project?.audio;

/**
 * WebCodecs-accelerated preview canvas for instant scrubbing.
 * Shows pre-decoded frames during timeline scrubbing for zero-latency preview.
 * Uses RAF polling instead of state-driven updates to avoid re-render overhead.
 */
const WebCodecsCanvas = memo(function WebCodecsCanvas({
  videoPath,
  zoomRegions,
  cursorRecording,
  backgroundPadding = 0,
  rounding = 0,
  videoWidth = 1920,
  videoHeight = 1080,
}: {
  videoPath: string | null;
  zoomRegions: ZoomRegion[] | undefined;
  cursorRecording: CursorRecording | null | undefined;
  /** Background padding - when > 0, allows extended zoom range */
  backgroundPadding?: number;
  /** Corner rounding - preserves rounded corners when zooming */
  rounding?: number;
  /** Video width for calculating rounding ratio */
  videoWidth?: number;
  /** Video height for calculating rounding ratio */
  videoHeight?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number>(0);
  const [hasFrame, setHasFrame] = useState(false);

  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const { getFrame, prefetchAround, isReady } = useWebCodecsPreview(videoPath);

  // Get zoom style for the current preview time
  // Smart clamping: extended range with padding, preserves rounded corners
  const zoomStyle = useZoomPreview(zoomRegions, previewTimeMs ?? 0, cursorRecording, { backgroundPadding, rounding, videoWidth, videoHeight });

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
 * Keeps video seeked even when hidden (for mask overlay sampling).
 */
const VideoWithZoom = memo(function VideoWithZoom({
  videoRef,
  videoSrc,
  zoomRegions,
  cursorRecording,
  onVideoClick,
  hidden,
  backgroundPadding = 0,
  rounding = 0,
  videoWidth = 1920,
  videoHeight = 1080,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string;
  zoomRegions: ZoomRegion[] | undefined;
  cursorRecording: CursorRecording | null | undefined;
  onVideoClick: () => void;
  hidden?: boolean;
  /** Background padding - when > 0, allows extended zoom range */
  backgroundPadding?: number;
  /** Corner rounding - preserves rounded corners when zooming */
  rounding?: number;
  /** Video width for calculating rounding ratio */
  videoWidth?: number;
  /** Video height for calculating rounding ratio */
  videoHeight?: number;
}) {
  const currentTimeMs = usePreviewOrPlaybackTime();
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  // Smart clamping: extended range with padding, preserves rounded corners
  const zoomStyle = useZoomPreview(zoomRegions, currentTimeMs, cursorRecording, { backgroundPadding, rounding, videoWidth, videoHeight });

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
  videoWidth,
  videoHeight,
  maskSegments,
  textSegments,
  project,
  useGPUPreview,
  isPlaying,
  onVideoClick,
  backgroundPadding = 0,
  rounding = 0,
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
  /** Original video width for mask sampling */
  videoWidth: number;
  /** Original video height for mask sampling */
  videoHeight: number;
  /** Mask segments for blur/pixelate overlays */
  maskSegments: MaskSegment[] | undefined;
  /** Text segments for text overlays */
  textSegments: TextSegment[] | undefined;
  /** Full project for GPU preview */
  project: VideoProject | null;
  /** Whether to use GPU preview (renders text via glyphon) */
  useGPUPreview?: boolean;
  /** Whether currently playing (for text-only GPU mode) */
  isPlaying?: boolean;
  onVideoClick: () => void;
  /** Background padding - when > 0, allows extended zoom range */
  backgroundPadding?: number;
  /** Corner rounding - preserves rounded corners when zooming */
  rounding?: number;
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

  // Compute zoom style for GPU preview canvas (must match video zoom)
  // Smart clamping: extended range with padding, preserves rounded corners
  const zoomStyle = useZoomPreview(zoomRegions, currentTimeMs, cursorRecording, { backgroundPadding, rounding, videoWidth, videoHeight });

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
      {/* Hidden when GPU preview is active (GPU renders full frame), but kept mounted for audio sync */}
      {videoSrc && showScreen && (
        <div style={screenStyle}>
          <VideoWithZoom
            videoRef={videoRef}
            videoSrc={videoSrc}
            zoomRegions={zoomRegions}
            cursorRecording={cursorRecording}
            onVideoClick={onVideoClick}
            hidden={false}
            backgroundPadding={backgroundPadding}
            rounding={rounding}
            videoWidth={videoWidth}
            videoHeight={videoHeight}
          />
        </div>
      )}

      {/* WebCodecs preview canvas - shown during scrubbing for instant preview */}
      {showScreen && originalVideoPath && !isPlaying && (
        <div style={screenStyle}>
          <WebCodecsCanvas
            videoPath={originalVideoPath}
            zoomRegions={zoomRegions}
            cursorRecording={cursorRecording}
            backgroundPadding={backgroundPadding}
            rounding={rounding}
            videoWidth={videoWidth}
            videoHeight={videoHeight}
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

      {/* GPU Preview Canvas - renders text with glyphon for pixel-perfect preview */}
      {/* Only shown when text segments exist (Rust only sends frames when there's text) */}
      {/* During playback: renders text-only on transparent background (overlay on HTML video) */}
      {/* During scrubbing: renders full frame (video + text) */}
      {useGPUPreview && showScreen && project && textSegments && textSegments.length > 0 && (
        <GPUPreviewCanvas
          project={project}
          currentTimeMs={currentTimeMs}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          enabled={true}
          isPlaying={isPlaying}
          zoomStyle={zoomStyle}
          onError={(error) => console.error('[GPUPreview]', error)}
        />
      )}

      {/* Mask overlay - blur/pixelate regions on top of video/GPU canvas */}
      {showScreen && maskSegments && maskSegments.length > 0 && containerWidth > 0 && containerHeight > 0 && (
        <MaskOverlay
          segments={maskSegments}
          currentTimeMs={currentTimeMs}
          previewWidth={containerWidth}
          previewHeight={containerHeight}
          videoElement={videoRef.current}
          videoWidth={videoWidth}
          videoHeight={videoHeight}
          zoomStyle={zoomStyle}
        />
      )}

      {/* Text overlay - bounding boxes for interaction (GPU preview renders actual text) */}
      {showScreen && textSegments && textSegments.length > 0 && containerWidth > 0 && containerHeight > 0 && (
        <TextOverlay
          segments={textSegments}
          currentTimeMs={currentTimeMs}
          previewWidth={containerWidth}
          previewHeight={containerHeight}
          videoAspectRatio={videoAspectRatio}
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
  const systemAudioRef = useRef<HTMLAudioElement>(null);
  const micAudioRef = useRef<HTMLAudioElement>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);

  // Use selectors for stable subscriptions
  const project = useVideoEditorStore(selectProject);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);
  const currentTimeMs = useVideoEditorStore(selectCurrentTimeMs);
  const cursorRecording = useVideoEditorStore(selectCursorRecording);
  const audioConfig = useVideoEditorStore(selectAudioConfig);
  const controls = usePlaybackControls();

  // Track container size for webcam overlay positioning
  // Debounced to only update when resize settles (avoids lag during panel resize)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const newSize = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        };

        // Clear any pending update
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        // Only update state after resize settles (150ms debounce)
        debounceTimer = setTimeout(() => {
          setContainerSize(newSize);
        }, 150);
      }
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, []);

  // Convert file path to asset URL (memoized)
  const videoSrc = useMemo(() => {
    return project?.sources.screenVideo
      ? convertFileSrc(project.sources.screenVideo)
      : null;
  }, [project?.sources.screenVideo]);

  // Convert audio file paths to asset URLs (memoized)
  const systemAudioSrc = useMemo(() => {
    const src = project?.sources.systemAudio
      ? convertFileSrc(project.sources.systemAudio)
      : null;
    videoEditorLogger.debug(`[Audio] System audio path: ${project?.sources.systemAudio ?? 'none'}, src: ${src ?? 'none'}`);
    return src;
  }, [project?.sources.systemAudio]);

  const micAudioSrc = useMemo(() => {
    const src = project?.sources.microphoneAudio
      ? convertFileSrc(project.sources.microphoneAudio)
      : null;
    videoEditorLogger.debug(`[Audio] Mic audio path: ${project?.sources.microphoneAudio ?? 'none'}, src: ${src ?? 'none'}`);
    return src;
  }, [project?.sources.microphoneAudio]);

  // Get aspect ratio from project (memoized)
  const aspectRatio = useMemo(() => {
    return project?.sources.originalWidth && project?.sources.originalHeight
      ? project.sources.originalWidth / project.sources.originalHeight
      : 16 / 9;
  }, [project?.sources.originalWidth, project?.sources.originalHeight]);

  // Get background config for frame styling preview
  const backgroundConfig = project?.export?.background;
  const originalWidth = project?.sources.originalWidth ?? 1920;

  // GPU preview modes:
  // - During scrubbing (not playing): Full frame (video + text) rendered by GPU
  // - During playback: HTML video plays smoothly, GPU renders text-only overlay (transparent)
  // This gives us smooth video playback AND accurate GPU-rendered text
  const useGPUPreview = true; // Always enabled - mode changes based on isPlaying

  // Check if frame styling is enabled (has any visual effect)
  // CSS handles backgrounds as fallback until GPU background rendering is complete
  const hasFrameStyling = useMemo(() => {
    if (!backgroundConfig) return false;
    // Show frame styling if padding > 0 OR rounding > 0 OR shadow enabled OR border enabled
    return (
      backgroundConfig.padding > 0 ||
      backgroundConfig.rounding > 0 ||
      backgroundConfig.shadow?.enabled ||
      backgroundConfig.border?.enabled
    );
  }, [backgroundConfig]);

  // Resolve wallpaper ID to URL when it changes
  // backgroundConfig.wallpaper contains just the ID (e.g., "macOS/sequoia-dark")
  useEffect(() => {
    if (backgroundConfig?.bgType !== 'wallpaper' || !backgroundConfig.wallpaper) {
      setWallpaperUrl(null);
      return;
    }

    let cancelled = false;
    resolveResource(`assets/backgrounds/${backgroundConfig.wallpaper}.jpg`)
      .then(path => {
        if (!cancelled) {
          setWallpaperUrl(convertFileSrc(path));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWallpaperUrl(null);
        }
      });

    return () => { cancelled = true; };
  }, [backgroundConfig?.bgType, backgroundConfig?.wallpaper]);

  // Calculate composite dimensions including padding
  const compositeWidth = originalWidth + (backgroundConfig?.padding ?? 0) * 2;
  const compositeHeight = (project?.sources.originalHeight ?? 1080) + (backgroundConfig?.padding ?? 0) * 2;
  const compositeAspectRatio = compositeWidth / compositeHeight;

  // Calculate scale factor for preview (preview size / original size)
  // This ensures padding, rounding, etc. scale proportionally with the preview
  const previewScale = useMemo(() => {
    if (containerSize.width === 0 || originalWidth === 0) return 1;
    return containerSize.width / originalWidth;
  }, [containerSize.width, originalWidth]);

  // Helper to convert hex to rgba
  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  
  // Frame style for the video container (scaled rounding, shadow, border)
  const frameStyle = useMemo((): React.CSSProperties => {
    if (!backgroundConfig) return {};

    const style: React.CSSProperties = {};

    // Scale rounding proportionally
    const scaledRounding = backgroundConfig.rounding * previewScale;

    // Use clip-path for reliable clipping (works even with transforms on children)
    // This ensures rounded corners always appear at viewport edges during zoom
    if (scaledRounding > 0) {
      // Use clip-path: inset(0 round Xpx) for proper clipping
      if (backgroundConfig.roundingType === 'squircle') {
        // Squircle approximation
        style.clipPath = `inset(0 round ${scaledRounding * 1.2}px / ${scaledRounding}px)`;
        style.borderRadius = `${scaledRounding * 1.2}px / ${scaledRounding}px`;
      } else {
        style.clipPath = `inset(0 round ${scaledRounding}px)`;
        style.borderRadius = scaledRounding;
      }
    }

    // Shadow (scaled)
    if (backgroundConfig.shadow?.enabled) {
      const shadowSize = backgroundConfig.shadow.size * 0.5 * previewScale;
      const shadowOpacity = backgroundConfig.shadow.opacity / 100;
      const shadowBlur = backgroundConfig.shadow.blur * 0.5 * previewScale;
      style.boxShadow = `0 ${shadowSize}px ${shadowBlur * 2}px rgba(0, 0, 0, ${shadowOpacity * 0.5}), 0 ${shadowSize * 2}px ${shadowBlur * 4}px rgba(0, 0, 0, ${shadowOpacity * 0.3})`;
    }

    // Border (scaled)
    if (backgroundConfig.border?.enabled) {
      const scaledBorderWidth = Math.max(1, backgroundConfig.border.width * previewScale);
      const borderOpacity = backgroundConfig.border.opacity / 100;
      style.border = `${scaledBorderWidth}px solid ${hexToRgba(backgroundConfig.border.color, borderOpacity)}`;
    }

    return style;
  }, [backgroundConfig, previewScale]);

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
      // Set initial volume from audio config
      // Mute video if we have separate audio files (editor flow)
      const hasSeparateAudioFiles = Boolean(systemAudioSrc || micAudioSrc);
      if (hasSeparateAudioFiles) {
        video.volume = 0;
        videoEditorLogger.debug(`[Audio] Video loaded, muted (using separate audio files)`);
      } else if (audioConfig) {
        video.volume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
        videoEditorLogger.debug(`[Audio] Video loaded, volume set to ${video.volume} (embedded audio)`);
      }
    };

    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);

    return () => {
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
    };
  }, [controls, audioConfig, systemAudioSrc, micAudioSrc]);

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

  // Determine if we have separate audio files (editor flow) or embedded audio (quick capture)
  const hasSeparateAudio = Boolean(systemAudioSrc || micAudioSrc);

  // Apply volume settings to main video element
  // Only use video audio when there's no separate audio files (quick capture mode)
  useEffect(() => {
    const video = videoRef.current;
    if (video && audioConfig) {
      if (hasSeparateAudio) {
        // Mute video - audio comes from separate files
        video.volume = 0;
        videoEditorLogger.debug(`[Audio] Main video muted (using separate audio files)`);
      } else {
        // No separate audio - use embedded video audio
        const newVolume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
        video.volume = newVolume;
        videoEditorLogger.debug(`[Audio] Main video volume set to ${newVolume} (embedded audio)`);
      }
    }
  }, [audioConfig, hasSeparateAudio]);

  // Apply volume settings to separate audio elements (editor flow)
  useEffect(() => {
    const audio = systemAudioRef.current;
    if (audio && audioConfig) {
      const newVolume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
      audio.volume = newVolume;
      videoEditorLogger.debug(`[Audio] System audio volume set to ${newVolume}`);
    }
  }, [audioConfig]);

  useEffect(() => {
    const audio = micAudioRef.current;
    if (audio && audioConfig) {
      const newVolume = audioConfig.microphoneMuted ? 0 : audioConfig.microphoneVolume;
      audio.volume = newVolume;
      videoEditorLogger.debug(`[Audio] Mic audio volume set to ${newVolume}`);
    }
  }, [audioConfig]);

  // Sync audio playback with video playback
  useEffect(() => {
    const systemAudio = systemAudioRef.current;
    const micAudio = micAudioRef.current;
    const video = videoRef.current;

    if (isPlaying) {
      // Sync audio time with video before playing
      if (video) {
        const videoTime = video.currentTime;
        if (systemAudio) {
          systemAudio.currentTime = videoTime;
          systemAudio.play().catch(e => {
            videoEditorLogger.warn('System audio play failed:', e);
          });
        }
        if (micAudio) {
          micAudio.currentTime = videoTime;
          micAudio.play().catch(e => {
            videoEditorLogger.warn('Mic audio play failed:', e);
          });
        }
      }
    } else {
      // Pause audio tracks
      if (systemAudio) systemAudio.pause();
      if (micAudio) micAudio.pause();
    }
  }, [isPlaying]);

  // Seek audio when preview time or current time changes (for timeline scrubbing/clicking)
  useEffect(() => {
    if (isPlaying) return;

    const targetTime = (previewTimeMs !== null ? previewTimeMs : currentTimeMs) / 1000;

    if (systemAudioRef.current) {
      systemAudioRef.current.currentTime = targetTime;
    }
    if (micAudioRef.current) {
      micAudioRef.current.currentTime = targetTime;
    }
  }, [previewTimeMs, currentTimeMs, isPlaying]);

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
    <div className="flex items-center justify-center h-full bg-[var(--polar-snow)] overflow-hidden">
      {/* Hidden audio elements for playback */}
      {systemAudioSrc && (
        <audio
          ref={systemAudioRef}
          src={systemAudioSrc}
          preload="auto"
          style={{ display: 'none' }}
          onLoadedData={(e) => {
            const audio = e.currentTarget;
            if (audioConfig) {
              audio.volume = audioConfig.systemMuted ? 0 : audioConfig.systemVolume;
            }
          }}
        />
      )}
      {micAudioSrc && (
        <audio
          ref={micAudioRef}
          src={micAudioSrc}
          preload="auto"
          style={{ display: 'none' }}
          onLoadedData={(e) => {
            const audio = e.currentTarget;
            if (audioConfig) {
              audio.volume = audioConfig.microphoneMuted ? 0 : audioConfig.microphoneVolume;
            }
          }}
        />
      )}

      {/* Outer wrapper for background (shows when frame styling is enabled) */}
      <div
        className="flex items-center justify-center relative"
        style={{
          // Use composite aspect ratio when frame styling enabled, video aspect ratio when disabled
          aspectRatio: hasFrameStyling ? compositeAspectRatio : aspectRatio,
          maxWidth: '100%',
          maxHeight: '100%',
          padding: hasFrameStyling ? (backgroundConfig?.padding ?? 0) * previewScale : undefined,
          backgroundColor: hasFrameStyling && backgroundConfig?.bgType === 'solid' ? backgroundConfig.solidColor : undefined,
          background: hasFrameStyling && backgroundConfig?.bgType === 'gradient'
            ? `linear-gradient(${backgroundConfig.gradientAngle}deg, ${backgroundConfig.gradientStart}, ${backgroundConfig.gradientEnd})`
            : undefined,
        }}
      >
        {/* Wallpaper background layer - GPU accelerated */}
        {hasFrameStyling && backgroundConfig?.bgType === 'wallpaper' && wallpaperUrl && (
          <img
            src={wallpaperUrl}
            alt=""
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{
              objectFit: 'cover',
              willChange: 'transform',
              transform: 'translateZ(0)', // Force GPU layer
              zIndex: 0,
            }}
          />
        )}
        {/* Custom image background layer */}
        {hasFrameStyling && backgroundConfig?.bgType === 'image' && backgroundConfig.imagePath && (
          <img
            src={backgroundConfig.imagePath.startsWith('data:')
              ? backgroundConfig.imagePath  // Data URL from file upload
              : convertFileSrc(backgroundConfig.imagePath)  // File path
            }
            alt=""
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{
              objectFit: 'cover',
              willChange: 'transform',
              transform: 'translateZ(0)', // Force GPU layer
              zIndex: 0,
            }}
          />
        )}
        <div
          ref={containerRef}
          className="relative overflow-hidden z-10"
          style={{
            // When frame styling enabled: fill remaining space after padding (outer wrapper handles aspect ratio)
            // When disabled: use video aspect ratio directly
            ...(hasFrameStyling ? {
              width: '100%',
              height: '100%',
            } : {
              aspectRatio: aspectRatio,
              maxWidth: '100%',
              maxHeight: '100%',
              filter: 'drop-shadow(0 4px 16px rgba(0, 0, 0, 0.4))',
            }),
            ...frameStyle,
          }}
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
              videoWidth={project?.sources.originalWidth ?? 1920}
              videoHeight={project?.sources.originalHeight ?? 1080}
              maskSegments={project?.mask?.segments}
              textSegments={project?.text?.segments}
              project={project}
              useGPUPreview={useGPUPreview}
              isPlaying={isPlaying}
              onVideoClick={handleVideoClick}
              backgroundPadding={backgroundConfig?.padding ?? 0}
              rounding={backgroundConfig?.rounding ?? 0}
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

        </div>
      </div>
    </div>
  );
}
