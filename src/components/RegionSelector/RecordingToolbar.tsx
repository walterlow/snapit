/**
 * RecordingToolbar - Unified toolbar for region selection AND recording controls.
 * 
 * Mode: Selection
 * - Start recording (with countdown)
 * - Take a screenshot instead
 * - Redo (redraw) the region
 * - Cancel and close overlay
 * - Toggle cursor options
 * 
 * Mode: Recording
 * - Timer display
 * - Format badge (MP4/GIF)
 * - Pause/Resume (MP4 only)
 * - Stop recording
 * - Cancel recording
 */

import React, { useCallback } from 'react';
import { 
  Circle, Camera, RotateCcw, X, MousePointer2, GripVertical,
  Square, Pause, Play, Timer, TimerOff
} from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { CaptureType, RecordingFormat } from '../../types';

export type ToolbarMode = 'selection' | 'starting' | 'recording' | 'paused' | 'processing' | 'error';

interface RecordingToolbarProps {
  /** Toolbar mode */
  mode: ToolbarMode;
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
  // Recording mode props
  /** Recording format (mp4/gif/webm) */
  format?: RecordingFormat;
  /** Elapsed recording time in seconds */
  elapsedTime?: number;
  /** GIF encoding progress (0-1) */
  progress?: number;
  /** Error message */
  errorMessage?: string;
  /** Pause recording */
  onPause?: () => void;
  /** Resume recording */
  onResume?: () => void;
  /** Stop recording */
  onStop?: () => void;
  // Countdown props
  /** Countdown seconds remaining (during starting mode) */
  countdownSeconds?: number;
  /** Whether countdown is enabled (3s delay before recording) */
  countdownEnabled?: boolean;
  /** Toggle countdown on/off */
  onToggleCountdown?: () => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export const RecordingToolbar: React.FC<RecordingToolbarProps> = ({
  mode,
  captureType,
  width,
  height,
  includeCursor,
  onToggleCursor,
  onRecord,
  onScreenshot,
  onRedo,
  onCancel,
  format = 'mp4',
  elapsedTime = 0,
  progress = 0,
  errorMessage,
  onPause,
  onResume,
  onStop,
  countdownSeconds,
  countdownEnabled = true,
  onToggleCountdown,
}) => {
  const isGif = captureType === 'gif' || format === 'gif';

  // Stop all pointer events from bubbling up to RegionSelector
  const stopPropagation = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

  // Handle drag start - use Tauri's startDragging API
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    getCurrentWebviewWindow().startDragging().catch(console.error);
  }, []);

  // Handle pause/resume toggle
  const handlePauseResume = useCallback(() => {
    if (mode === 'paused') {
      onResume?.();
    } else {
      onPause?.();
    }
  }, [mode, onPause, onResume]);

  // Common wrapper styles
  const wrapperStyle = {
    background: 'rgba(30, 30, 30, 0.95)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
  };

  // === STARTING STATE (countdown) ===
  if (mode === 'starting') {
    const showCountdown = countdownSeconds !== undefined && countdownSeconds > 0;
    
    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl pointer-events-auto"
        style={wrapperStyle}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-center w-6 h-8 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={16} className="pointer-events-none" />
        </div>

        {showCountdown ? (
          // Show countdown number with circle
          <>
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-red-500/20 border-2 border-red-500">
              <span className="text-red-400 text-xl font-bold select-none animate-pulse">
                {countdownSeconds}
              </span>
            </div>
            <span className="text-white/70 text-sm select-none">Starting in {countdownSeconds}...</span>
          </>
        ) : (
          // No countdown, show spinner
          <>
            <div className="w-3 h-3 border-2 border-white/50 border-t-transparent rounded-full animate-spin" />
            <span className="text-white/50 text-sm select-none">Starting...</span>
          </>
        )}
        
        <button
          type="button"
          onClick={onCancel}
          className="ml-2 p-1.5 rounded-lg transition-colors hover:bg-red-500/20"
          title="Cancel"
        >
          <X size={16} className="text-red-400" />
        </button>
      </div>
    );
  }

  // === PROCESSING STATE (GIF encoding) ===
  if (mode === 'processing') {
    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl pointer-events-auto"
        style={wrapperStyle}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-center w-6 h-8 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={16} className="pointer-events-none" />
        </div>

        <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
        <span className="text-white/70 text-sm select-none">
          Encoding GIF... {Math.round(progress * 100)}%
        </span>
        
        <button
          type="button"
          onClick={onCancel}
          className="ml-2 p-1.5 rounded-lg transition-colors hover:bg-red-500/20"
          title="Cancel"
        >
          <X size={16} className="text-red-400" />
        </button>
      </div>
    );
  }

  // === ERROR STATE ===
  if (mode === 'error') {
    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl pointer-events-auto"
        style={{
          ...wrapperStyle,
          border: '1px solid rgba(239, 68, 68, 0.5)',
        }}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-center w-6 h-8 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={16} className="pointer-events-none" />
        </div>

        <div className="w-4 h-4 rounded-full bg-red-500" />
        <span className="text-red-400 text-sm select-none max-w-[300px] truncate">
          {errorMessage || 'Recording failed'}
        </span>
      </div>
    );
  }

  // === RECORDING/PAUSED STATE ===
  if (mode === 'recording' || mode === 'paused') {
    const isRecording = mode === 'recording';
    const isPaused = mode === 'paused';

    return (
      <div
        className="flex items-center gap-2 pl-1 pr-3 py-2 rounded-xl pointer-events-auto"
        style={wrapperStyle}
        onPointerDown={stopPropagation}
        onPointerUp={stopPropagation}
        onPointerMove={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-center w-6 h-10 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={16} className="pointer-events-none" />
        </div>

        {/* Recording indicator + timer */}
        <div className="flex items-center gap-2 select-none">
          <Circle
            size={12}
            className={isRecording ? 'text-red-500 animate-pulse' : 'text-yellow-500'}
            fill="currentColor"
          />
          <span className="text-white font-mono text-sm font-medium min-w-[52px]">
            {formatTime(elapsedTime)}
          </span>
        </div>

        {/* Format badge */}
        <div
          className="px-2 py-0.5 rounded text-xs font-medium uppercase select-none"
          style={{
            background: isGif ? 'rgba(168, 85, 247, 0.3)' : 'rgba(59, 130, 246, 0.3)',
            color: isGif ? '#c084fc' : '#93c5fd',
          }}
        >
          {format}
        </div>

        {/* Divider */}
        <div className="w-px h-8 bg-white/20" />

        {/* Pause/Resume button (not for GIF) */}
        {!isGif && (
          <button
            type="button"
            onClick={handlePauseResume}
            className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors hover:bg-white/10"
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? (
              <Play size={18} className="text-green-400" fill="currentColor" />
            ) : (
              <Pause size={18} className="text-yellow-400" fill="currentColor" />
            )}
          </button>
        )}

        {/* Stop button */}
        <button
          type="button"
          onClick={onStop}
          className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors hover:bg-white/10"
          title="Stop and save"
        >
          <Square size={18} className="text-white" fill="currentColor" />
        </button>

        {/* Cancel button */}
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors text-white/70 hover:text-red-400 hover:bg-red-500/10"
          title="Cancel recording"
        >
          <X size={18} />
        </button>
      </div>
    );
  }

  // === SELECTION STATE (default) ===
  return (
    <div
      className="flex items-center gap-2 pl-1 pr-3 py-2 rounded-xl pointer-events-auto"
      style={wrapperStyle}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Drag handle - click to drag the toolbar window */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-center w-6 h-10 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
        title="Drag to move"
        onMouseDown={handleDragStart}
      >
        <GripVertical size={16} className="pointer-events-none" />
      </div>

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

      {/* Countdown toggle */}
      {onToggleCountdown && (
        <button
          onClick={onToggleCountdown}
          className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
            countdownEnabled ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'
          }`}
          title={countdownEnabled ? 'Countdown: 3s (click to disable)' : 'Countdown: Off (click to enable)'}
        >
          {countdownEnabled ? <Timer size={18} /> : <TimerOff size={18} />}
        </button>
      )}

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
