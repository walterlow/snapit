import { memo, useCallback, useMemo, useRef } from 'react';
import { Type, GripVertical, Plus } from 'lucide-react';
import type { TextSegment } from '../../../types';
import { useVideoEditorStore, formatTimeSimple } from '../../../stores/videoEditorStore';
import type { DragEdge } from './BaseTrack';

/**
 * TextTrack uses seconds for time values (matching Cap's model),
 * while other tracks use milliseconds. This component handles the
 * conversion internally rather than using BaseSegmentItem directly.
 */

// Drag state stored in ref to avoid re-renders during drag (in seconds)
interface DragState {
  start: number;
  end: number;
}

interface TextTrackProps {
  segments: TextSegment[];
  durationMs: number;
  timelineZoom: number;
  width: number;
}

// Default segment duration when adding new text (3 seconds)
const DEFAULT_TEXT_DURATION_SEC = 3;
// Minimum duration to allow adding a text segment (0.5 seconds)
const MIN_TEXT_DURATION_SEC = 0.5;

// CSS variable names for text track styling
const TEXT_COLORS = {
  bg: 'var(--track-text-bg)',
  bgSelected: 'var(--track-text-bg-selected)',
  border: 'var(--track-text-border)',
  borderSelected: 'var(--track-text-border-selected)',
  hover: 'var(--track-text-hover)',
  text: 'var(--track-text-text)',
};

// Selectors for atomic subscriptions
const selectSelectedTextSegmentId = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.selectedTextSegmentId;

/**
 * Preview segment shown when hovering over empty track space.
 */
