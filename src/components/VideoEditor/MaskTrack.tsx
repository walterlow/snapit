import { memo, useCallback, useMemo } from 'react';
import { EyeOff, GripVertical, Plus } from 'lucide-react';
import type { MaskSegment, MaskType } from '../../types';
import { useVideoEditorStore, formatTimeSimple } from '../../stores/videoEditorStore';

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
  const left = segment.startMs * timelineZoom;
  const segmentWidth = (segment.endMs - segment.startMs) * timelineZoom;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [onSelect, segment.id]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    edge: 'start' | 'end' | 'move'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    onSelect(segment.id);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? segment.endMs : segment.startMs;
    const segmentDuration = segment.endMs - segment.startMs;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;

      if (edge === 'start') {
        const newStartMs = Math.max(0, Math.min(segment.endMs - 500, startTimeMs + deltaMs));
        onUpdate(segment.id, { startMs: newStartMs });
      } else if (edge === 'end') {
        const newEndMs = Math.max(segment.startMs + 500, Math.min(durationMs, startTimeMs + deltaMs));
        onUpdate(segment.id, { endMs: newEndMs });
      } else {
        let newStartMs = startTimeMs + deltaMs;
        let newEndMs = newStartMs + segmentDuration;

        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = segmentDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - segmentDuration;
        }

        onUpdate(segment.id, { startMs: newStartMs, endMs: newEndMs });
      }
    };

    const handleMouseUp = () => {
      onDragStart(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [segment, durationMs, timelineZoom, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(segment.id);
  }, [onDelete, segment.id]);

  return (
    <div
      data-segment
      className={`
        absolute top-1 bottom-1 rounded-md cursor-pointer
        transition-all duration-100
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
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md"
        style={{ '--tw-bg-opacity': 1 } as React.CSSProperties}
        onMouseDown={(e) => handleMouseDown(e, 'start')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--track-mask-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
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
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md"
        onMouseDown={(e) => handleMouseDown(e, 'end')}
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
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-[var(--glass-bg-solid)] border border-[var(--glass-border)] text-[var(--ink-dark)] text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-20 shadow-sm">
          {formatTimeSimple(segment.startMs)} - {formatTimeSimple(segment.endMs)}
        </div>
      )}
    </div>
  );
});

/**
 * MaskTrack - Displays and allows editing of mask/blur segments.
 * Memoized to prevent re-renders during playback.
 */
export const MaskTrack = memo(function MaskTrack({
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

  // Calculate preview segment details when hovering
  const previewSegmentDetails = useMemo(() => {
    // Only show preview when hovering over this track and not playing
    if (hoveredTrack !== 'mask' || previewTimeMs === null || isPlaying) {
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
  }, [hoveredTrack, previewTimeMs, isPlaying, segments, durationMs]);

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
      className="relative h-12 bg-[var(--polar-mist)]/60 border-b border-[var(--glass-border)]"
      style={{ width: `${width}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTrackClick}
    >
      {/* Track label */}
      <div className="absolute left-0 top-0 bottom-0 w-20 bg-[var(--polar-mist)] border-r border-[var(--glass-border)] flex items-center justify-center z-10">
        <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
          <EyeOff className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Mask</span>
        </div>
      </div>

      {/* Mask segments */}
      <div className={`absolute left-20 top-0 bottom-0 right-0 ${
        hoveredTrack === 'mask' && previewSegmentDetails ? 'cursor-pointer' : ''
      }`}>
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
    </div>
  );
});
