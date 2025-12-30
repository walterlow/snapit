import { useCallback, useRef, useMemo } from 'react';
import { Film, Plus } from 'lucide-react';
import { useVideoEditorStore, generateZoomRegionId } from '../../stores/videoEditorStore';
import { TimelineRuler } from './TimelineRuler';
import { ZoomTrack } from './ZoomTrack';
import { WebcamTrack } from './WebcamTrack';
import type { ZoomRegion, ZoomTransition } from '../../types';

/**
 * VideoTimeline - Main timeline component with ruler, tracks, and playhead.
 * Displays video preview strip, zoom regions, and webcam visibility segments.
 */
export function VideoTimeline() {
  const {
    project,
    currentTimeMs,
    setCurrentTime,
    timelineZoom,
    setTimelineScrollLeft,
    isDraggingPlayhead,
    setDraggingPlayhead,
    addZoomRegion,
    selectZoomRegion,
    selectWebcamSegment,
  } = useVideoEditorStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Calculate timeline dimensions
  const durationMs = project?.timeline.durationMs ?? 60000; // Default 1 minute
  const timelineWidth = durationMs * timelineZoom;
  const trackLabelWidth = 80; // Fixed width for track labels

  // Playhead position in pixels
  const playheadPosition = currentTimeMs * timelineZoom + trackLabelWidth;

  // Handle clicking on timeline to seek
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const x = e.clientX - rect.left + scrollLeft - trackLabelWidth;
    const newTimeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
    setCurrentTime(newTimeMs);
    
    // Deselect any selected regions
    selectZoomRegion(null);
    selectWebcamSegment(null);
  }, [durationMs, timelineZoom, setCurrentTime, selectZoomRegion, selectWebcamSegment]);

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
      setCurrentTime(newTimeMs);
    };

    const handleMouseUp = () => {
      setDraggingPlayhead(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [durationMs, timelineZoom, setCurrentTime, setDraggingPlayhead]);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setTimelineScrollLeft(e.currentTarget.scrollLeft);
  }, [setTimelineScrollLeft]);

  // Add zoom region at current time
  const handleAddZoomRegion = useCallback(() => {
    const defaultDuration = 3000; // 3 seconds
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
  }, [currentTimeMs, durationMs, addZoomRegion]);

  // Video preview thumbnails (placeholder - would be generated from video frames)
  const thumbnails = useMemo(() => {
    const count = Math.ceil(timelineWidth / 100); // One thumbnail per 100px
    return Array.from({ length: count }, (_, i) => ({
      x: i * 100,
      timeMs: (i * 100) / timelineZoom,
    }));
  }, [timelineWidth, timelineZoom]);

  return (
    <div 
      ref={containerRef}
      className="flex flex-col bg-zinc-900 border-t border-zinc-700/50 select-none"
    >
      {/* Timeline Header with Add Buttons */}
      <div className="flex items-center justify-between h-10 px-4 bg-zinc-900/80 border-b border-zinc-700/30">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Timeline</span>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleAddZoomRegion}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Zoom
          </button>
        </div>
      </div>

      {/* Scrollable Timeline Content */}
      <div 
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden"
        onScroll={handleScroll}
      >
        <div 
          className="relative"
          style={{ width: `${timelineWidth + trackLabelWidth}px` }}
          onClick={handleTimelineClick}
        >
          {/* Time Ruler */}
          <div className="sticky left-0" style={{ marginLeft: `${trackLabelWidth}px` }}>
            <TimelineRuler
              durationMs={durationMs}
              timelineZoom={timelineZoom}
              width={timelineWidth}
            />
          </div>

          {/* Video Preview Track */}
          <div 
            className="relative h-16 bg-zinc-800/40 border-b border-zinc-700/30"
            style={{ width: `${timelineWidth + trackLabelWidth}px` }}
          >
            {/* Track label */}
            <div className="absolute left-0 top-0 bottom-0 w-20 bg-zinc-900/80 border-r border-zinc-700/50 flex items-center justify-center z-10">
              <div className="flex items-center gap-1.5 text-zinc-400">
                <Film className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">Video</span>
              </div>
            </div>

            {/* Thumbnail strip placeholder */}
            <div 
              className="absolute left-20 top-1 bottom-1 right-0 flex"
              style={{
                background: `
                  repeating-linear-gradient(
                    90deg,
                    rgba(39, 39, 42, 0.5) 0px,
                    rgba(39, 39, 42, 0.5) 99px,
                    rgba(63, 63, 70, 0.3) 99px,
                    rgba(63, 63, 70, 0.3) 100px
                  )
                `,
              }}
            >
              {/* Frame placeholders */}
              {thumbnails.map((thumb, i) => (
                <div
                  key={i}
                  className="flex-shrink-0 w-[100px] h-full border-r border-zinc-700/20 flex items-center justify-center text-[10px] text-zinc-600"
                >
                  {Math.floor(thumb.timeMs / 1000)}s
                </div>
              ))}
            </div>
          </div>

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

          {/* Playhead */}
          <div
            className={`
              absolute top-0 bottom-0 w-0.5 z-30 pointer-events-auto
              ${isDraggingPlayhead ? 'cursor-grabbing' : 'cursor-grab'}
            `}
            style={{ 
              left: `${playheadPosition}px`,
              backgroundColor: 'var(--coral-400)',
            }}
            onMouseDown={handlePlayheadMouseDown}
          >
            {/* Playhead handle */}
            <div 
              className={`
                absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-4 rounded-b-sm
                shadow-lg
                ${isDraggingPlayhead ? 'scale-110' : 'hover:scale-105'}
                transition-transform
              `}
              style={{
                clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
                backgroundColor: 'var(--coral-400)',
                boxShadow: '0 10px 15px -3px rgba(249, 112, 102, 0.3)',
              }}
            />
            
            {/* Time indicator (shown when dragging) */}
            {isDraggingPlayhead && (
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
