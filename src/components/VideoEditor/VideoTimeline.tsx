import { memo, useCallback, useRef, useState, useEffect } from 'react';
import {
  Film,
  Plus,
  ArrowLeft,
  Download,
  ZoomIn,
  ZoomOut,
  SkipBack,
  SkipForward,
  Play,
  Pause,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useVideoEditorStore, generateZoomRegionId, formatTimeSimple } from '../../stores/videoEditorStore';
import { usePlaybackTime, usePlaybackControls, getPlaybackState } from '../../hooks/usePlaybackEngine';
import { TimelineRuler } from './TimelineRuler';
import { ZoomTrack } from './ZoomTrack';
import { WebcamTrack } from './WebcamTrack';
import type { ZoomRegion, ZoomTransition } from '../../types';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectTimelineZoom = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.timelineZoom;
const selectIsDraggingPlayhead = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isDraggingPlayhead;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;

/**
 * Preview scrubber - ghost playhead that follows mouse when not playing.
 */
const PreviewScrubber = memo(function PreviewScrubber({
  previewTimeMs,
  timelineZoom,
  trackLabelWidth,
}: {
  previewTimeMs: number;
  timelineZoom: number;
  trackLabelWidth: number;
}) {
  const position = previewTimeMs * timelineZoom + trackLabelWidth;

  return (
    <div
      className="absolute top-0 bottom-0 w-0.5 z-20 pointer-events-none bg-gradient-to-b from-zinc-400 to-transparent"
      style={{ left: `${position}px` }}
    >
      {/* Scrubber handle */}
      <div
        className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-4 rounded-b-sm bg-zinc-400"
        style={{
          clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
        }}
      />
      {/* Time tooltip */}
      <div
        className="absolute top-5 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-zinc-800 border border-zinc-600 rounded text-[10px] font-mono text-zinc-300 whitespace-nowrap shadow-lg"
      >
        {formatTimeSimple(previewTimeMs)}
      </div>
    </div>
  );
});

interface VideoTimelineProps {
  onBack: () => void;
  onExport: () => void;
}

/**
 * Time display component - uses usePlaybackTime for smooth updates.
 */
const TimeDisplay = memo(function TimeDisplay({ durationMs }: { durationMs: number }) {
  const currentTimeMs = usePlaybackTime();

  return (
    <div className="px-2 py-0.5 bg-zinc-800/60 rounded text-xs font-mono text-zinc-300 tabular-nums">
      {formatTimeSimple(currentTimeMs)}
      <span className="text-zinc-500 mx-1">/</span>
      <span className="text-zinc-500">{formatTimeSimple(durationMs)}</span>
    </div>
  );
});

/**
 * Memoized playhead component - only re-renders when position changes.
 * Uses usePlaybackTime for 60fps updates without triggering parent re-renders.
 */
