/**
 * CaptureToolbar - Unified toolbar for region selection AND recording controls.
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
  Camera, RotateCcw, X, MousePointer2, GripVertical,
  Square, Pause, Play, Timer, TimerOff, Volume2, VolumeX,
  Video, ImagePlay
} from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { CaptureType, RecordingFormat } from '../../types';

export type ToolbarMode = 'selection' | 'starting' | 'recording' | 'paused' | 'processing' | 'error';

interface CaptureToolbarProps {
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
  /** Change capture type (video/gif) */
  onCaptureTypeChange?: (type: CaptureType) => void;
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
  // Audio props
  /** Whether system audio capture is enabled */
  systemAudioEnabled?: boolean;
  /** Toggle system audio capture on/off */
  onToggleSystemAudio?: () => void;
  // Drag props
  /** Custom drag start handler (for moving toolbar without moving border) */
  onDragStart?: (e: React.MouseEvent) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export const CaptureToolbar: React.FC<CaptureToolbarProps> = ({
  mode,
  captureType,
  width,
  height,
  includeCursor,
  onToggleCursor,
  onRecord,
  onScreenshot,
  onCaptureTypeChange,
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
  systemAudioEnabled = true,
  onToggleSystemAudio,
  onDragStart: customDragStart,
}) => {
  const isGif = captureType === 'gif' || format === 'gif';

  // Stop all pointer events from bubbling up to RegionSelector
  const stopPropagation = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
  };

  // Handle drag start - use custom handler if provided, otherwise Tauri's startDragging
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (customDragStart) {
      customDragStart(e);
    } else {
      getCurrentWebviewWindow().startDragging().catch(console.error);
    }
  }, [customDragStart]);

  // Drag handle props - use JS handler for cursor control
  const dragHandleProps = { onMouseDown: handleDragStart };

  // Handle pause/resume toggle
  const handlePauseResume = useCallback(() => {
    if (mode === 'paused') {
      onResume?.();
    } else {
      onPause?.();
    }
  }, [mode, onPause, onResume]);

  // === STARTING STATE (countdown) ===
  if (mode === 'starting') {
    const showCountdown = countdownSeconds !== undefined && countdownSeconds > 0;

    return (
      <div
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto whitespace-nowrap"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          {...dragHandleProps}
          className="glass-drag-handle flex items-center justify-center w-5 shrink-0"
          title="Drag to move"
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {showCountdown ? (
          <>
            <div className="glass-countdown select-none shrink-0">
              {countdownSeconds}
            </div>
            <span className="glass-text--muted text-sm select-none shrink-0">
              Starting in {countdownSeconds}...
            </span>
          </>
        ) : (
          <>
            <div className="glass-spinner shrink-0" />
            <span className="glass-text--muted text-sm select-none shrink-0">Starting...</span>
          </>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="glass-btn glass-btn--danger w-8 h-8 ml-1 shrink-0"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  // === PROCESSING STATE (GIF encoding) ===
  if (mode === 'processing') {
    return (
      <div
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto whitespace-nowrap"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          {...dragHandleProps}
          className="glass-drag-handle flex items-center justify-center w-5 shrink-0"
          title="Drag to move"
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        <div className="glass-spinner shrink-0" />
        <span className="glass-text--muted text-sm select-none shrink-0">
          Encoding GIF... {Math.round(progress * 100)}%
        </span>

        <button
          type="button"
          onClick={onCancel}
          className="glass-btn glass-btn--danger w-8 h-8 ml-1 shrink-0"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  // === ERROR STATE ===
  if (mode === 'error') {
    return (
      <div
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto whitespace-nowrap"
        style={{ borderColor: 'rgba(239, 68, 68, 0.4)' }}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          {...dragHandleProps}
          className="glass-drag-handle flex items-center justify-center w-5 shrink-0"
          title="Drag to move"
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        <div className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] shrink-0" />
        <span className="text-red-400 text-sm select-none max-w-[280px] truncate shrink-0">
          {errorMessage || 'Recording failed'}
        </span>
      </div>
    );
  }

  // === RECORDING/PAUSED STATE ===
  if (mode === 'recording' || mode === 'paused') {
    const isPaused = mode === 'paused';

    return (
      <div
        className="glass-toolbar flex items-center gap-3 pl-4 pr-5 h-12 pointer-events-auto whitespace-nowrap"
        onPointerDown={stopPropagation}
        onPointerUp={stopPropagation}
        onPointerMove={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          {...dragHandleProps}
          className="glass-drag-handle shrink-0"
          title="Drag to move"
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {/* Recording indicator + timer */}
        <div className="flex items-center gap-2.5 select-none shrink-0">
          <div className={`glass-recording-dot ${isPaused ? 'glass-recording-dot--paused' : ''}`} />
          <span className="glass-text glass-text--mono text-sm font-medium">
            {formatTime(elapsedTime)}
          </span>
        </div>

        {/* Format badge */}
        <div className={`glass-badge px-2.5 py-1 text-[10px] uppercase tracking-wider select-none shrink-0 ${
          isGif ? 'glass-badge--purple' : 'glass-badge--blue'
        }`}>
          {format}
        </div>

        {/* Divider */}
        <div className="glass-divider h-6 shrink-0" />

        {/* Control buttons */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Pause/Resume button (not for GIF) */}
          {!isGif && (
            <button
              type="button"
              onClick={handlePauseResume}
              className="glass-btn w-8 h-8"
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? (
                <Play size={14} className="text-emerald-400" fill="currentColor" />
              ) : (
                <Pause size={14} className="text-amber-400" fill="currentColor" />
              )}
            </button>
          )}

          {/* Stop button */}
          <button
            type="button"
            onClick={onStop}
            className="glass-btn w-8 h-8"
            title="Stop and save"
          >
            <Square size={14} className="text-white" fill="currentColor" />
          </button>

          {/* Cancel button */}
          <button
            type="button"
            onClick={onCancel}
            className="glass-btn glass-btn--danger w-8 h-8 shrink-0 mr-1"
            title="Cancel recording"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  }

  // === SELECTION STATE (default) ===
  return (
    <div
      className="glass-toolbar flex items-center gap-3 pl-1.5 pr-5 h-14 pointer-events-auto whitespace-nowrap"
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Drag handle - full height for better UX */}
      <div
        {...dragHandleProps}
        className="glass-drag-handle flex items-center justify-center w-6 h-14 shrink-0 -ml-1.5"
        title="Drag to move"
      >
        <GripVertical size={14} className="pointer-events-none" />
      </div>

      {/* Container 1: Recording mode buttons */}
      <div className="flex items-center gap-1.5 relative z-0">
        {/* Video button - Red */}
        <button
          onClick={() => {
            if (captureType === 'video') {
              onRecord();
            } else {
              onCaptureTypeChange?.('video');
            }
          }}
          className={`glass-btn-action flex items-center justify-center ${
            captureType === 'video'
              ? 'w-11 h-11'
              : 'w-9 h-9 glass-btn-action--inactive'
          }`}
          title={captureType === 'video' ? 'Start video recording' : 'Switch to video'}
        >
          <Video size={captureType === 'video' ? 18 : 16} className="text-white" />
        </button>

        {/* GIF button - Purple */}
        <button
          onClick={() => {
            if (captureType === 'gif') {
              onRecord();
            } else {
              onCaptureTypeChange?.('gif');
            }
          }}
          className={`glass-btn-action glass-btn-action--purple flex items-center justify-center ${
            captureType === 'gif'
              ? 'w-11 h-11'
              : 'w-9 h-9 glass-btn-action--inactive'
          }`}
          title={captureType === 'gif' ? 'Start GIF recording' : 'Switch to GIF'}
        >
          <ImagePlay size={captureType === 'gif' ? 18 : 16} className="text-white" />
        </button>
      </div>

      {/* Divider */}
      <div className="glass-divider h-7" />

      {/* Container 2: Screenshot button */}
      <div className="flex items-center">
        <button
          onClick={onScreenshot}
          className="glass-btn-action glass-btn-action--blue flex items-center justify-center w-9 h-9"
          title="Take screenshot"
        >
          <Camera size={16} className="text-white" />
        </button>
      </div>

      {/* Divider */}
      <div className="glass-divider h-7" />

      {/* Container 3: Options (Cursor, Timer, Audio) */}
      <div className="flex items-center gap-0.5">
        {/* Cursor toggle */}
        <button
          onClick={onToggleCursor}
          className={`glass-btn w-8 h-8 ${includeCursor ? 'glass-btn--active' : ''}`}
          title={includeCursor ? 'Cursor: Visible' : 'Cursor: Hidden'}
        >
          <MousePointer2 size={16} />
        </button>

        {/* Countdown toggle */}
        {onToggleCountdown && (
          <button
            onClick={onToggleCountdown}
            className={`glass-btn w-8 h-8 ${countdownEnabled ? 'glass-btn--active' : ''}`}
            title={countdownEnabled ? 'Countdown: 3s (click to disable)' : 'Countdown: Off (click to enable)'}
          >
            {countdownEnabled ? <Timer size={16} /> : <TimerOff size={16} />}
          </button>
        )}

        {/* System audio toggle */}
        {onToggleSystemAudio && (
          <button
            onClick={onToggleSystemAudio}
            className={`glass-btn w-8 h-8 ${systemAudioEnabled ? 'glass-btn--active' : ''}`}
            title={systemAudioEnabled ? 'System Audio: On (click to disable)' : 'System Audio: Off (click to enable)'}
          >
            {systemAudioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="glass-divider h-7" />

      {/* Container 4: Dimensions + Actions */}
      <div className="flex items-center gap-1">
        {/* Dimensions display - two separate boxes */}
        <div className="glass-badge flex items-center justify-center h-8 min-w-[3.5rem] px-2 text-xs select-none tabular-nums">
          {Math.round(width)}
        </div>
        <span className="text-white/40 text-xs select-none">×</span>
        <div className="glass-badge flex items-center justify-center h-8 min-w-[3.5rem] px-2 text-xs select-none tabular-nums">
          {Math.round(height)}
        </div>

        {/* Redo button */}
        <button
          onClick={onRedo}
          className="glass-btn w-8 h-8"
          title="Redraw region"
        >
          <RotateCcw size={16} />
        </button>

        {/* Cancel button */}
        <button
          onClick={onCancel}
          className="glass-btn glass-btn--danger w-8 h-8 mr-1"
          title="Cancel"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default CaptureToolbar;
