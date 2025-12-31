import { useCallback, useRef, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Play, Pause, Volume2, VolumeX, Maximize2 } from 'lucide-react';
import { useVideoEditorStore, formatTimecode } from '../../stores/videoEditorStore';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Simple video preview using HTML5 video element.
 * GPU rendering will be added later for effects.
 */
export function GPUVideoPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const isSeekingRef = useRef(false);
  
  const {
    currentTimeMs,
    isPlaying,
    project,
    setCurrentTime,
    setIsPlaying,
  } = useVideoEditorStore();

  // Convert file path to asset URL
  const videoSrc = project?.sources.screenVideo 
    ? convertFileSrc(project.sources.screenVideo)
    : null;

  // Debug: log video source
  useEffect(() => {
    if (videoSrc) {
      console.log('[VIDEO] Source path:', project?.sources.screenVideo);
      console.log('[VIDEO] Converted URL:', videoSrc);
    }
  }, [videoSrc, project?.sources.screenVideo]);

  const currentTimecode = formatTimecode(currentTimeMs);
  const durationTimecode = project ? formatTimecode(project.timeline.durationMs) : '00:00:00';
  
  // Get aspect ratio from project
  const aspectRatio = project?.sources.originalWidth && project?.sources.originalHeight
    ? project.sources.originalWidth / project.sources.originalHeight
    : 16 / 9;

  // Handle video time updates during playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (!isSeekingRef.current) {
        setCurrentTime(video.currentTime * 1000);
      }
    };

    const onEnded = () => {
      setIsPlaying(false);
    };

    const onError = (e: Event) => {
      const videoEl = e.target as HTMLVideoElement;
      const error = videoEl.error;
      console.error('Video error:', error);
      setVideoError(error?.message || 'Failed to load video');
    };

    const onLoadedData = () => {
      setVideoError(null);
      console.log('[VIDEO] Loaded - dimensions:', video.videoWidth, 'x', video.videoHeight, 'duration:', video.duration);
    };

    const onLoadedMetadata = () => {
      console.log('[VIDEO] Metadata - dimensions:', video.videoWidth, 'x', video.videoHeight);
    };

    const onCanPlay = () => {
      console.log('[VIDEO] Can play now');
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('canplay', onCanPlay);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('canplay', onCanPlay);
    };
  }, [setCurrentTime, setIsPlaying]);

  // Sync video position when currentTimeMs changes externally (e.g., timeline scrub)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;

    const targetTime = currentTimeMs / 1000;
    const diff = Math.abs(video.currentTime - targetTime);
    
    // Only seek if difference is significant (> 100ms)
    if (diff > 0.1) {
      isSeekingRef.current = true;
      video.currentTime = targetTime;
      // Reset seeking flag after a short delay
      setTimeout(() => {
        isSeekingRef.current = false;
      }, 50);
    }
  }, [currentTimeMs, isPlaying]);

  // Sync play/pause state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying && video.paused) {
      video.play().catch(e => {
        console.error('Play failed:', e);
        setIsPlaying(false);
      });
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying, setIsPlaying]);

  // Sync mute state
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = isMuted;
    }
  }, [isMuted]);

  const handlePlayPause = useCallback(() => {
    setIsPlaying(!isPlaying);
  }, [isPlaying, setIsPlaying]);

  const handleToggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

  const handleFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.requestFullscreen?.();
    }
  }, []);

  // Click on video to play/pause
  const handleVideoClick = useCallback(() => {
    handlePlayPause();
  }, [handlePlayPause]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-full">
        {/* Video container */}
        <div className="flex-1 flex items-center justify-center bg-zinc-950 rounded-lg overflow-hidden relative">
          <div 
            className="relative bg-black rounded-md overflow-hidden"
            style={{
              aspectRatio,
              maxWidth: '100%',
              maxHeight: '100%',
              filter: 'drop-shadow(0 4px 16px rgba(0, 0, 0, 0.4))',
            }}
          >
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                className="w-full h-full object-contain cursor-pointer bg-zinc-900"
                style={{ minWidth: 320, minHeight: 180 }}
                onClick={handleVideoClick}
                playsInline
                preload="auto"
                controls
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

        {/* Controls bar */}
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

            <div className="flex items-center gap-1 text-sm font-mono">
              <span className="text-white">{currentTimecode}</span>
              <span className="text-zinc-500">/</span>
              <span className="text-zinc-400">{durationTimecode}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleToggleMute}
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
                  onClick={handleFullscreen}
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
      </div>
    </TooltipProvider>
  );
}
