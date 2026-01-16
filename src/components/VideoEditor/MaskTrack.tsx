import { memo, useCallback, useMemo, useRef } from 'react';
import { GripVertical, Plus } from 'lucide-react';
import type { MaskSegment, MaskType } from '../../types';
import { useVideoEditorStore, formatTimeSimple } from '../../stores/videoEditorStore';

// Drag state stored in ref to avoid re-renders during drag
interface DragState {
  startMs: number;
  endMs: number;
}

interface MaskTrackProps {
  segments: MaskSegment[];
  durationMs: number;
  timelineZoom: number;
  width: number;
}

// Default segment duration when adding new masks (3 seconds)
const DEFAULT_MASK_DURATION_MS = 3000;
// Minimum duration to allow adding a mask segment (500ms)
const MIN_MASK_DURATION_MS = 500;

// Generate unique mask ID
const generateMaskId = () => `mask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Selectors for atomic subscriptions
const selectSelectedMaskSegmentId = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.selectedMaskSegmentId;

/**
 * Get label for mask type
 */
const getMaskTypeLabel = (maskType: MaskType): string => {
  switch (maskType) {
    case 'blur':
      return 'Blur';
    case 'pixelate':
      return 'Pixel';
    case 'solid':
      return 'Solid';
    default:
      return 'Mask';
  }
};

/**
 * Preview segment shown when hovering over empty track space.
 */
const PreviewSegment = memo(function PreviewSegment({
  startMs,
  endMs,
  timelineZoom,
}: {
  startMs: number;
  endMs: number;
  timelineZoom: number;
}) {
  const left = startMs * timelineZoom;
  const width = (endMs - startMs) * timelineZoom;

  return (
    <div
      className="absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none opacity-70"
      style={{
        left: `${left}px`,
        width: `${Math.max(width, 40)}px`,
        backgroundColor: 'var(--track-mask-bg)',
        borderColor: 'var(--track-mask-border-selected)',
      }}
    >
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--track-mask-text)' }}>
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
});

/**
 * Memoized mask segment component.
 * Uses refs for intermediate drag state to avoid re-renders during drag.
 */
const MaskSegmentItem = memo(function MaskSegmentItem({
  segment,
  isSelected,
  timelineZoom,
  durationMs,
  onSelect,
  onUpdate,
  onDelete,
  onDragStart,
}: {
  segment: MaskSegment;
  isSelected: boolean;
  timelineZoom: number;
  durationMs: number;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<MaskSegment>) => void;
  onDelete: (id: string) => void;
  onDragStart: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const left = segment.startMs * timelineZoom;
  const segmentWidth = (segment.endMs - segment.startMs) * timelineZoom;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [onSelect, segment.id]);

  const handlePointerDown = useCallback((
    e: React.PointerEvent,
    edge: 'start' | 'end' | 'move'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer to prevent flickering when cursor leaves element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    onSelect(segment.id);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? segment.endMs : segment.startMs;
    const segmentDuration = segment.endMs - segment.startMs;

    // Initialize drag state
    dragStateRef.current = { startMs: segment.startMs, endMs: segment.endMs };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;

      let newStartMs = dragStateRef.current!.startMs;
      let newEndMs = dragStateRef.current!.endMs;

      if (edge === 'start') {
        newStartMs = Math.max(0, Math.min(segment.endMs - 500, startTimeMs + deltaMs));
        newEndMs = segment.endMs;
      } else if (edge === 'end') {
        newStartMs = segment.startMs;
        newEndMs = Math.max(segment.startMs + 500, Math.min(durationMs, startTimeMs + deltaMs));
      } else {
        newStartMs = startTimeMs + deltaMs;
        newEndMs = newStartMs + segmentDuration;

        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = segmentDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - segmentDuration;
        }
      }

      // Update ref state
      dragStateRef.current = { startMs: newStartMs, endMs: newEndMs };

      // Update DOM directly (no re-render)
      if (elementRef.current) {
        const newLeft = newStartMs * timelineZoom;
        const newWidth = (newEndMs - newStartMs) * timelineZoom;
        elementRef.current.style.left = `${newLeft}px`;
        elementRef.current.style.width = `${Math.max(newWidth, 20)}px`;
      }

      // Update tooltip if visible
      if (tooltipRef.current) {
        tooltipRef.current.textContent = `${formatTimeSimple(newStartMs)} - ${formatTimeSimple(newEndMs)}`;
      }
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      // Release pointer capture
      (upEvent.target as HTMLElement).releasePointerCapture(upEvent.pointerId);

      // Commit final state to store
      if (dragStateRef.current) {
        const { startMs, endMs } = dragStateRef.current;
        if (startMs !== segment.startMs || endMs !== segment.endMs) {
          onUpdate(segment.id, { startMs, endMs });
        }
      }
      dragStateRef.current = null;
      onDragStart(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [segment, durationMs, timelineZoom, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(segment.id);
  }, [onDelete, segment.id]);

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
        backgroundColor: isSelected ? 'var(--track-mask-bg-selected)' : 'var(--track-mask-bg)',
        borderColor: isSelected ? 'var(--track-mask-border-selected)' : 'var(--track-mask-border)',
      }}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md touch-none"
        style={{ '--tw-bg-opacity': 1 } as React.CSSProperties}
        onPointerDown={(e) => handlePointerDown(e, 'start')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--track-mask-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'move')}
      >
        {segmentWidth > 60 && (
          <div className="flex items-center gap-1" style={{ color: 'var(--track-mask-text)' }}>
            <GripVertical className="w-3 h-3" />
            <span className="text-[10px] font-mono">
              {getMaskTypeLabel(segment.maskType)}
            </span>
          </div>
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'end')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--track-mask-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Delete button (shown when selected) */}
      {isSelected && (
        <button
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-xs shadow-md"
          onClick={handleDelete}
        >
          ×
        </button>
      )}

      {/* Tooltip showing time range */}
      {isSelected && (
        <div
          ref={tooltipRef}
          className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-[var(--glass-bg-solid)] border border-[var(--glass-border)] text-[var(--ink-dark)] text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-20 shadow-sm"
        >
          {formatTimeSimple(segment.startMs)} - {formatTimeSimple(segment.endMs)}
        </div>
      )}
    </div>
  );
});

/**
 * MaskTrackContent - Track content without label for two-column layout.
 * Memoized to prevent re-renders during playback.
 */
export const MaskTrackContent = memo(function MaskTrackContent({
  segments,
  durationMs,
  timelineZoom,
  width
}: MaskTrackProps) {
  const selectedMaskSegmentId = useVideoEditorStore(selectSelectedMaskSegmentId);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);
  const hoveredTrack = useVideoEditorStore((s) => s.hoveredTrack);
  const setHoveredTrack = useVideoEditorStore((s) => s.setHoveredTrack);
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);

  const {
    selectMaskSegment,
    updateMaskSegment,
    deleteMaskSegment,
    addMaskSegment,
    setDraggingMaskSegment,
  } = useVideoEditorStore();

  // Check if any segment is being dragged
  const isDraggingAny = useVideoEditorStore((s) =>
    s.isDraggingZoomRegion || s.isDraggingSceneSegment || s.isDraggingMaskSegment || s.isDraggingTextSegment
  );

  // Calculate preview segment details when hovering
  const previewSegmentDetails = useMemo(() => {
    // Only show preview when hovering over this track, not playing, and not dragging
    if (hoveredTrack !== 'mask' || previewTimeMs === null || isPlaying || isDraggingAny) {
      return null;
    }

    // Check if hovering over an existing segment
    const isOnSegment = segments.some(
      (seg) => previewTimeMs >= seg.startMs && previewTimeMs <= seg.endMs
    );

    if (isOnSegment) {
      return null;
    }

    // Calculate preview segment bounds - left edge at playhead
    const startMs = previewTimeMs;
    const endMs = Math.min(durationMs, startMs + DEFAULT_MASK_DURATION_MS);

    // Don't allow if there's not enough space for minimum duration
    if (endMs - startMs < MIN_MASK_DURATION_MS) {
      return null;
    }

    // Check for collisions with existing segments
    for (const seg of segments) {
      if (startMs < seg.endMs && endMs > seg.startMs) {
        return null;
      }
    }

    return { startMs, endMs };
  }, [hoveredTrack, previewTimeMs, isPlaying, isDraggingAny, segments, durationMs]);

  // Handle track hover
  const handleMouseEnter = useCallback(() => {
    setHoveredTrack('mask');
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

    const newSegment: MaskSegment = {
      id: generateMaskId(),
      startMs: previewSegmentDetails.startMs,
      endMs: previewSegmentDetails.endMs,
      x: 0.3,
      y: 0.3,
      width: 0.2,
      height: 0.15,
      maskType: 'blur',
      intensity: 50,
      feather: 10,
      color: '#000000',
    };

    addMaskSegment(newSegment);
  }, [previewSegmentDetails, addMaskSegment]);

  return (
    <div
      className={`relative h-12 bg-[var(--polar-mist)]/60 border-b border-[var(--glass-border)] ${
        hoveredTrack === 'mask' && previewSegmentDetails ? 'cursor-pointer' : ''
      }`}
      style={{ width: `${width}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTrackClick}
    >
      {segments.map((segment) => (
        <MaskSegmentItem
          key={segment.id}
          segment={segment}
          isSelected={segment.id === selectedMaskSegmentId}
          timelineZoom={timelineZoom}
          durationMs={durationMs}
          onSelect={selectMaskSegment}
          onUpdate={updateMaskSegment}
          onDelete={deleteMaskSegment}
          onDragStart={setDraggingMaskSegment}
        />
      ))}

      {/* Preview segment (ghost) when hovering over empty space */}
      {previewSegmentDetails && (
        <PreviewSegment
          startMs={previewSegmentDetails.startMs}
          endMs={previewSegmentDetails.endMs}
          timelineZoom={timelineZoom}
        />
      )}

      {/* Empty state hint */}
      {segments.length === 0 && !previewSegmentDetails && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-[var(--ink-subtle)]">
            Hover to add blur/mask regions
          </span>
        </div>
      )}
    </div>
  );
});