const Playhead = memo(function Playhead({
  timelineZoom,
  trackLabelWidth,
  isDragging,
  onMouseDown,
}: {
  timelineZoom: number;
  trackLabelWidth: number;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const currentTimeMs = usePlaybackTime();
  const playheadPosition = currentTimeMs * timelineZoom + trackLabelWidth;

  return (
    <div
      className={`
        absolute top-0 bottom-0 w-0.5 z-30 pointer-events-auto
        ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}
      `}
      style={{ 
        left: `${playheadPosition}px`,
        backgroundColor: 'var(--coral-400)',
      }}
      onMouseDown={onMouseDown}
    >
      {/* Playhead handle */}
      <div 
        className={`
          absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-4 rounded-b-sm
          shadow-lg
          ${isDragging ? 'scale-110' : 'hover:scale-105'}
          transition-transform
        `}
        style={{
          clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
          backgroundColor: 'var(--coral-400)',
          boxShadow: '0 10px 15px -3px rgba(249, 112, 102, 0.3)',
        }}
      />
      
      {/* Time indicator (shown when dragging) */}
      {isDragging && (
        <PlayheadTimeIndicator />
      )}
    </div>
  );
});

/**
 * Separate component for the time indicator to minimize re-renders.
 */
const PlayheadTimeIndicator = memo(function PlayheadTimeIndicator() {
  const currentTimeMs = usePlaybackTime();
  
  return (
    <div 
      className="absolute top-5 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-zinc-900 rounded text-[10px] font-mono whitespace-nowrap shadow-lg"
      style={{ 
        borderColor: 'rgba(249, 112, 102, 0.5)',
        borderWidth: '1px',
        color: 'var(--coral-300)',
      }}
    >
      {Math.floor(currentTimeMs / 60000)}:{String(Math.floor((currentTimeMs % 60000) / 1000)).padStart(2, '0')}
    </div>
  );
});

/**
 * Memoized video track with thumbnails.
 */
const VideoTrack = memo(function VideoTrack({
  durationMs,
  timelineZoom,
  width,
}: {
  durationMs: number;
  timelineZoom: number;
  width: number;
}) {
  const clipWidth = durationMs * timelineZoom;

  return (
    <div
      className="relative h-12 bg-zinc-800/30"
      style={{ width: `${width}px` }}
    >
      {/* Track label */}
      <div className="absolute left-0 top-0 bottom-0 w-20 bg-zinc-900/80 border-r border-zinc-700/50 flex items-center justify-center z-10">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <Film className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Video</span>
        </div>
      </div>

      {/* Video clip item */}
      <div className="absolute left-20 top-0 bottom-0 right-0">
        <div
          className="absolute top-1 bottom-1 rounded-md bg-indigo-500/30 border border-indigo-500/50"
          style={{ left: 0, width: `${clipWidth}px` }}
        >
          {/* Clip content - thumbnail placeholders */}
          <div className="absolute inset-0 flex items-center overflow-hidden rounded-md">
            <div
              className="h-full flex"
              style={{
                background: `repeating-linear-gradient(
                  90deg,
                  rgba(99, 102, 241, 0.15) 0px,
                  rgba(99, 102, 241, 0.15) 59px,
                  rgba(99, 102, 241, 0.25) 59px,
                  rgba(99, 102, 241, 0.25) 60px
                )`,
                width: `${clipWidth}px`,
              }}
            />
          </div>
          {/* Clip label */}
          <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
            <span className="text-[10px] text-indigo-300/80 font-medium truncate">
              Recording
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * VideoTimeline - Main timeline component with ruler, tracks, and playhead.
 * Optimized to prevent re-renders during playback.
 */
export function VideoTimeline({ onBack, onExport }: VideoTimelineProps) {
  const project = useVideoEditorStore(selectProject);
  const timelineZoom = useVideoEditorStore(selectTimelineZoom);
  const isDraggingPlayhead = useVideoEditorStore(selectIsDraggingPlayhead);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);

  const {
    setTimelineScrollLeft,
    setDraggingPlayhead,
    setTimelineZoom,
    setPreviewTime,
    togglePlayback,
    addZoomRegion,
    selectZoomRegion,
    selectWebcamSegment,
  } = useVideoEditorStore();

  const controls = usePlaybackControls();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Measure container width
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  // Clear preview time when playback starts
  useEffect(() => {
    if (isPlaying) {
      setPreviewTime(null);
    }
  }, [isPlaying, setPreviewTime]);

  // Calculate timeline dimensions - extend to fill container width at minimum
  const durationMs = project?.timeline.durationMs ?? 60000;
  const trackLabelWidth = 80;
  const durationWidth = durationMs * timelineZoom;
  const timelineWidth = Math.max(durationWidth, containerWidth - trackLabelWidth);

  // Handle clicking on timeline to seek
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const x = e.clientX - rect.left + scrollLeft - trackLabelWidth;
    const newTimeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
    controls.seek(newTimeMs);

    // Deselect any selected regions
    selectZoomRegion(null);
    selectWebcamSegment(null);
  }, [durationMs, timelineZoom, controls, selectZoomRegion, selectWebcamSegment]);

  // Handle mouse move for preview scrubber
  const handleTimelineMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isPlaying) {
      setPreviewTime(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const x = e.clientX - rect.left + scrollLeft - trackLabelWidth;
    if (x < 0) {
      setPreviewTime(null);
      return;
    }
    const timeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
    setPreviewTime(timeMs);
  }, [isPlaying, durationMs, timelineZoom, setPreviewTime]);

  // Clear preview on mouse leave
  const handleTimelineMouseLeave = useCallback(() => {
    setPreviewTime(null);
  }, [setPreviewTime]);

  // Handle playhead dragging
  const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingPlayhead(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      
      const rect = container.getBoundingClientRect();
      const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
      const x = moveEvent.clientX - rect.left + scrollLeft - trackLabelWidth;
      const newTimeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
      controls.seek(newTimeMs);
    };

    const handleMouseUp = () => {
      setDraggingPlayhead(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [durationMs, timelineZoom, controls, setDraggingPlayhead]);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setTimelineScrollLeft(e.currentTarget.scrollLeft);
  }, [setTimelineScrollLeft]);

  // Add zoom region at current time
  const handleAddZoomRegion = useCallback(() => {
    const { currentTimeMs } = getPlaybackState();
    const defaultDuration = 3000;
    const endMs = Math.min(currentTimeMs + defaultDuration, durationMs);

    const defaultTransition: ZoomTransition = {
      durationInMs: 300,
      durationOutMs: 300,
      easing: 'easeInOut',
    };

    const newRegion: ZoomRegion = {
      id: generateZoomRegionId(),
      startMs: currentTimeMs,
      endMs,
      scale: 2.0,
      targetX: 0.5,
      targetY: 0.5,
      isAuto: false,
      transition: defaultTransition,
    };

    addZoomRegion(newRegion);
  }, [durationMs, addZoomRegion]);

  // Playback controls
  const handleGoToStart = useCallback(() => {
    controls.seek(0);
  }, [controls]);

  const handleGoToEnd = useCallback(() => {
    controls.seek(durationMs);
  }, [controls, durationMs]);

  const handleSkipBack = useCallback(() => {
    const { currentTimeMs } = getPlaybackState();
    controls.seek(Math.max(0, currentTimeMs - 5000));
  }, [controls]);

  const handleSkipForward = useCallback(() => {
    const { currentTimeMs } = getPlaybackState();
    controls.seek(Math.min(durationMs, currentTimeMs + 5000));
  }, [controls, durationMs]);

  // Timeline zoom controls
  const handleZoomIn = useCallback(() => {
    setTimelineZoom(timelineZoom * 1.5);
  }, [timelineZoom, setTimelineZoom]);

  const handleZoomOut = useCallback(() => {
    setTimelineZoom(timelineZoom / 1.5);
  }, [timelineZoom, setTimelineZoom]);

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col bg-zinc-900 border-t border-zinc-700/50 select-none"
    >
      {/* Timeline Header with Controls */}
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center h-11 px-3 bg-zinc-900/80 border-b border-zinc-700/30">
          {/* Left Section */}
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onBack} className="glass-btn h-8 w-8">
                  <ArrowLeft className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">Back to Library</p>
              </TooltipContent>
            </Tooltip>

            <div className="w-px h-5 bg-zinc-700/50" />

            {/* Timeline Zoom Controls */}
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleZoomOut} className="glass-btn h-7 w-7">
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Zoom Out Timeline</p>
                </TooltipContent>
              </Tooltip>

              <span className="text-[10px] text-zinc-500 font-mono w-12 text-center">
                {Math.round(timelineZoom * 1000)}px/s
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleZoomIn} className="glass-btn h-7 w-7">
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Zoom In Timeline</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Center Section - Playback Controls */}
          <div className="flex-1 flex items-center justify-center gap-1">
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleGoToStart} className="glass-btn h-8 w-8">
                    <SkipBack className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Go to Start</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">Home</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleSkipBack} className="glass-btn h-8 w-8">
                    <SkipBack className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
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
                    className="tool-button h-9 w-9 active"
                  >
                    {isPlaying ? (
                      <Pause className="w-4 h-4 relative z-10" />
                    ) : (
                      <Play className="w-4 h-4 ml-0.5 relative z-10" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{isPlaying ? 'Pause' : 'Play'}</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">Space</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleSkipForward} className="glass-btn h-8 w-8">
                    <SkipForward className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Skip Forward 5s</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">→</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleGoToEnd} className="glass-btn h-8 w-8">
                    <SkipForward className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Go to End</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">End</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>

            <TimeDisplay durationMs={durationMs} />
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleAddZoomRegion}
              className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Zoom
            </button>

            <div className="w-px h-5 bg-zinc-700/50" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onExport}
                  className="btn-coral h-8 px-3 rounded-md flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">Export</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="flex items-center gap-2">
                  <span className="text-xs">Export Video</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+E</kbd>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* Scrollable Timeline Content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-auto"
        onScroll={handleScroll}
      >
        <div
          className="relative"
          style={{ width: `${timelineWidth + trackLabelWidth}px` }}
          onClick={handleTimelineClick}
          onMouseMove={handleTimelineMouseMove}
          onMouseLeave={handleTimelineMouseLeave}
        >
          {/* Time Ruler */}
          <div className="sticky left-0" style={{ marginLeft: `${trackLabelWidth}px` }}>
            <TimelineRuler
              durationMs={durationMs}
              timelineZoom={timelineZoom}
              width={timelineWidth}
            />
          </div>

          {/* Video Track */}
          <VideoTrack
            durationMs={durationMs}
            timelineZoom={timelineZoom}
            width={timelineWidth + trackLabelWidth}
          />

          {/* Zoom Track */}
          {project && (
            <ZoomTrack
              regions={project.zoom.regions}
              durationMs={durationMs}
              timelineZoom={timelineZoom}
              width={timelineWidth + trackLabelWidth}
            />
          )}

          {/* Webcam Track */}
          {project && (
            <WebcamTrack
              segments={project.webcam.visibilitySegments}
              durationMs={durationMs}
              timelineZoom={timelineZoom}
              width={timelineWidth + trackLabelWidth}
              enabled={project.webcam.enabled}
            />
          )}

          {/* Preview Scrubber - only when not playing */}
          {!isPlaying && previewTimeMs !== null && (
            <PreviewScrubber
              previewTimeMs={previewTimeMs}
              timelineZoom={timelineZoom}
              trackLabelWidth={trackLabelWidth}
            />
          )}

          {/* Playhead */}
          <Playhead
            timelineZoom={timelineZoom}
            trackLabelWidth={trackLabelWidth}
            isDragging={isDraggingPlayhead}
            onMouseDown={handlePlayheadMouseDown}
          />
        </div>
      </div>
    </div>
  );
}