const PreviewSegment = memo(function PreviewSegment({
  startSec,
  endSec,
  timelineZoom,
}: {
  startSec: number;
  endSec: number;
  timelineZoom: number;
}) {
  // Convert seconds to ms for timeline positioning
  const left = startSec * 1000 * timelineZoom;
  const width = (endSec - startSec) * 1000 * timelineZoom;

  return (
    <div
      className="absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none opacity-70"
      style={{
        left: `${left}px`,
        width: `${Math.max(width, 40)}px`,
        backgroundColor: TEXT_COLORS.bg,
        borderColor: TEXT_COLORS.borderSelected,
      }}
    >
      <div className="flex items-center justify-center h-full" style={{ color: TEXT_COLORS.text }}>
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
});

/**
 * TextSegmentItem - Handles seconds-based time values with conversion to pixels.
 * Uses the same drag pattern as BaseSegmentItem but adapted for seconds.
 */
const TextSegmentItem = memo(function TextSegmentItem({
  segment,
  segmentId,
  isSelected,
  timelineZoom,
  durationSec,
  onSelect,
  onUpdate,
  onDelete,
  onDragStart,
}: {
  segment: TextSegment;
  segmentId: string;
  isSelected: boolean;
  timelineZoom: number;
  durationSec: number;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, updates: Partial<TextSegment>) => void;
  onDelete: (id: string) => void;
  onDragStart: (dragging: boolean, edge?: DragEdge) => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);

  // Convert seconds to ms for timeline positioning
  const left = segment.start * 1000 * timelineZoom;
  const segmentWidth = (segment.end - segment.start) * 1000 * timelineZoom;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segmentId);
  }, [onSelect, segmentId]);

  const handlePointerDown = useCallback((
    e: React.PointerEvent,
    edge: DragEdge
  ) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer to prevent flickering when cursor leaves element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    onSelect(segmentId);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeSec = edge === 'end' ? segment.end : segment.start;
    const segmentDuration = segment.end - segment.start;

    // Initialize drag state
    dragStateRef.current = { start: segment.start, end: segment.end };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // Convert pixel delta to seconds (timeline zoom is px/ms, so divide by 1000 for px/sec)
      const deltaSec = deltaX / (timelineZoom * 1000);

      let newStart = dragStateRef.current!.start;
      let newEnd = dragStateRef.current!.end;

      if (edge === 'start') {
        newStart = Math.max(0, Math.min(segment.end - MIN_TEXT_DURATION_SEC, startTimeSec + deltaSec));
        newEnd = segment.end;
      } else if (edge === 'end') {
        newStart = segment.start;
        newEnd = Math.max(segment.start + MIN_TEXT_DURATION_SEC, Math.min(durationSec, startTimeSec + deltaSec));
      } else {
        newStart = startTimeSec + deltaSec;
        newEnd = newStart + segmentDuration;

        if (newStart < 0) {
          newStart = 0;
          newEnd = segmentDuration;
        }
        if (newEnd > durationSec) {
          newEnd = durationSec;
          newStart = durationSec - segmentDuration;
        }
      }

      // Update ref state
      dragStateRef.current = { start: newStart, end: newEnd };

      // Update DOM directly (no re-render)
      if (elementRef.current) {
        const newLeft = newStart * 1000 * timelineZoom;
        const newWidth = (newEnd - newStart) * 1000 * timelineZoom;
        elementRef.current.style.left = `${newLeft}px`;
        elementRef.current.style.width = `${Math.max(newWidth, 20)}px`;
      }

      // Update tooltip if visible (convert to ms for formatting)
      if (tooltipRef.current) {
        tooltipRef.current.textContent = `${formatTimeSimple(newStart * 1000)} - ${formatTimeSimple(newEnd * 1000)}`;
      }
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      // Release pointer capture
      (upEvent.target as HTMLElement).releasePointerCapture(upEvent.pointerId);

      // Commit final state to store
      if (dragStateRef.current) {
        const { start, end } = dragStateRef.current;
        if (start !== segment.start || end !== segment.end) {
          onUpdate(segmentId, { start, end });
        }
      }
      dragStateRef.current = null;
      onDragStart(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [segment, durationSec, timelineZoom, segmentId, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(segmentId);
  }, [onDelete, segmentId]);

  return (
    <div
      ref={elementRef}
      data-segment
      className={`
        absolute top-1 bottom-1 rounded-md cursor-pointer
        ${isSelected ? 'border-2 shadow-lg' : 'border'}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(segmentWidth, 20)}px`,
        backgroundColor: isSelected ? TEXT_COLORS.bgSelected : TEXT_COLORS.bg,
        borderColor: isSelected ? TEXT_COLORS.borderSelected : TEXT_COLORS.border,
      }}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'start')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = TEXT_COLORS.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'move')}
      >
        {segmentWidth > 60 && (
          <div className="flex items-center gap-1 overflow-hidden" style={{ color: TEXT_COLORS.text }}>
            <GripVertical className="w-3 h-3 flex-shrink-0" />
            <span className="text-[10px] font-medium truncate">
              {segment.content || 'Text'}
            </span>
          </div>
        )}
        {segmentWidth <= 60 && segmentWidth > 30 && (
          <Type className="w-3 h-3" style={{ color: TEXT_COLORS.text }} />
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'end')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = TEXT_COLORS.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Delete button (shown when selected) */}
      {isSelected && (
        <button
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-xs shadow-md"
          onClick={handleDelete}
        >
          x
        </button>
      )}

      {/* Tooltip showing time range */}
      {isSelected && (
        <div
          ref={tooltipRef}
          className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-[var(--glass-bg-solid)] border border-[var(--glass-border)] text-[var(--ink-dark)] text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-20 shadow-sm"
        >
          {formatTimeSimple(segment.start * 1000)} - {formatTimeSimple(segment.end * 1000)}
        </div>
      )}
    </div>
  );
});

/**
 * TextTrackContent - Track content without label for two-column layout.
 * Uses Cap's model: time in seconds, center-based positioning.
 * Memoized to prevent re-renders during playback.
 */
