import { memo, useCallback, useMemo } from 'react';
import { ZoomIn, GripVertical, Plus } from 'lucide-react';
import type { ZoomRegion, ZoomTransition } from '../../types';
import { useVideoEditorStore, formatTimeSimple, generateZoomRegionId } from '../../stores/videoEditorStore';

interface ZoomTrackProps {
  regions: ZoomRegion[];
  durationMs: number;
  timelineZoom: number;
  width: number;
}

// Default segment duration when adding new regions (3 seconds)
const DEFAULT_REGION_DURATION_MS = 3000;

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
      className="absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none
        border-blue-400/50 bg-blue-500/20 opacity-60
      "
      style={{ left: `${left}px`, width: `${Math.max(width, 40)}px` }}
    >
      <div className="flex items-center justify-center h-full">
        <Plus className="h-4 w-4 text-blue-400" />
      </div>
    </div>
  );
});

/**
 * Memoized zoom region component.
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
  const left = region.startMs * timelineZoom;
  const regionWidth = (region.endMs - region.startMs) * timelineZoom;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(region.id);
  }, [onSelect, region.id]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    edge: 'start' | 'end' | 'move'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    onSelect(region.id);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? region.endMs : region.startMs;
    const regionDuration = region.endMs - region.startMs;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;

      if (edge === 'start') {
        const newStartMs = Math.max(0, Math.min(region.endMs - 500, startTimeMs + deltaMs));
        onUpdate(region.id, { startMs: newStartMs });
      } else if (edge === 'end') {
        const newEndMs = Math.max(region.startMs + 500, Math.min(durationMs, startTimeMs + deltaMs));
        onUpdate(region.id, { endMs: newEndMs });
      } else {
        let newStartMs = startTimeMs + deltaMs;
        let newEndMs = newStartMs + regionDuration;

        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = regionDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - regionDuration;
        }

        onUpdate(region.id, { startMs: newStartMs, endMs: newEndMs });
      }
    };

    const handleMouseUp = () => {
      onDragStart(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [region, durationMs, timelineZoom, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(region.id);
  }, [onDelete, region.id]);

  return (
    <div
      data-region
      className={`
        absolute top-1 bottom-1 rounded-md cursor-pointer
        transition-all duration-100
        ${isSelected
          ? 'bg-blue-500/40 border-2 border-blue-400 shadow-lg shadow-blue-500/20'
          : 'bg-blue-500/25 border border-blue-500/50 hover:bg-blue-500/35'
        }
        ${region.isAuto ? 'border-dashed' : ''}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(regionWidth, 20)}px`,
      }}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-400/50 rounded-l-md"
        onMouseDown={(e) => handleMouseDown(e, 'start')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
      >
        {regionWidth > 60 && (
          <div className="flex items-center gap-1 text-blue-300/80">
            <GripVertical className="w-3 h-3" />
            <span className="text-[10px] font-mono">
              {region.scale.toFixed(1)}x
            </span>
          </div>
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-400/50 rounded-r-md"
        onMouseDown={(e) => handleMouseDown(e, 'end')}
      />

      {/* Delete button (shown when selected) */}
      {isSelected && regionWidth > 40 && (
        <button
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-xs shadow-md"
          onClick={handleDelete}
        >
          ×
        </button>
      )}

      {/* Tooltip showing time range */}
      {isSelected && (
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-zinc-300 text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-20">
          {formatTimeSimple(region.startMs)} - {formatTimeSimple(region.endMs)}
        </div>
      )}
    </div>
  );
});

/**
 * ZoomTrack - Displays and allows editing of zoom regions.
 * Memoized to prevent re-renders during playback.
 */
export const ZoomTrack = memo(function ZoomTrack({
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

  // Calculate preview region details when hovering
  const previewRegionDetails = useMemo(() => {
    // Only show preview when hovering over this track and not playing
    if (hoveredTrack !== 'zoom' || previewTimeMs === null || isPlaying) {
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

    // Check for collisions with existing regions
    for (const reg of regions) {
      if (startMs < reg.endMs && endMs > reg.startMs) {
        return null;
      }
    }

    return { startMs, endMs };
  }, [hoveredTrack, previewTimeMs, isPlaying, regions, durationMs]);

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
      isAuto: false,
      transition: defaultTransition,
    };

    addZoomRegion(newRegion);
  }, [previewRegionDetails, addZoomRegion]);

  return (
    <div
      className="relative h-10 bg-zinc-800/60"
      style={{ width: `${width}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTrackClick}
    >
      {/* Track label */}
      <div className="absolute left-0 top-0 bottom-0 w-20 bg-zinc-900/80 border-r border-zinc-700/50 flex items-center justify-center z-10">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <ZoomIn className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Zoom</span>
        </div>
      </div>

      {/* Zoom regions */}
      <div className={`absolute left-20 top-0 bottom-0 right-0 ${
        hoveredTrack === 'zoom' && previewRegionDetails ? 'cursor-pointer' : ''
      }`}>
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
            <span className="text-[10px] text-zinc-500">
              Hover to add zoom regions
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
