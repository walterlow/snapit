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
import { UnifiedTextOverlay } from './UnifiedTextOverlay';
import type { SceneSegment, SceneMode, WebcamConfig, ZoomRegion, CursorRecording, CursorConfig, MaskSegment, TextSegment, CropConfig } from '../../types';

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
 * Zoom is applied at the frame wrapper level, not individually.
 */
const WebCodecsCanvasNoZoom = memo(function WebCodecsCanvasNoZoom({
  videoPath,
}: {
  videoPath: string | null;
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

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={{
        zIndex: 5,
      }}
    />
  );
});

/**
 * Memoized video element without zoom transform.
 * Zoom is applied at the frame wrapper level instead.
 * Keeps video seeked for scrubbing and mask overlay sampling.
 */
const VideoNoZoom = memo(function VideoNoZoom({
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
  useGPUPreview,
  isPlaying,
  onVideoClick,
  backgroundPadding = 0,
  rounding = 0,
  frameStyle,
  shadowStyle,
  cropConfig,
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
  /** Whether to use Canvas 2D text rendering */
  useGPUPreview?: boolean;
  /** Whether currently playing (for text-only GPU mode) */
  isPlaying?: boolean;
  onVideoClick: () => void;
  /** Background padding - when > 0, allows extended zoom range */
  backgroundPadding?: number;
  /** Corner rounding - preserves rounded corners when zooming */
  rounding?: number;
  /** Frame styling (rounding, border) to apply to zoom wrapper */
  frameStyle?: React.CSSProperties;
  /** Shadow styling (drop-shadow filter) to apply to outer wrapper */
  shadowStyle?: React.CSSProperties;
  /** Crop configuration for video content */
  cropConfig?: CropConfig;
}) {
  const currentTimeMs = usePreviewOrPlaybackTime();
  const scene = useInterpolatedScene(sceneSegments, defaultSceneMode, currentTimeMs);

  // Use interpolated values for smooth transitions
  const showScreen = shouldRenderScreen(scene);
  const showCursor = shouldRenderCursor(scene); // Hide cursor in Camera Only mode
  const cameraOnlyOpacity = getCameraOnlyTransitionOpacity(scene);

  // Get the original video path for WebCodecs (before convertFileSrc)
  const originalVideoPath = useVideoEditorStore((s) => s.project?.sources.screenVideo ?? null);

  // Compute zoom style for GPU preview canvas (must match video zoom)
  // Smart clamping: extended range with padding, preserves rounded corners
  const zoomStyle = useZoomPreview(zoomRegions, currentTimeMs, cursorRecording, { backgroundPadding, rounding, videoWidth, videoHeight });

  // Calculate transition styles - no CSS transitions, JS interpolation handles smoothness
  const screenStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    opacity: scene.screenOpacity,
    filter: scene.screenBlur > 0.01 ? `blur(${scene.screenBlur * 20}px)` : undefined,
  };

  // Combined frame + zoom style for the wrapper
  // The frame (rounded corners, shadow, border) zooms together with content
  // During camera-only transitions, fade out the frame to prevent zoomed content
  // from bleeding through at the edges behind the fullscreen webcam
  const frameOpacity = 1 - cameraOnlyOpacity; // Fade out frame as webcam fades in

  // When crop is enabled, the frame should have the crop aspect ratio and be centered
  // The composition container has the original video aspect ratio
  const cropEnabled = cropConfig?.enabled && cropConfig.width > 0 && cropConfig.height > 0;

  // Calculate crop aspect ratio for frame sizing
  const cropAspectRatio = cropEnabled && cropConfig
    ? cropConfig.width / cropConfig.height
    : null;

  // Only apply crop-based frame sizing when we have background padding
  // (so the cropped frame is visible against the background)
  // When no background, frame fills container and crop only affects video content
  const applyCropToFrameSize = cropEnabled && backgroundPadding > 0;

  // Calculate cropped frame dimensions to fit inside container while maintaining crop aspect
  const croppedFrameSize = useMemo(() => {
    if (!applyCropToFrameSize || !cropAspectRatio || containerWidth === 0 || containerHeight === 0) {
      return null;
    }

    const containerAspect = containerWidth / containerHeight;

    if (containerAspect > cropAspectRatio) {
      // Container is wider than crop - height constrains
      return {
        width: containerHeight * cropAspectRatio,
        height: containerHeight,
      };
    } else {
      // Container is taller than crop - width constrains
      return {
        width: containerWidth,
        height: containerWidth / cropAspectRatio,
      };
    }
  }, [applyCropToFrameSize, cropAspectRatio, containerWidth, containerHeight]);

  // Fullscreen webcam style - uses same crop sizing as the frame when crop is enabled
  const fullscreenWebcamStyle: React.CSSProperties = {
    position: 'absolute',
    zIndex: 10,
    opacity: cameraOnlyOpacity,
    filter: scene.cameraOnlyBlur > 0.01 ? `blur(${scene.cameraOnlyBlur * 10}px)` : undefined,
    // When crop is enabled with background, use crop dimensions (centered)
    // Otherwise fill container
    ...(applyCropToFrameSize && croppedFrameSize ? {
      width: croppedFrameSize.width,
      height: croppedFrameSize.height,
      left: '50%',
      top: '50%',
      transform: `translate(-50%, -50%) scale(${scene.cameraOnlyZoom})`,
    } : {
      inset: 0,
      transform: `scale(${scene.cameraOnlyZoom})`,
    }),
  };

  const frameZoomStyle: React.CSSProperties = {
    position: 'relative', // Always relative so absolutely positioned children work
    overflow: 'hidden',
    ...frameStyle,
    ...(showScreen ? zoomStyle : {}),
    opacity: frameOpacity,
    visibility: frameOpacity < 0.01 ? 'hidden' : 'visible',
    // When cropped with background: use calculated dimensions to fit inside container
    // Otherwise: fill container
    ...(applyCropToFrameSize && croppedFrameSize ? {
      width: croppedFrameSize.width,
      height: croppedFrameSize.height,
    } : {
      width: '100%',
      height: '100%',
    }),
  };

  // Video crop style - uses object-fit: cover with object-position
  // Frame already has the crop aspect ratio, so cover + position shows correct region
  const videoCropStyle: React.CSSProperties = useMemo(() => {
    if (!cropEnabled || !cropConfig) {
      return {};
    }

    // Calculate object-position to show the correct crop region
    // position = crop.offset / (video - crop) * 100%
    const overflowX = videoWidth - cropConfig.width;
    const overflowY = videoHeight - cropConfig.height;

    const posX = overflowX > 0 ? (cropConfig.x / overflowX) * 100 : 50;
    const posY = overflowY > 0 ? (cropConfig.y / overflowY) * 100 : 50;

    return {
      objectFit: 'cover' as const,
      objectPosition: `${posX}% ${posY}%`,
    };
  }, [cropEnabled, cropConfig, videoWidth, videoHeight]);

  return (
    <>
      {/* Shadow wrapper - applies drop-shadow filter (must be separate from clipped element) */}
      <div
        className="flex items-center justify-center"
        style={{
          width: '100%',
          height: '100%',
          ...shadowStyle,
        }}
      >
        {/* Frame wrapper - applies both frame styling (rounded corners) and zoom transform */}
        {/* This ensures the rounded frame moves/scales with the zoom */}
        <div style={frameZoomStyle}>
        {/* Screen video - with smooth opacity/blur transitions */}
        {videoSrc && showScreen && (
          <div style={screenStyle}>
            <VideoNoZoom
              videoRef={videoRef}
              videoSrc={videoSrc}
              onVideoClick={onVideoClick}
              hidden={false}
              cropStyle={videoCropStyle}
            />
          </div>
        )}

        {/* WebCodecs preview canvas - shown during scrubbing for instant preview */}
        {showScreen && originalVideoPath && !isPlaying && (
          <div style={screenStyle}>
            <WebCodecsCanvasNoZoom
              videoPath={originalVideoPath}
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
            videoWidth={videoWidth}
            videoHeight={videoHeight}
            videoAspectRatio={videoAspectRatio}
            zoomRegions={zoomRegions}
          />
        )}

        {/* Text rendering - Native wgpu surface (Windows) with WebSocket fallback */}
        {/* Uses same glyphon renderer as export for WYSIWYG */}
        {useGPUPreview && showScreen && textSegments && textSegments.length > 0 && containerWidth > 0 && (
          <UnifiedTextOverlay
            segments={textSegments}
            currentTime={currentTimeMs / 1000}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
            videoWidth={videoWidth}
            videoHeight={videoHeight}
            enabled={true}
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
        </div>
      </div>

      {/* Fullscreen webcam - outside the frame wrapper (not affected by zoom) */}
      {/* Apply frame styling (rounded corners, border) for visual consistency */}
      {webcamVideoPath && (
        <div style={{
          ...fullscreenWebcamStyle,
          ...frameStyle,
          overflow: 'hidden', // Clip to rounded corners
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

  // Get effective time for scene interpolation (preview time when scrubbing, current time otherwise)
  const effectiveTimeMs = previewTimeMs !== null ? previewTimeMs : currentTimeMs;

  // Get interpolated scene for webcam overlay opacity during scene transitions
  const scene = useInterpolatedScene(
    project?.scene?.segments,
    project?.scene?.defaultMode ?? 'default',
    effectiveTimeMs
  );

  // Calculate webcam overlay opacity - fades out when transitioning to camera-only mode
  const webcamOverlayOpacity = getRegularCameraTransitionOpacity(scene);

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

  // Get background and crop config for frame styling preview
  const backgroundConfig = project?.export?.background;
  const cropConfig = project?.export?.crop;
  const originalWidth = project?.sources.originalWidth ?? 1920;
  const originalHeight = project?.sources.originalHeight ?? 1080;


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
  // Composition uses ORIGINAL video dimensions - crop only affects the video frame inside
  const compositeWidth = originalWidth + (backgroundConfig?.padding ?? 0) * 2;
  const compositeHeight = originalHeight + (backgroundConfig?.padding ?? 0) * 2;
  const compositeAspectRatio = compositeWidth / compositeHeight;

  // Check if crop is enabled with background (frame will be sized to crop aspect)
  const cropEnabled = cropConfig?.enabled && cropConfig.width > 0 && cropConfig.height > 0;
  const applyCropToFrame = cropEnabled && hasFrameStyling && (backgroundConfig?.padding ?? 0) > 0;

  // Calculate cropped frame size (same logic as SceneModeRenderer)
  const croppedFrameSizeInParent = useMemo(() => {
    if (!applyCropToFrame || !cropConfig || containerSize.width === 0 || containerSize.height === 0) {
      return null;
    }

    const cropAspect = cropConfig.width / cropConfig.height;
    const containerAspect = containerSize.width / containerSize.height;

    if (containerAspect > cropAspect) {
      // Container is wider - height constrains
      return {
        width: containerSize.height * cropAspect,
        height: containerSize.height,
      };
    } else {
      // Container is taller - width constrains
      return {
        width: containerSize.width,
        height: containerSize.width / cropAspect,
      };
    }
  }, [applyCropToFrame, cropConfig, containerSize]);

  // Calculate scale factor for preview (preview size / original size)
  // When crop is enabled, scale based on cropped frame size vs crop dimensions
  // This ensures padding, rounding, etc. scale proportionally with the actual frame
  const previewScale = useMemo(() => {
    if (containerSize.width === 0 || originalWidth === 0) return 1;

    // When crop is applied to frame, use crop-based scale
    if (applyCropToFrame && croppedFrameSizeInParent && cropConfig) {
      return croppedFrameSizeInParent.width / cropConfig.width;
    }

    // Default: container-based scale
    return containerSize.width / originalWidth;
  }, [containerSize.width, originalWidth, applyCropToFrame, croppedFrameSizeInParent, cropConfig]);

  // Calculate composition size in preview coordinates (video area + padding)
  // This is used for webcam positioning so it's anchored to the full composition, not just the video
  const compositionSize = useMemo(() => {
    const scaledPadding = hasFrameStyling ? (backgroundConfig?.padding ?? 0) * previewScale : 0;
    return {
      width: containerSize.width + scaledPadding * 2,
      height: containerSize.height + scaledPadding * 2,
    };
  }, [containerSize, hasFrameStyling, backgroundConfig?.padding, previewScale]);

  // Helper to convert hex to rgba
  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  
  // Frame clipping style (rounding, border) - applied to inner frame element
  const frameClipStyle = useMemo((): React.CSSProperties => {
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

    // Border (scaled)
    if (backgroundConfig.border?.enabled) {
      const scaledBorderWidth = Math.max(1, backgroundConfig.border.width * previewScale);
      const borderOpacity = backgroundConfig.border.opacity / 100;
      style.border = `${scaledBorderWidth}px solid ${hexToRgba(backgroundConfig.border.color, borderOpacity)}`;
    }

    return style;
  }, [backgroundConfig, previewScale]);

  // Frame shadow style (drop-shadow filter) - applied to outer wrapper
  // Must be separate from clipped element so shadow renders outside the clip
  // Formula matches export shader: (size / 100) * min_frame_size * 0.3
  const frameShadowStyle = useMemo((): React.CSSProperties => {
    if (!backgroundConfig?.shadow?.enabled || containerSize.width === 0) return {};

    // Match export shader exactly: blur = (size / 100) * min_frame_size * 0.3
    const minFrameSize = Math.min(containerSize.width, containerSize.height);
    const shadowBlur = (backgroundConfig.shadow.size / 100) * minFrameSize * 0.3;
    const shadowOpacity = (backgroundConfig.shadow.opacity / 100) * 0.4;

    return {
      filter: `drop-shadow(0 0 ${shadowBlur}px rgba(0, 0, 0, ${shadowOpacity}))`,
    };
  }, [backgroundConfig, containerSize]);

  // Combined frame style for backwards compatibility (used by SceneModeRenderer)
  const frameStyle = useMemo((): React.CSSProperties => {
    return { ...frameClipStyle };
  }, [frameClipStyle]);

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
      // Restore video to actual playhead position before playing
      // (video may have been seeked to preview position during hover)
      // Read currentTimeMs directly from store to avoid adding it as dependency
      // (which would cause re-runs every frame during playback)
      const playheadTime = useVideoEditorStore.getState().currentTimeMs;
      video.currentTime = playheadTime / 1000;
      if (video.paused) {
        video.play().catch(e => {
          if (e.name === 'AbortError') return; // Expected when interrupted
          videoEditorLogger.error('Play failed:', e);
          controls.pause();
        });
      }
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

    if (isPlaying && video) {
      // Wait for video to actually start playing before syncing audio
      // This prevents audio seek from blocking video startup
      const syncAudio = () => {
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
      };

      // If video is already playing, sync immediately
      if (!video.paused) {
        syncAudio();
      } else {
        // Wait for video to start playing
        video.addEventListener('playing', syncAudio, { once: true });
        return () => video.removeEventListener('playing', syncAudio);
      }
    } else {
      // Pause audio tracks
      if (systemAudio) systemAudio.pause();
      if (micAudio) micAudio.pause();
    }
  }, [isPlaying]);

  // Seek audio when preview time or current time changes (for timeline scrubbing/clicking)
  // During playback, only seek on significant jumps (user clicking to seek, not RAF updates)
  useEffect(() => {
    const targetTime = (previewTimeMs !== null ? previewTimeMs : currentTimeMs) / 1000;

    // During playback, compare against actual audio position to detect user-initiated seeks
    // Small differences are normal drift; large jumps indicate user clicked to seek
    if (isPlaying) {
      const audioTime = systemAudioRef.current?.currentTime ?? micAudioRef.current?.currentTime ?? 0;
      const timeDiff = Math.abs(targetTime - audioTime);
      // Only seek if jump is significant (>0.5s indicates user click, not RAF update)
      if (timeDiff < 0.5) return;
    }

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
        className="flex items-center justify-center relative overflow-hidden"
        style={{
          // Use composite aspect ratio when frame styling enabled, video aspect ratio when disabled
          aspectRatio: hasFrameStyling ? compositeAspectRatio : aspectRatio,
          // Need explicit width for aspect-ratio to calculate height
          // Use 100% width, constrained by maxHeight if too tall for container
          width: '100%',
          maxHeight: '100%',
          // Padding as percentage of total width - avoids feedback loop with previewScale
          // paddingPercent = rawPadding / compositeWidth * 100
          padding: hasFrameStyling && backgroundConfig?.padding
            ? `${(backgroundConfig.padding / compositeWidth) * 100}%`
            : undefined,
          // Use only 'background' to avoid React warning about mixing shorthand/non-shorthand properties
          background: hasFrameStyling
            ? backgroundConfig?.bgType === 'solid'
              ? backgroundConfig.solidColor
              : backgroundConfig?.bgType === 'gradient'
                ? `linear-gradient(${backgroundConfig.gradientAngle}deg, ${backgroundConfig.gradientStart}, ${backgroundConfig.gradientEnd})`
                : undefined
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
          className="relative z-10 flex items-center justify-center"
          style={{
            // When frame styling enabled: fill remaining space after padding (outer wrapper handles aspect ratio)
            // When disabled: use video aspect ratio directly with explicit width for sizing
            // Note: overflow is NOT hidden here - the frame wrapper inside handles clipping
            // This allows the zoomed frame (with rounded corners) to be visible
            ...(hasFrameStyling ? {
              width: '100%',
              height: '100%',
            } : {
              aspectRatio: aspectRatio,
              width: '100%',
              maxHeight: '100%',
              filter: 'drop-shadow(0 4px 16px rgba(0, 0, 0, 0.4))',
            }),
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
              cropConfig={cropConfig}
              videoHeight={project?.sources.originalHeight ?? 1080}
              maskSegments={project?.mask?.segments}
              textSegments={project?.text?.segments}
              useGPUPreview={useGPUPreview}
              isPlaying={isPlaying}
              onVideoClick={handleVideoClick}
              backgroundPadding={backgroundConfig?.padding ?? 0}
              rounding={backgroundConfig?.rounding ?? 0}
              frameStyle={frameStyle}
              shadowStyle={frameShadowStyle}
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

        {/* Webcam overlay - positioned relative to composition (includes padding) */}
        {/* Rendered outside containerRef so it anchors to the full canvas, not just video area */}
        {/* Fades out during camera-only scene transitions (fullscreen webcam takes over) */}
        {project?.sources.webcamVideo && project?.webcam && compositionSize.width > 0 && (
          <WebcamOverlay
            webcamVideoPath={project.sources.webcamVideo}
            config={project.webcam}
            containerWidth={compositionSize.width}
            containerHeight={compositionSize.height}
            sceneOpacity={webcamOverlayOpacity}
          />
        )}
      </div>
    </div>
  );
}