export const TextTrackContent = memo(function TextTrackContent({
  segments,
  durationMs,
  timelineZoom,
  width,
}: TextTrackProps) {
  const selectedTextSegmentId = useVideoEditorStore(selectSelectedTextSegmentId);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);
  const hoveredTrack = useVideoEditorStore((s) => s.hoveredTrack);
  const setHoveredTrack = useVideoEditorStore((s) => s.setHoveredTrack);
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);

  const {
    selectTextSegment,
    updateTextSegment,
    deleteTextSegment,
    addTextSegment,
    setDraggingTextSegment,
  } = useVideoEditorStore();

  // Duration in seconds
  const durationSec = durationMs / 1000;

  // Check if any segment is being dragged
  const isDraggingAny = useVideoEditorStore((s) =>
    s.isDraggingZoomRegion || s.isDraggingSceneSegment || s.isDraggingMaskSegment || s.isDraggingTextSegment
  );

  // Calculate preview segment details when hovering
  const previewSegmentDetails = useMemo(() => {
    // Only show preview when hovering over this track, not playing, and not dragging
    if (hoveredTrack !== 'text' || previewTimeMs === null || isPlaying || isDraggingAny) {
      return null;
    }

    const previewTimeSec = previewTimeMs / 1000;

    // Check if hovering over an existing segment
    const isOnSegment = segments.some(
      (seg) => previewTimeSec >= seg.start && previewTimeSec <= seg.end
    );

    if (isOnSegment) {
      return null;
    }

    // Calculate preview segment bounds - left edge at playhead
    const startSec = previewTimeSec;
    const endSec = Math.min(durationSec, startSec + DEFAULT_TEXT_DURATION_SEC);

    // Don't allow if there's not enough space for minimum duration
    if (endSec - startSec < MIN_TEXT_DURATION_SEC) {
      return null;
    }

    // Check for collisions with existing segments
    for (const seg of segments) {
      if (startSec < seg.end && endSec > seg.start) {
        return null;
      }
    }

    return { startSec, endSec };
  }, [hoveredTrack, previewTimeMs, isPlaying, isDraggingAny, segments, durationSec]);

  // Handle track hover
  const handleMouseEnter = useCallback(() => {
    setHoveredTrack('text');
  }, [setHoveredTrack]);

  const handleMouseLeave = useCallback(() => {
    setHoveredTrack(null);
  }, [setHoveredTrack]);

  // Handle click to add segment
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    // Only add if we have a valid preview segment
    if (!previewSegmentDetails) return;

    // Don't add if clicking on a segment
    if ((e.target as HTMLElement).closest('[data-segment]')) return;

    // Create new segment with Cap's model
    const newSegment: TextSegment = {
      start: previewSegmentDetails.startSec,
      end: previewSegmentDetails.endSec,
      enabled: true,
      content: 'Text',
      center: { x: 0.5, y: 0.5 },
      size: { x: 0.35, y: 0.2 },
      fontFamily: 'sans-serif',
      fontSize: 48,
      fontWeight: 700,
      italic: false,
      color: '#ffffff',
      fadeDuration: 0.15,
    };

    // addTextSegment handles selection internally after sorting
    addTextSegment(newSegment);
  }, [previewSegmentDetails, addTextSegment]);

  // Generate IDs for segments - must match TextOverlay's ID generation
  // Uses start time + index for selection matching, but key uses just index for stability during drag
  const getSegmentId = useCallback((segment: TextSegment, index: number) => {
    return `text_${segment.start.toFixed(3)}_${index}`;
  }, []);

  return (
    <div
      className={`relative h-12 bg-[var(--polar-mist)]/60 border-b border-[var(--glass-border)] ${
        hoveredTrack === 'text' && previewSegmentDetails ? 'cursor-pointer' : ''
      }`}
      style={{ width: `${width}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTrackClick}
    >
      {segments.map((segment, index) => {
        const segmentId = getSegmentId(segment, index);
        return (
          <TextSegmentItem
            key={`text_segment_${index}`}
            segment={segment}
            segmentId={segmentId}
            isSelected={segmentId === selectedTextSegmentId}
            timelineZoom={timelineZoom}
            durationSec={durationSec}
            onSelect={selectTextSegment}
            onUpdate={updateTextSegment}
            onDelete={deleteTextSegment}
            onDragStart={setDraggingTextSegment}
          />
        );
      })}

      {/* Preview segment (ghost) when hovering over empty space */}
      {previewSegmentDetails && (
        <PreviewSegment
          startSec={previewSegmentDetails.startSec}
          endSec={previewSegmentDetails.endSec}
          timelineZoom={timelineZoom}
        />
      )}

      {/* Empty state hint */}
      {segments.length === 0 && !previewSegmentDetails && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-[var(--ink-subtle)]">
            Hover to add text overlays
          </span>
        </div>
      )}
    </div>
  );
});
