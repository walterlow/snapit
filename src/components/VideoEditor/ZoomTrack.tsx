import { memo, useCallback, useMemo, useRef } from 'react';
import { GripVertical, Plus } from 'lucide-react';
import type { ZoomRegion, ZoomTransition } from '../../types';
import { useVideoEditorStore, formatTimeSimple, generateZoomRegionId } from '../../stores/videoEditorStore';

// Drag state stored in ref to avoid re-renders during drag
interface DragState {
  startMs: number;
  endMs: number;
}

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
        backgroundColor: 'var(--track-zoom-bg)',
        borderColor: 'var(--track-zoom-border-selected)',
      }}
    >
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--track-zoom-text)' }}>
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
});

/**
 * Memoized zoom region component.
 * Uses refs for intermediate drag state to avoid re-renders during drag.
 */
const ZoomRegionItem = memo(function ZoomRegionItem({
  region,
  isSelected,
  timelineZoom,
  durationMs,
  onSelect,
  onUpdate,
  onDelete,
  onDragStart,
}: {
  region: ZoomRegion;
  isSelected: boolean;
  timelineZoom: number;
  durationMs: number;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<ZoomRegion>) => void;
  onDelete: (id: string) => void;
  onDragStart: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const left = region.startMs * timelineZoom;
  const regionWidth = (region.endMs - region.startMs) * timelineZoom;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(region.id);
  }, [onSelect, region.id]);

  const handlePointerDown = useCallback((
    e: React.PointerEvent,
    edge: 'start' | 'end' | 'move'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer to prevent flickering when cursor leaves element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    onSelect(region.id);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? region.endMs : region.startMs;
    const regionDuration = region.endMs - region.startMs;

    // Initialize drag state
    dragStateRef.current = { startMs: region.startMs, endMs: region.endMs };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;

      let newStartMs = dragStateRef.current!.startMs;
      let newEndMs = dragStateRef.current!.endMs;

      if (edge === 'start') {
        newStartMs = Math.max(0, Math.min(region.endMs - 500, startTimeMs + deltaMs));
        newEndMs = region.endMs;
      } else if (edge === 'end') {
        newStartMs = region.startMs;
        newEndMs = Math.max(region.startMs + 500, Math.min(durationMs, startTimeMs + deltaMs));
      } else {
        newStartMs = startTimeMs + deltaMs;
        newEndMs = newStartMs + regionDuration;

        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = regionDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - regionDuration;
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
        if (startMs !== region.startMs || endMs !== region.endMs) {
          onUpdate(region.id, { startMs, endMs });
        }
      }
      dragStateRef.current = null;
      onDragStart(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [region, durationMs, timelineZoom, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(region.id);
  }, [onDelete, region.id]);

  return (
    <div
      ref={elementRef}
      data-region
      className={`
        absolute top-1 bottom-1 rounded-md cursor-pointer
        ${isSelected ? 'border-2 shadow-lg' : 'border'}
        ${region.isAuto ? 'border-dashed' : ''}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(regionWidth, 20)}px`,
        backgroundColor: isSelected ? 'var(--track-zoom-bg-selected)' : 'var(--track-zoom-bg)',
        borderColor: isSelected ? 'var(--track-zoom-border-selected)' : 'var(--track-zoom-border)',
      }}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md touch-none"
        style={{ '--tw-bg-opacity': 1 } as React.CSSProperties}
        onPointerDown={(e) => handlePointerDown(e, 'start')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--track-zoom-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'move')}
      >
        {regionWidth > 60 && (
          <div className="flex items-center gap-1" style={{ color: 'var(--track-zoom-text)' }}>
            <GripVertical className="w-3 h-3" />
            <span className="text-[10px] font-mono">
              {region.scale.toFixed(1)}x
            </span>
          </div>
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'end')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--track-zoom-hover)')}
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
          {formatTimeSimple(region.startMs)} - {formatTimeSimple(region.endMs)}
        </div>
      )}
    </div>
  );
});

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
    if ((e.target as HTMLElement).closest('[data-region]')) return;

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
        <ZoomRegionItem
          key={region.id}
          region={region}
          isSelected={region.id === selectedZoomRegionId}
          timelineZoom={timelineZoom}
          durationMs={durationMs}
          onSelect={selectZoomRegion}
          onUpdate={updateZoomRegion}
          onDelete={deleteZoomRegion}
          onDragStart={setDraggingZoomRegion}
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
