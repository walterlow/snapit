import React from 'react';
import { Check, X } from 'lucide-react';

interface CropControlsProps {
  width: number;
  height: number;
  isModified: boolean;
  onCancel: () => void;
  onReset: () => void;
  onCommit: () => void;
}

/**
 * Crop control buttons - bottom left corner
 * Shows dimensions and action buttons during crop mode
 */
export const CropControls: React.FC<CropControlsProps> = React.memo(({
  width,
  height,
  isModified,
  onCancel,
  onReset,
  onCommit,
}) => {
  return (
    <div className="absolute bottom-4 left-4 flex items-center gap-2 bg-gray-900/90 backdrop-blur-sm rounded-lg p-2 border border-gray-700/50 z-10">
      <span className="text-xs text-gray-400 px-2">
        {Math.round(width)} × {Math.round(height)}
      </span>
      <div className="w-px h-4 bg-gray-700" />
      <button
        onClick={onCancel}
        className="p-1.5 hover:bg-gray-700/50 rounded transition-colors"
        title="Cancel (switch tool)"
      >
        <X size={16} className="text-gray-300" />
      </button>
      {isModified && (
        <button
          onClick={onReset}
          className="px-2 py-1 text-xs text-gray-300 hover:bg-gray-700/50 rounded transition-colors"
          title="Reset to original"
        >
          Reset
        </button>
      )}
      <button
        onClick={onCommit}
        className="p-1.5 hover:bg-green-700/50 bg-green-800/50 rounded transition-colors"
        title="Apply crop"
      >
        <Check size={16} className="text-green-300" />
      </button>
    </div>
  );
});

CropControls.displayName = 'CropControls';
