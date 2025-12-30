import { useCallback, useRef, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, Pause, Volume2, VolumeX, Maximize2, Loader2 } from 'lucide-react';
import { useVideoEditorStore, formatTimecode } from '../../stores/videoEditorStore';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface VideoPreviewProps {
  width: number;
  height: number;
}

/**
 * VideoPreview - Displays the video preview at the current playhead position.
 * Uses FFmpeg via Tauri to extract frames for display.
 */
export function VideoPreview({ width, height }: VideoPreviewProps) {
  const { currentTimeMs, isPlaying, project, togglePlayback, setCurrentTime, setIsPlaying } = useVideoEditorStore();
  const [isMuted, setIsMuted] = useState(false);
  const [frameData, setFrameData] = useState<string | null>(null);
  const [isLoadingFrame, setIsLoadingFrame] = useState(false);
  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(-1);

  // Format current time for display
  const currentTimecode = formatTimecode(currentTimeMs);
  const durationTimecode = project ? formatTimecode(project.timeline.durationMs) : '00:00:00';
  const aspectRatio = width && height ? width / height : 16 / 9;

  // Get video path from project
  const videoPath = project?.sources.screenVideo;

  // Extract frame when playhead position changes (debounced)
  useEffect(() => {
    if (!videoPath || !project) return;

    // Only extract frame if time changed significantly (100ms tolerance for cache)
    const timeDiff = Math.abs(currentTimeMs - lastFrameTimeRef.current);
    if (timeDiff < 100 && frameData) return;

    let cancelled = false;

    const extractFrame = async () => {
      // Don't show loading indicator during playback (too flashy)
      if (!isPlaying) {
        setIsLoadingFrame(true);
      }

      try {
        const base64Data = await invoke<string>('extract_frame', {
          videoPath,
          timestampMs: Math.floor(currentTimeMs),
          maxWidth: Math.min(1280, width * 2), // Max 1280 or 2x display size
          toleranceMs: 100,
        });

        if (!cancelled) {
          setFrameData(base64Data);
          lastFrameTimeRef.current = currentTimeMs;
        }
      } catch (error) {
        console.error('Failed to extract frame:', error);
      } finally {
        if (!cancelled) {
          setIsLoadingFrame(false);
        }
      }
    };

    // Debounce frame extraction during scrubbing
    const timeoutId = setTimeout(extractFrame, isPlaying ? 0 : 50);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [currentTimeMs, videoPath, project, isPlaying, width, frameData]);

  // Clear frame cache when component unmounts or video changes
  useEffect(() => {
    return () => {
      if (videoPath) {
        invoke('clear_video_frame_cache', { videoPath }).catch(console.error);
      }
    };
  }, [videoPath]);

  // Playback loop - advances time while playing
  useEffect(() => {
    if (isPlaying && project) {
      lastTimeRef.current = performance.now();
      
      const animate = (timestamp: number) => {
        const deltaMs = timestamp - lastTimeRef.current;
        lastTimeRef.current = timestamp;
        
        const newTime = currentTimeMs + deltaMs;
        
        if (newTime >= project.timeline.durationMs) {
          setCurrentTime(project.timeline.durationMs);
          setIsPlaying(false);
        } else {
          setCurrentTime(newTime);
          animationRef.current = requestAnimationFrame(animate);
        }
      };
      
      animationRef.current = requestAnimationFrame(animate);
      
      return () => {
        if (animationRef.current) {
          cancelAnimationFrame(animationRef.current);
        }
      };
    }
  }, [isPlaying, currentTimeMs, project, setCurrentTime, setIsPlaying]);

  const handlePlayPause = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  const handleToggleMute = useCallback(() => {
    setIsMuted(!isMuted);
  }, [isMuted]);

  const handleFullscreen = useCallback(() => {
    // Would trigger fullscreen preview - implementation depends on Tauri window handling
    console.log('Fullscreen preview requested');
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-full">
        {/* Video container */}
        <div className="flex-1 flex items-center justify-center bg-zinc-950 rounded-lg overflow-hidden relative">
          {/* Aspect ratio container */}
          <div 
            className="relative bg-black rounded-md overflow-hidden shadow-2xl"
            style={{
              aspectRatio,
              maxWidth: '100%',
              maxHeight: '100%',
            }}
          >
            {/* Frame display or placeholder */}
            {frameData ? (
              <img
                src={`data:image/jpeg;base64,${frameData}`}
                alt="Video frame"
                className="w-full h-full object-contain"
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900">
                {/* Grid pattern */}
                <div 
                  className="absolute inset-0 opacity-10"
                  style={{
                    backgroundImage: `
                      linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
                    `,
                    backgroundSize: '40px 40px',
                  }}
                />
                
                {/* Timecode overlay */}
                <div className="relative z-10 text-center">
                  {isLoadingFrame ? (
                    <Loader2 className="w-8 h-8 text-zinc-400 animate-spin mb-2" />
                  ) : (
                    <div className="text-4xl font-mono text-zinc-400 tracking-wider mb-2">
                      {currentTimecode}
                    </div>
                  )}
                  <div className="text-sm text-zinc-500">
                    {videoPath ? 'Loading preview...' : 'No video loaded'}
                  </div>
                </div>

                {/* Corner markers */}
                <div className="absolute top-4 left-4 w-6 h-6 border-l-2 border-t-2 border-coral-400/50" />
                <div className="absolute top-4 right-4 w-6 h-6 border-r-2 border-t-2 border-coral-400/50" />
                <div className="absolute bottom-4 left-4 w-6 h-6 border-l-2 border-b-2 border-coral-400/50" />
                <div className="absolute bottom-4 right-4 w-6 h-6 border-r-2 border-b-2 border-coral-400/50" />
              </div>
            )}

            {/* Loading overlay during frame extraction */}
            {isLoadingFrame && frameData && (
              <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
            )}

            {/* Playback overlay controls */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity duration-200 bg-black/30">
              <button
                onClick={handlePlayPause}
                className="w-16 h-16 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-all duration-200 hover:scale-105"
              >
                {isPlaying ? (
                  <Pause className="w-8 h-8 text-white" />
                ) : (
                  <Play className="w-8 h-8 text-white ml-1" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Playback controls bar */}
        <div className="h-12 bg-zinc-900/80 border-t border-zinc-700/50 flex items-center justify-between px-4 gap-4">
          {/* Left: Play/Pause and Timecode */}
          <div className="flex items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handlePlayPause}
                  className="h-8 w-8 text-zinc-300 hover:text-white hover:bg-zinc-700"
                >
                  {isPlaying ? (
                    <Pause className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4 ml-0.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{isPlaying ? 'Pause' : 'Play'}</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Space</kbd>
                </div>
              </TooltipContent>
            </Tooltip>

            <div className="flex items-center gap-1 text-sm font-mono">
              <span className="text-white">{currentTimecode}</span>
              <span className="text-zinc-500">/</span>
              <span className="text-zinc-400">{durationTimecode}</span>
            </div>
          </div>

          {/* Right: Volume and Fullscreen */}
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleToggleMute}
                  className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-700"
                >
                  {isMuted ? (
                    <VolumeX className="w-4 h-4" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
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
