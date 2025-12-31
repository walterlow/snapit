import { memo, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Play, Pause, Volume2, VolumeX, Maximize2 } from 'lucide-react';
import { useVideoEditorStore, formatTimecode } from '../../stores/videoEditorStore';
import { usePlaybackTime, usePlaybackControls, initPlaybackEngine } from '../../hooks/usePlaybackEngine';
import { useZoomPreview } from '../../hooks/useZoomPreview';
import { WebcamOverlay } from './WebcamOverlay';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;

/**
 * Memoized timecode display - only re-renders when time changes.
 */
const TimecodeDisplay = memo(function TimecodeDisplay({ 
  durationMs 
}: { 
  durationMs: number;
}) {
  const currentTimeMs = usePlaybackTime();
  const currentTimecode = formatTimecode(currentTimeMs);
  const durationTimecode = formatTimecode(durationMs);
  
  return (
    <div className="flex items-center gap-1 text-sm font-mono">
      <span className="text-white">{currentTimecode}</span>
      <span className="text-zinc-500">/</span>
      <span className="text-zinc-400">{durationTimecode}</span>
    </div>
  );
});

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
 * Memoized controls bar - only re-renders on play state change.
 */
const ControlsBar = memo(function ControlsBar({
  videoSrc,
  durationMs,
  onToggleMute,
  onFullscreen,
  isMuted,
}: {
  videoSrc: string | null;
  durationMs: number;
  onToggleMute: () => void;
  onFullscreen: () => void;
  isMuted: boolean;
}) {
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const controls = usePlaybackControls();
  
  const handlePlayPause = useCallback(() => {
    controls.toggle();
  }, [controls]);
  
  return (
    <div className="h-12 bg-zinc-900/80 border-t border-zinc-700/50 flex items-center justify-between px-4 gap-4">
      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handlePlayPause}
              disabled={!videoSrc}
              className="h-8 w-8 text-zinc-300 hover:text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className="text-xs">{isPlaying ? 'Pause' : 'Play'} (Space)</span>
          </TooltipContent>
        </Tooltip>

        <TimecodeDisplay durationMs={durationMs} />
      </div>

      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleMute}
              className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-700"
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className="text-xs">{isMuted ? 'Unmute' : 'Mute'}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onFullscreen}
              className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-700"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className="text-xs">Fullscreen</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
});

/**
 * Main video preview component.
 * Optimized to minimize re-renders during playback.
 */
export function GPUVideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMuted, setIsMuted] = useState(false);
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

  // Sync mute state
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = isMuted;
    }
  }, [isMuted]);

  const handleToggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

  const handleFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.requestFullscreen?.();
    }
  }, []);

  const handleVideoClick = useCallback(() => {
    controls.toggle();
  }, [controls]);

  const durationMs = project?.timeline.durationMs ?? 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-full">
        {/* Video container */}
        <div className="flex-1 flex items-center justify-center bg-zinc-950 rounded-lg overflow-hidden relative">
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

        {/* Controls bar */}
        <ControlsBar
          videoSrc={videoSrc}
          durationMs={durationMs}
          onToggleMute={handleToggleMute}
          onFullscreen={handleFullscreen}
          isMuted={isMuted}
        />
      </div>
    </TooltipProvider>
  );
}
