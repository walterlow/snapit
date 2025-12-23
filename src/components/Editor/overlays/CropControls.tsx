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
    <div className="absolute bottom-4 left-4 flex items-center gap-2 bg-[var(--card)] rounded-xl p-2 border border-[var(--polar-frost)] shadow-lg z-10">
      <span className="text-xs text-[var(--ink-muted)] px-2 font-mono">
        {Math.round(width)} × {Math.round(height)}
      </span>
      <div className="w-px h-4 bg-[var(--polar-frost)]" />
      <button
        onClick={onCancel}
        className="p-1.5 hover:bg-[var(--polar-ice)] rounded-lg transition-colors"
        title="Cancel (switch tool)"
      >
        <X size={16} className="text-[var(--ink-muted)]" />
      </button>
      {isModified && (
        <button
          onClick={onReset}
          className="px-2 py-1 text-xs text-[var(--ink-muted)] hover:bg-[var(--polar-ice)] rounded-lg transition-colors"
          title="Reset to original"
        >
          Reset
        </button>
      )}
      <button
        onClick={onCommit}
        className="p-1.5 hover:bg-emerald-100 bg-emerald-50 rounded-lg transition-colors"
        title="Apply crop"
      >
        <Check size={16} className="text-emerald-600" />
      </button>
    </div>
  );
});

CropControls.displayName = 'CropControls';
