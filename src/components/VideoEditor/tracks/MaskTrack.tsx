import { memo, useCallback, useMemo } from 'react';
import { GripVertical, Plus } from 'lucide-react';
import type { MaskSegment, MaskType } from '../../../types';
import { useVideoEditorStore } from '../../../stores/videoEditorStore';
import { BaseSegmentItem, type BaseSegment } from './BaseTrack';

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

// CSS variable names for mask track styling
const MASK_COLORS = {
  bg: 'var(--track-mask-bg)',
  bgSelected: 'var(--track-mask-bg-selected)',
  border: 'var(--track-mask-border)',
  borderSelected: 'var(--track-mask-border-selected)',
  hover: 'var(--track-mask-hover)',
  text: 'var(--track-mask-text)',
};

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
        backgroundColor: MASK_COLORS.bg,
        borderColor: MASK_COLORS.borderSelected,
      }}
    >
      <div className="flex items-center justify-center h-full" style={{ color: MASK_COLORS.text }}>
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
});

/**
 * Render content for mask segment - shows mask type label.
 */
function renderMaskContent(segment: MaskSegment, width: number) {
  if (width <= 60) return null;

  return (
    <div className="flex items-center gap-1" style={{ color: MASK_COLORS.text }}>
      <GripVertical className="w-3 h-3" />
      <span className="text-[10px] font-mono">
        {getMaskTypeLabel(segment.maskType)}
      </span>
    </div>
  );
}

/**
 * Adapter type - MaskSegment uses 'id' field, so it's compatible with BaseSegment.
 */
type MaskSegmentWithBase = MaskSegment & BaseSegment;

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

  // Wrapper for onDragStart to match BaseSegmentItem interface
  const handleDragStart = useCallback((dragging: boolean) => {
    setDraggingMaskSegment(dragging);
  }, [setDraggingMaskSegment]);

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
        <BaseSegmentItem<MaskSegmentWithBase>
          key={segment.id}
          segment={segment}
          isSelected={segment.id === selectedMaskSegmentId}
          timelineZoom={timelineZoom}
          durationMs={durationMs}
          minDurationMs={MIN_MASK_DURATION_MS}
          onSelect={selectMaskSegment}
          onUpdate={updateMaskSegment}
          onDelete={deleteMaskSegment}
          onDragStart={handleDragStart}
          renderContent={renderMaskContent}
          bgColor={MASK_COLORS.bg}
          bgColorSelected={MASK_COLORS.bgSelected}
          borderColor={MASK_COLORS.border}
          borderColorSelected={MASK_COLORS.borderSelected}
          hoverColor={MASK_COLORS.hover}
          textColor={MASK_COLORS.text}
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
