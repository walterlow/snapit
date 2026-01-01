import { memo, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Play } from 'lucide-react';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { usePlaybackTime, usePlaybackControls, initPlaybackEngine } from '../../hooks/usePlaybackEngine';
import { useZoomPreview } from '../../hooks/useZoomPreview';
import { WebcamOverlay } from './WebcamOverlay';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;

/**
 * Memoized video element with zoom transform.
 * Re-renders at 60fps via usePlaybackTime, but only the transform changes.
 */
const VideoWithZoom = memo(function VideoWithZoom({
  videoRef,
  videoSrc,
  zoomRegions,
  onVideoClick,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string;
  zoomRegions: Parameters<typeof useZoomPreview>[0];
  onVideoClick: () => void;
}) {
  const currentTimeMs = usePlaybackTime();
  const zoomStyle = useZoomPreview(zoomRegions, currentTimeMs);
  
  return (
    <video
      ref={videoRef}
      src={videoSrc}
      className="w-full h-full object-contain cursor-pointer bg-zinc-900"
      style={{ 
        minWidth: 320, 
        minHeight: 180,
        ...zoomStyle,
      }}
      onClick={onVideoClick}
      playsInline
      preload="auto"
    />
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
  useEffect(() => {
    controls.setVideoElement(videoRef.current);
  }, [controls]);

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

    const onTimeUpdate = () => {
      // Sync time from video element to playback engine
      controls.syncFromVideo(video.currentTime * 1000);
    };

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

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
    };
  }, [controls]);

  // Sync play/pause state from store to video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying && video.paused) {
      video.play().catch(e => {
        console.error('Play failed:', e);
        controls.pause();
      });
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying, controls]);

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
        {videoSrc ? (
          <VideoWithZoom
            videoRef={videoRef}
            videoSrc={videoSrc}
            zoomRegions={project?.zoom?.regions}
            onVideoClick={handleVideoClick}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-zinc-500">No video loaded</span>
          </div>
        )}

        {/* Webcam overlay */}
        {project?.sources.webcamVideo && project.webcam && containerSize.width > 0 && (
          <WebcamOverlay
            webcamVideoPath={project.sources.webcamVideo}
            config={project.webcam}
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
          />
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
