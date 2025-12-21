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
    <div className="absolute bottom-4 right-4 flex items-center gap-1 bg-gray-900/90 backdrop-blur-sm rounded-lg p-1 border border-gray-700/50 z-10">
      <button
        onClick={onZoomOut}
        className="p-1.5 hover:bg-gray-700/50 rounded transition-colors"
        title="Zoom Out"
      >
        <ZoomOut size={16} className="text-gray-300" />
      </button>
      <span className="px-2 text-xs text-gray-400 min-w-[3rem] text-center">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={onZoomIn}
        className="p-1.5 hover:bg-gray-700/50 rounded transition-colors"
        title="Zoom In"
      >
        <ZoomIn size={16} className="text-gray-300" />
      </button>
      <div className="w-px h-4 bg-gray-700 mx-1" />
      <button
        onClick={onFitToSize}
        className="p-1.5 hover:bg-gray-700/50 rounded transition-colors"
        title="Fit to Window"
      >
        <Maximize2 size={16} className="text-gray-300" />
      </button>
      <button
        onClick={onActualSize}
        className="p-1.5 hover:bg-gray-700/50 rounded transition-colors"
        title="Actual Size (100%)"
      >
        <Square size={16} className="text-gray-300" />
      </button>
    </div>
  );
});

ZoomControls.displayName = 'ZoomControls';
