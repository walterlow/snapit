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

  // === STARTING STATE (countdown) ===
  if (mode === 'starting') {
    const showCountdown = countdownSeconds !== undefined && countdownSeconds > 0;

    return (
      <div
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="glass-drag-handle flex items-center justify-center w-5"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {showCountdown ? (
          <>
            <div className="glass-countdown select-none">
              {countdownSeconds}
            </div>
            <span className="glass-text--muted text-sm select-none">
              Starting in {countdownSeconds}...
            </span>
          </>
        ) : (
          <>
            <div className="glass-spinner" />
            <span className="glass-text--muted text-sm select-none">Starting...</span>
          </>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="glass-btn glass-btn--danger w-8 h-8 ml-1"
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
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="glass-drag-handle flex items-center justify-center w-5"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        <div className="glass-spinner" />
        <span className="glass-text--muted text-sm select-none">
          Encoding GIF... {Math.round(progress * 100)}%
        </span>

        <button
          type="button"
          onClick={onCancel}
          className="glass-btn glass-btn--danger w-8 h-8 ml-1"
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
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto"
        style={{ borderColor: 'rgba(239, 68, 68, 0.4)' }}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="glass-drag-handle flex items-center justify-center w-5"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        <div className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
        <span className="text-red-400 text-sm select-none max-w-[280px] truncate">
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
        className="glass-toolbar flex items-center gap-3 px-4 h-12 pointer-events-auto"
        onPointerDown={stopPropagation}
        onPointerUp={stopPropagation}
        onPointerMove={stopPropagation}
        onClick={stopPropagation}
      >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="glass-drag-handle"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {/* Recording indicator + timer */}
        <div className="flex items-center gap-2.5 select-none">
          <div className={`glass-recording-dot ${isPaused ? 'glass-recording-dot--paused' : ''}`} />
          <span className="glass-text glass-text--mono text-sm font-medium">
            {formatTime(elapsedTime)}
          </span>
        </div>

        {/* Format badge */}
        <div className={`glass-badge px-2.5 py-1 text-[10px] uppercase tracking-wider select-none ${
          isGif ? 'glass-badge--purple' : 'glass-badge--blue'
        }`}>
          {format}
        </div>

        {/* Divider */}
        <div className="glass-divider h-6" />

        {/* Control buttons */}
        <div className="flex items-center gap-1">
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
            className="glass-btn glass-btn--danger w-8 h-8"
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
      className="glass-toolbar flex items-center gap-2 px-3 h-14 pointer-events-auto"
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Drag handle */}
      <div
        data-tauri-drag-region
        className="glass-drag-handle flex items-center justify-center w-6"
        title="Drag to move"
        onMouseDown={handleDragStart}
      >
        <GripVertical size={14} className="pointer-events-none" />
      </div>

      {/* Capture mode buttons - 3 circular icons */}
      <div className="flex items-center gap-2">
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

        {/* Screenshot button - Blue */}
        <button
          onClick={onScreenshot}
          className="glass-btn-action glass-btn-action--blue flex items-center justify-center w-9 h-9"
          title="Take screenshot"
        >
          <Camera size={16} className="text-white" />
        </button>
      </div>

      {/* Divider */}
      <div className="glass-divider h-7 mx-1" />

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

      {/* Divider */}
      <div className="glass-divider h-7 mx-1" />

      {/* Dimensions display */}
      <div className="glass-badge flex items-center gap-1 px-2.5 py-1.5 text-xs select-none">
        <span>{Math.round(width)}</span>
        <span className="opacity-40">×</span>
        <span>{Math.round(height)}</span>
      </div>

      {/* Divider */}
      <div className="glass-divider h-7 mx-1" />

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
        className="glass-btn glass-btn--danger w-8 h-8"
        title="Cancel"
      >
        <X size={16} />
      </button>
    </div>
  );
};

export default CaptureToolbar;
