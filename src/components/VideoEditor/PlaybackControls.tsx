import { useCallback } from 'react';
import {
  ArrowLeft,
  Download,
  ZoomIn,
  ZoomOut,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  MousePointer2,
  Video,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useVideoEditorStore, formatTimeSimple } from '../../stores/videoEditorStore';

interface PlaybackControlsProps {
  onBack: () => void;
  onExport: () => void;
}

/**
 * PlaybackControls - Bottom toolbar for video editor with playback and export controls.
 */
export function PlaybackControls({ onBack, onExport }: PlaybackControlsProps) {
  const {
    project,
    currentTimeMs,
    isPlaying,
    togglePlayback,
    setCurrentTime,
    timelineZoom,
    setTimelineZoom,
  } = useVideoEditorStore();

  const handleSkipBack = useCallback(() => {
    setCurrentTime(Math.max(0, currentTimeMs - 5000)); // Skip back 5 seconds
  }, [currentTimeMs, setCurrentTime]);

  const handleSkipForward = useCallback(() => {
    if (!project) return;
    setCurrentTime(Math.min(project.timeline.durationMs, currentTimeMs + 5000)); // Skip forward 5 seconds
  }, [currentTimeMs, project, setCurrentTime]);

  const handleGoToStart = useCallback(() => {
    setCurrentTime(0);
  }, [setCurrentTime]);

  const handleGoToEnd = useCallback(() => {
    if (!project) return;
    setCurrentTime(project.timeline.durationMs);
  }, [project, setCurrentTime]);

  const handleZoomIn = useCallback(() => {
    setTimelineZoom(timelineZoom * 1.5);
  }, [timelineZoom, setTimelineZoom]);

  const handleZoomOut = useCallback(() => {
    setTimelineZoom(timelineZoom / 1.5);
  }, [timelineZoom, setTimelineZoom]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="editor-toolbar-container">
        <div className="floating-toolbar animate-scale-in">
          {/* Back Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={onBack} className="glass-btn h-9 w-9">
                <ArrowLeft className="w-[18px] h-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Back to Library</p>
            </TooltipContent>
          </Tooltip>

          <div className="toolbar-divider" />

          {/* Timeline Zoom Controls */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={handleZoomOut} className="glass-btn h-9 w-9">
                <ZoomOut className="w-[18px] h-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Zoom Out Timeline</p>
            </TooltipContent>
          </Tooltip>

          <div className="text-[11px] text-zinc-400 font-mono px-2 min-w-[50px] text-center">
            {Math.round(timelineZoom * 1000)}px/s
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={handleZoomIn} className="glass-btn h-9 w-9">
                <ZoomIn className="w-[18px] h-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Zoom In Timeline</p>
            </TooltipContent>
          </Tooltip>

          <div className="toolbar-divider" />

          {/* Playback Controls */}
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={handleGoToStart} className="glass-btn h-9 w-9">
                  <SkipBack className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">Go to Start</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Home</kbd>
                </div>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={handleSkipBack} className="glass-btn h-9 w-9">
                  <SkipBack className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">Skip Back 5s</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">←</kbd>
                </div>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={togglePlayback}
                  className="tool-button h-10 w-10 active"
                >
                  {isPlaying ? (
                    <Pause className="w-5 h-5 relative z-10" />
                  ) : (
                    <Play className="w-5 h-5 ml-0.5 relative z-10" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{isPlaying ? 'Pause' : 'Play'}</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Space</kbd>
                </div>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={handleSkipForward} className="glass-btn h-9 w-9">
                  <SkipForward className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">Skip Forward 5s</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">→</kbd>
                </div>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={handleGoToEnd} className="glass-btn h-9 w-9">
                  <SkipForward className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">Go to End</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">End</kbd>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Current Time Display */}
          <div className="px-3 py-1 bg-zinc-800/60 rounded-md mx-2">
            <span className="text-sm font-mono text-zinc-300">
              {formatTimeSimple(currentTimeMs)}
            </span>
            <span className="text-zinc-500 mx-1">/</span>
            <span className="text-sm font-mono text-zinc-500">
              {project ? formatTimeSimple(project.timeline.durationMs) : '0:00'}
            </span>
          </div>

          <div className="toolbar-divider" />

          {/* Quick Access Buttons */}
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="glass-btn h-9 w-9">
                  <MousePointer2 className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Cursor Settings</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button className="glass-btn h-9 w-9">
                  <ZoomIn className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Auto-Zoom Settings</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button className="glass-btn h-9 w-9">
                  <Video className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Webcam Settings</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button className="glass-btn h-9 w-9">
                  <Sparkles className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Effects</p>
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="toolbar-divider" />

          {/* Export Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onExport}
                className="btn-coral h-9 px-4 rounded-lg flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span className="text-sm font-medium">Export</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="flex items-center gap-2">
                <span className="text-xs">Export Video</span>
                <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+E</kbd>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
