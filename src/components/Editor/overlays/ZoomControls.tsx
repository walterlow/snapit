import React from 'react';
import { ZoomIn, ZoomOut, Maximize2, Square } from 'lucide-react';

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToSize: () => void;
  onActualSize: () => void;
}

/**
 * Zoom control buttons - bottom right corner
 */
export const ZoomControls: React.FC<ZoomControlsProps> = React.memo(({
  zoom,
  onZoomIn,
  onZoomOut,
  onFitToSize,
  onActualSize,
}) => {
  return (
    <div className="absolute bottom-4 right-4 flex items-center gap-1 bg-white rounded-xl p-1 border border-[var(--polar-frost)] shadow-lg z-10">
      <button
        onClick={onZoomOut}
        className="p-1.5 hover:bg-[var(--polar-ice)] rounded-lg transition-colors"
        title="Zoom Out"
      >
        <ZoomOut size={16} className="text-[var(--ink-muted)]" />
      </button>
      <span className="px-2 text-xs text-[var(--ink-muted)] min-w-[3rem] text-center font-medium">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={onZoomIn}
        className="p-1.5 hover:bg-[var(--polar-ice)] rounded-lg transition-colors"
        title="Zoom In"
      >
        <ZoomIn size={16} className="text-[var(--ink-muted)]" />
      </button>
      <div className="w-px h-4 bg-[var(--polar-frost)] mx-1" />
      <button
        onClick={onFitToSize}
        className="p-1.5 hover:bg-[var(--polar-ice)] rounded-lg transition-colors"
        title="Fit to Window"
      >
        <Maximize2 size={16} className="text-[var(--ink-muted)]" />
      </button>
      <button
        onClick={onActualSize}
        className="p-1.5 hover:bg-[var(--polar-ice)] rounded-lg transition-colors"
        title="Actual Size (100%)"
      >
        <Square size={16} className="text-[var(--ink-muted)]" />
      </button>
    </div>
  );
});

ZoomControls.displayName = 'ZoomControls';
