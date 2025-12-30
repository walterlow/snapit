import { useCallback } from 'react';
import { ZoomIn, GripVertical } from 'lucide-react';
import type { ZoomRegion } from '../../types';
import { useVideoEditorStore, formatTimeSimple } from '../../stores/videoEditorStore';

interface ZoomTrackProps {
  regions: ZoomRegion[];
  durationMs: number;
  timelineZoom: number;
  width: number;
}

/**
 * ZoomTrack - Displays and allows editing of zoom regions.
 * Blue rectangles represent zoom-in areas that can be dragged and resized.
 */
export function ZoomTrack({ regions, durationMs, timelineZoom, width }: ZoomTrackProps) {
  const {
    selectedZoomRegionId,
    selectZoomRegion,
    updateZoomRegion,
    deleteZoomRegion,
    setDraggingZoomRegion,
  } = useVideoEditorStore();

  const handleRegionClick = useCallback((e: React.MouseEvent, regionId: string) => {
    e.stopPropagation();
    selectZoomRegion(regionId);
  }, [selectZoomRegion]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    regionId: string,
    edge: 'start' | 'end' | 'move'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    
    selectZoomRegion(regionId);
    setDraggingZoomRegion(true, edge);

    const region = regions.find(r => r.id === regionId);
    if (!region) return;

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? region.endMs : region.startMs;
    const regionDuration = region.endMs - region.startMs;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;
      
      if (edge === 'start') {
        const newStartMs = Math.max(0, Math.min(region.endMs - 500, startTimeMs + deltaMs));
        updateZoomRegion(regionId, { startMs: newStartMs });
      } else if (edge === 'end') {
        const newEndMs = Math.max(region.startMs + 500, Math.min(durationMs, startTimeMs + deltaMs));
        updateZoomRegion(regionId, { endMs: newEndMs });
      } else {
        // Move entire region
        let newStartMs = startTimeMs + deltaMs;
        let newEndMs = newStartMs + regionDuration;
        
        // Clamp to timeline bounds
        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = regionDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - regionDuration;
        }
        
        updateZoomRegion(regionId, { startMs: newStartMs, endMs: newEndMs });
      }
    };

    const handleMouseUp = () => {
      setDraggingZoomRegion(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [regions, durationMs, timelineZoom, selectZoomRegion, updateZoomRegion, setDraggingZoomRegion]);

  const handleDelete = useCallback((e: React.MouseEvent, regionId: string) => {
    e.stopPropagation();
    deleteZoomRegion(regionId);
  }, [deleteZoomRegion]);

  return (
    <div 
      className="relative h-10 bg-zinc-800/60"
      style={{ width: `${width}px` }}
    >
      {/* Track label */}
      <div className="absolute left-0 top-0 bottom-0 w-20 bg-zinc-900/80 border-r border-zinc-700/50 flex items-center justify-center z-10">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <ZoomIn className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Zoom</span>
        </div>
      </div>

      {/* Zoom regions */}
      <div className="absolute left-20 top-0 bottom-0 right-0">
        {regions.map((region) => {
          const left = region.startMs * timelineZoom;
          const regionWidth = (region.endMs - region.startMs) * timelineZoom;
          const isSelected = region.id === selectedZoomRegionId;

          return (
            <div
              key={region.id}
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
              onClick={(e) => handleRegionClick(e, region.id)}
            >
              {/* Left resize handle */}
              <div
                className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-400/50 rounded-l-md"
                onMouseDown={(e) => handleMouseDown(e, region.id, 'start')}
              />

              {/* Center drag handle */}
              <div
                className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center"
                onMouseDown={(e) => handleMouseDown(e, region.id, 'move')}
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
                onMouseDown={(e) => handleMouseDown(e, region.id, 'end')}
              />

              {/* Delete button (shown when selected) */}
              {isSelected && regionWidth > 40 && (
                <button
                  className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-xs shadow-md"
                  onClick={(e) => handleDelete(e, region.id)}
                >
                  ×
                </button>
              )}

              {/* Tooltip showing time range */}
              {isSelected && (
                <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-zinc-300 text-[10px] px-2 py-0.5 rounded whitespace-nowrap">
                  {formatTimeSimple(region.startMs)} - {formatTimeSimple(region.endMs)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
