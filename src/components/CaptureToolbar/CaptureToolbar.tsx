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
  Circle, Camera, RotateCcw, X, MousePointer2, GripVertical,
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

  // Common wrapper styles
  const wrapperStyle = {
    background: 'rgba(24, 24, 24, 0.97)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
  };

  // === STARTING STATE (countdown) ===
  if (mode === 'starting') {
    const showCountdown = countdownSeconds !== undefined && countdownSeconds > 0;
    
    return (
      <div
          className="flex items-center gap-3 px-4 h-11 rounded-lg pointer-events-auto"
          style={wrapperStyle}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
        >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-center w-5 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {showCountdown ? (
          // Show countdown number with circle
          <>
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-500/20 border-2 border-red-500">
              <span className="text-red-400 text-lg font-bold select-none animate-pulse">
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
          className="ml-1 p-1.5 rounded-lg transition-colors hover:bg-red-500/20"
          title="Cancel"
        >
          <X size={14} className="text-red-400" />
        </button>
        </div>
      
    );
  }

  // === PROCESSING STATE (GIF encoding) ===
  if (mode === 'processing') {
    return (
      <div
          className="flex items-center gap-3 px-4 h-11 rounded-lg pointer-events-auto"
          style={wrapperStyle}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
        >
          {/* Drag handle */}
          <div
            data-tauri-drag-region
            className="flex items-center justify-center w-5 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
            title="Drag to move"
            onMouseDown={handleDragStart}
          >
            <GripVertical size={14} className="pointer-events-none" />
          </div>

          <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-white/70 text-sm select-none">
            Encoding GIF... {Math.round(progress * 100)}%
          </span>
          
          <button
            type="button"
            onClick={onCancel}
            className="ml-1 p-1.5 rounded-lg transition-colors hover:bg-red-500/20"
            title="Cancel"
          >
            <X size={14} className="text-red-400" />
          </button>
        </div>
      
    );
  }

  // === ERROR STATE ===
  if (mode === 'error') {
    return (
      <div
          className="flex items-center gap-3 px-4 h-11 rounded-lg pointer-events-auto"
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
            className="flex items-center justify-center w-5 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
            title="Drag to move"
            onMouseDown={handleDragStart}
          >
            <GripVertical size={14} className="pointer-events-none" />
          </div>

          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span className="text-red-400 text-sm select-none max-w-[280px] truncate">
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
          className="flex items-center gap-3 px-4 h-11 rounded-lg pointer-events-auto"
          style={{
            background: 'rgba(18, 18, 18, 0.97)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
          }}
          onPointerDown={stopPropagation}
          onPointerUp={stopPropagation}
          onPointerMove={stopPropagation}
          onClick={stopPropagation}
        >
        {/* Drag handle */}
        <div
          data-tauri-drag-region
          className="text-white/40 hover:text-white/70 transition-colors cursor-grab active:cursor-grabbing"
          title="Drag to move"
          onMouseDown={handleDragStart}
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {/* Recording indicator + timer */}
        <div className="flex items-center gap-2 select-none">
          <Circle
            size={10}
            className={isRecording ? 'text-red-500 animate-pulse' : 'text-yellow-500'}
            fill="currentColor"
          />
          <span className="text-white font-mono text-sm font-medium tabular-nums">
            {formatTime(elapsedTime)}
          </span>
        </div>

        {/* Format badge */}
        <div
          className="px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide select-none"
          style={{
            background: isGif ? 'rgba(168, 85, 247, 0.25)' : 'rgba(59, 130, 246, 0.25)',
            color: isGif ? '#c084fc' : '#93c5fd',
          }}
        >
          {format}
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-white/15" />

        {/* Control buttons */}
        <div className="flex items-center gap-0.5">
          {/* Pause/Resume button (not for GIF) */}
          {!isGif && (
            <button
              type="button"
              onClick={handlePauseResume}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-white/10"
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? (
                <Play size={14} className="text-green-400" fill="currentColor" />
              ) : (
                <Pause size={14} className="text-yellow-400" fill="currentColor" />
              )}
            </button>
          )}

          {/* Stop button */}
          <button
            type="button"
            onClick={onStop}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-white/10"
            title="Stop and save"
          >
            <Square size={14} className="text-white" fill="currentColor" />
          </button>

          {/* Cancel button */}
          <button
            type="button"
            onClick={onCancel}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-red-500/20"
            title="Cancel recording"
          >
            <X size={14} className="text-red-400" strokeWidth={2.5} />
          </button>
        </div>
        </div>
      
    );
  }

  // === SELECTION STATE (default) ===
  return (
    <div
      className="flex items-center gap-1.5 px-3 h-12 rounded-lg pointer-events-auto"
      style={wrapperStyle}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Drag handle - click to drag the toolbar window */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-center w-6 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
        title="Drag to move"
        onMouseDown={handleDragStart}
      >
        <GripVertical size={14} className="pointer-events-none" />
      </div>

      {/* Capture mode buttons - 3 circular icons */}
      <div className="flex items-center gap-1.5">
        {/* Video button - Red */}
        <button
          onClick={() => {
            if (captureType === 'video') {
              onRecord();
            } else {
              onCaptureTypeChange?.('video');
            }
          }}
          className={`flex items-center justify-center rounded-full transition-all duration-150 ${
            captureType === 'video'
              ? 'w-11 h-11 shadow-lg shadow-red-500/30 hover:scale-105 hover:brightness-110'
              : 'w-9 h-9 opacity-60 hover:opacity-90 hover:scale-105'
          }`}
          style={{
            background: captureType === 'video'
              ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
              : 'rgba(239, 68, 68, 0.35)',
          }}
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
          className={`flex items-center justify-center rounded-full transition-all duration-150 ${
            captureType === 'gif'
              ? 'w-11 h-11 shadow-lg shadow-purple-500/30 hover:scale-105 hover:brightness-110'
              : 'w-9 h-9 opacity-60 hover:opacity-90 hover:scale-105'
          }`}
          style={{
            background: captureType === 'gif'
              ? 'linear-gradient(135deg, #a855f7 0%, #9333ea 100%)'
              : 'rgba(168, 85, 247, 0.35)',
          }}
          title={captureType === 'gif' ? 'Start GIF recording' : 'Switch to GIF'}
        >
          <ImagePlay size={captureType === 'gif' ? 18 : 16} className="text-white" />
        </button>

        {/* Screenshot button - Blue */}
        <button
          onClick={onScreenshot}
          className="flex items-center justify-center w-9 h-9 rounded-full transition-all duration-150 opacity-60 hover:opacity-90 hover:scale-105"
          style={{
            background: 'rgba(59, 130, 246, 0.35)',
          }}
          title="Take screenshot"
        >
          <Camera size={16} className="text-white" />
        </button>
      </div>

      {/* Divider */}
      <div className="w-px h-6 bg-white/15 mx-0.5" />

      {/* Cursor toggle */}
      <button
        onClick={onToggleCursor}
        className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
          includeCursor ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'
        }`}
        title={includeCursor ? 'Cursor: Visible' : 'Cursor: Hidden'}
      >
        <MousePointer2 size={16} />
      </button>

      {/* Countdown toggle */}
      {onToggleCountdown && (
        <button
          onClick={onToggleCountdown}
          className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
            countdownEnabled ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'
          }`}
          title={countdownEnabled ? 'Countdown: 3s (click to disable)' : 'Countdown: Off (click to enable)'}
        >
          {countdownEnabled ? <Timer size={16} /> : <TimerOff size={16} />}
        </button>
      )}

      {/* System audio toggle */}
      {onToggleSystemAudio && (
        <button
          onClick={onToggleSystemAudio}
          className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
            systemAudioEnabled ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'
          }`}
          title={systemAudioEnabled ? 'System Audio: On (click to disable)' : 'System Audio: Off (click to enable)'}
        >
          {systemAudioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
      )}

      {/* Divider */}
      <div className="w-px h-6 bg-white/15 mx-0.5" />

      {/* Dimensions display */}
      <div
        className="flex items-center gap-0.5 px-2.5 py-1 rounded-md text-xs font-mono tabular-nums"
        style={{
          background: 'rgba(255, 255, 255, 0.08)',
          color: 'rgba(255, 255, 255, 0.7)',
        }}
      >
        <span>{Math.round(width)}</span>
        <span className="text-white/40">×</span>
        <span>{Math.round(height)}</span>
      </div>

      {/* Divider */}
      <div className="w-px h-6 bg-white/15 mx-0.5" />

      {/* Redo button */}
      <button
        onClick={onRedo}
        className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors text-white/60 hover:text-white hover:bg-white/10"
        title="Redraw region"
      >
        <RotateCcw size={16} />
      </button>

      {/* Cancel button */}
      <button
        onClick={onCancel}
        className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors text-white/60 hover:text-red-400 hover:bg-red-500/10"
        title="Cancel"
      >
        <X size={16} />
      </button>
      </div>
    
  );
};

export default CaptureToolbar;
