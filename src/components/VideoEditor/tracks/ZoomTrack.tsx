import { memo, useCallback, useMemo } from 'react';
import { GripVertical, Plus } from 'lucide-react';
import type { ZoomRegion, ZoomTransition } from '../../../types';
import { useVideoEditorStore, generateZoomRegionId } from '../../../stores/videoEditorStore';
import { BaseSegmentItem, type BaseSegment } from './BaseTrack';

interface ZoomTrackProps {
  regions: ZoomRegion[];
  durationMs: number;
  timelineZoom: number;
  width: number;
}

// Default segment duration when adding new regions (3 seconds)
const DEFAULT_REGION_DURATION_MS = 3000;
// Minimum duration to allow adding a region (500ms)
const MIN_REGION_DURATION_MS = 500;

// CSS variable names for zoom track styling
const ZOOM_COLORS = {
  bg: 'var(--track-zoom-bg)',
  bgSelected: 'var(--track-zoom-bg-selected)',
  border: 'var(--track-zoom-border)',
  borderSelected: 'var(--track-zoom-border-selected)',
  hover: 'var(--track-zoom-hover)',
  text: 'var(--track-zoom-text)',
};

// Selectors for atomic subscriptions
const selectSelectedZoomRegionId = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.selectedZoomRegionId;

/**
 * Preview region shown when hovering over empty track space.
 */
const PreviewRegion = memo(function PreviewRegion({
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
        backgroundColor: ZOOM_COLORS.bg,
        borderColor: ZOOM_COLORS.borderSelected,
      }}
    >
      <div className="flex items-center justify-center h-full" style={{ color: ZOOM_COLORS.text }}>
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
});

/**
 * Render content for zoom region - shows scale factor.
 */
function renderZoomContent(region: ZoomRegion, width: number) {
  if (width <= 60) return null;

  return (
    <div className="flex items-center gap-1" style={{ color: ZOOM_COLORS.text }}>
      <GripVertical className="w-3 h-3" />
      <span className="text-[10px] font-mono">
        {region.scale.toFixed(1)}x
      </span>
    </div>
  );
}

/**
 * Adapter to convert ZoomRegion to BaseSegment interface.
 * ZoomRegion already has id, startMs, endMs so it's compatible.
 */
type ZoomSegment = ZoomRegion & BaseSegment;

/**
 * ZoomTrackContent - Track content without label for two-column layout.
 * Memoized to prevent re-renders during playback.
 */
export const ZoomTrackContent = memo(function ZoomTrackContent({
  regions,
  durationMs,
  timelineZoom,
  width
}: ZoomTrackProps) {
  const selectedZoomRegionId = useVideoEditorStore(selectSelectedZoomRegionId);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);
  const hoveredTrack = useVideoEditorStore((s) => s.hoveredTrack);
  const setHoveredTrack = useVideoEditorStore((s) => s.setHoveredTrack);
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);

  const {
    selectZoomRegion,
    updateZoomRegion,
    deleteZoomRegion,
    addZoomRegion,
    setDraggingZoomRegion,
  } = useVideoEditorStore();

  // Check if any segment is being dragged
  const isDraggingAny = useVideoEditorStore((s) =>
    s.isDraggingZoomRegion || s.isDraggingSceneSegment || s.isDraggingMaskSegment || s.isDraggingTextSegment
  );

  // Calculate preview region details when hovering
  const previewRegionDetails = useMemo(() => {
    // Only show preview when hovering over this track, not playing, and not dragging
    if (hoveredTrack !== 'zoom' || previewTimeMs === null || isPlaying || isDraggingAny) {
      return null;
    }

    // Check if hovering over an existing region
    const isOnRegion = regions.some(
      (reg) => previewTimeMs >= reg.startMs && previewTimeMs <= reg.endMs
    );

    if (isOnRegion) {
      return null;
    }

    // Calculate preview region bounds - left edge at playhead
    const startMs = previewTimeMs;
    const endMs = Math.min(durationMs, startMs + DEFAULT_REGION_DURATION_MS);

    // Don't allow if there's not enough space for minimum duration
    if (endMs - startMs < MIN_REGION_DURATION_MS) {
      return null;
    }

    // Check for collisions with existing regions
    for (const reg of regions) {
      if (startMs < reg.endMs && endMs > reg.startMs) {
        return null;
      }
    }

    return { startMs, endMs };
  }, [hoveredTrack, previewTimeMs, isPlaying, isDraggingAny, regions, durationMs]);

  // Handle track hover
  const handleMouseEnter = useCallback(() => {
    setHoveredTrack('zoom');
  }, [setHoveredTrack]);

  const handleMouseLeave = useCallback(() => {
    setHoveredTrack(null);
  }, [setHoveredTrack]);

  // Handle click to add region
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    // Only add if we have a valid preview region
    if (!previewRegionDetails) return;

    // Don't add if clicking on a region
    if ((e.target as HTMLElement).closest('[data-segment]')) return;

    const defaultTransition: ZoomTransition = {
      durationInMs: 300,
      durationOutMs: 300,
      easing: 'easeInOut',
    };

    const newRegion: ZoomRegion = {
      id: generateZoomRegionId(),
      startMs: previewRegionDetails.startMs,
      endMs: previewRegionDetails.endMs,
      scale: 2.0,
      targetX: 0.5,
      targetY: 0.5,
      mode: 'auto',
      isAuto: false,
      transition: defaultTransition,
    };

    addZoomRegion(newRegion);
  }, [previewRegionDetails, addZoomRegion]);

  // Wrapper for onDragStart to match BaseSegmentItem interface
  const handleDragStart = useCallback((dragging: boolean) => {
    setDraggingZoomRegion(dragging);
  }, [setDraggingZoomRegion]);

  return (
    <div
      className={`relative h-12 bg-[var(--polar-mist)]/60 border-b border-[var(--glass-border)] ${
        hoveredTrack === 'zoom' && previewRegionDetails ? 'cursor-pointer' : ''
      }`}
      style={{ width: `${width}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTrackClick}
    >
      {regions.map((region) => (
        <BaseSegmentItem<ZoomSegment>
          key={region.id}
          segment={region}
          isSelected={region.id === selectedZoomRegionId}
          timelineZoom={timelineZoom}
          durationMs={durationMs}
          minDurationMs={MIN_REGION_DURATION_MS}
          onSelect={selectZoomRegion}
          onUpdate={updateZoomRegion}
          onDelete={deleteZoomRegion}
          onDragStart={handleDragStart}
          renderContent={renderZoomContent}
          bgColor={ZOOM_COLORS.bg}
          bgColorSelected={ZOOM_COLORS.bgSelected}
          borderColor={ZOOM_COLORS.border}
          borderColorSelected={ZOOM_COLORS.borderSelected}
          hoverColor={ZOOM_COLORS.hover}
          textColor={ZOOM_COLORS.text}
          className={region.isAuto ? 'border-dashed' : ''}
        />
      ))}

      {/* Preview region (ghost) when hovering over empty space */}
      {previewRegionDetails && (
        <PreviewRegion
          startMs={previewRegionDetails.startMs}
          endMs={previewRegionDetails.endMs}
          timelineZoom={timelineZoom}
        />
      )}

      {/* Empty state hint */}
      {regions.length === 0 && !previewRegionDetails && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-[var(--ink-subtle)]">
            Hover to add zoom regions
          </span>
        </div>
      )}
    </div>
  );
});
