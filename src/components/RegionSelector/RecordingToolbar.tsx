/**
 * RecordingToolbar - Toolbar shown after region selection in video/gif mode.
 * 
 * Allows user to:
 * - Start recording (with countdown)
 * - Take a screenshot instead
 * - Redo (redraw) the region
 * - Cancel and close overlay
 * - Toggle audio/microphone/cursor options
 */

import React from 'react';
import { Circle, Camera, RotateCcw, X, MousePointer2 } from 'lucide-react';
import type { CaptureType } from '../../types';

interface RecordingToolbarProps {
  /** Current capture type (video or gif) */
  captureType: CaptureType;
  /** Region dimensions */
  width: number;
  height: number;
  /** Whether to include cursor in recording */
  includeCursor: boolean;
  /** Toggle cursor inclusion */
  onToggleCursor: () => void;
  /** Start recording (triggers countdown) */
  onRecord: () => void;
  /** Take screenshot instead */
  onScreenshot: () => void;
  /** Redo/redraw the region */
  onRedo: () => void;
  /** Cancel and close */
  onCancel: () => void;
}

export const RecordingToolbar: React.FC<RecordingToolbarProps> = ({
  captureType,
  width,
  height,
  includeCursor,
  onToggleCursor,
  onRecord,
  onScreenshot,
  onRedo,
  onCancel,
}) => {
  const isGif = captureType === 'gif';

  // Stop all pointer events from bubbling up to RegionSelector
  const stopPropagation = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-xl pointer-events-auto"
      style={{
        background: 'rgba(30, 30, 30, 0.95)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      }}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Record button */}
      <button
        onClick={onRecord}
        className="flex items-center justify-center w-10 h-10 rounded-lg transition-all hover:scale-105"
        style={{
          background: '#ef4444',
        }}
        title={`Start ${isGif ? 'GIF' : 'video'} recording`}
      >
        <Circle size={20} className="text-white" fill="currentColor" />
      </button>

      {/* Divider */}
      <div className="w-px h-8 bg-white/20" />

      {/* Cursor toggle */}
      <button
        onClick={onToggleCursor}
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
          includeCursor ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'
        }`}
        title={includeCursor ? 'Cursor: Visible' : 'Cursor: Hidden'}
      >
        <MousePointer2 size={18} />
      </button>

      {/* Divider */}
      <div className="w-px h-8 bg-white/20" />

      {/* Dimensions display */}
      <div
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-mono"
        style={{
          background: 'rgba(255, 255, 255, 0.1)',
          color: 'rgba(255, 255, 255, 0.8)',
        }}
      >
        <span>{Math.round(width)}</span>
        <span className="text-white/40">×</span>
        <span>{Math.round(height)}</span>
      </div>

      {/* Divider */}
      <div className="w-px h-8 bg-white/20" />

      {/* Screenshot button */}
      <button
        onClick={onScreenshot}
        className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors text-white/70 hover:text-white hover:bg-white/10"
        title="Take screenshot instead"
      >
        <Camera size={18} />
      </button>

      {/* Redo button */}
      <button
        onClick={onRedo}
        className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors text-white/70 hover:text-white hover:bg-white/10"
        title="Redraw region"
      >
        <RotateCcw size={18} />
      </button>

      {/* Cancel button */}
      <button
        onClick={onCancel}
        className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors text-white/70 hover:text-red-400 hover:bg-red-500/10"
        title="Cancel"
      >
        <X size={18} />
      </button>
    </div>
  );
};

export default RecordingToolbar;
