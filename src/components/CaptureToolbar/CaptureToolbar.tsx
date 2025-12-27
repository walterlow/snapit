/**
 * CaptureToolbar - Unified toolbar for region selection AND recording controls.
 *
 * Layout: Two-row toolbar with swappable right panel
 * - Left side (always visible): Mode selector, dimensions, settings
 * - Right side (swaps based on mode):
 *   - Selection: Big capture button
 *   - Starting: Countdown display
 *   - Recording: Timer + controls (vertically split)
 *   - Processing: Progress indicator
 *   - Error: Error message
 */

import React, { useCallback } from 'react';
import {
  RotateCcw, X, GripVertical,
  Square, Pause, Circle
} from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { CaptureType, RecordingFormat } from '../../types';
import { ModeSelector } from './ModeSelector';
import { SettingsCol1, SettingsCol2, SettingsCol3 } from './InlineSettings';
import { DimensionSelect } from './DimensionSelect';

export type ToolbarMode = 'selection' | 'starting' | 'recording' | 'paused' | 'processing' | 'error';

interface CaptureToolbarProps {
  /** Toolbar mode */
  mode: ToolbarMode;
  /** Current capture type */
  captureType: CaptureType;
  /** Region dimensions */
  width: number;
  height: number;
  /** Start recording or take screenshot (based on captureType) */
  onCapture: () => void;
  /** Change capture type */
  onCaptureTypeChange: (type: CaptureType) => void;
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
  /** Countdown seconds remaining (during starting mode) */
  countdownSeconds?: number;
  // Drag props
  /** Custom drag start handler (for moving toolbar without moving border) */
  onDragStart?: (e: React.MouseEvent) => void;
  /** Callback when user changes dimensions via input */
  onDimensionChange?: (width: number, height: number) => void;
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
  onCapture,
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
  onDragStart: customDragStart,
  onDimensionChange,
}) => {
  const isGif = captureType === 'gif' || format === 'gif';
  const isRecording = mode === 'recording' || mode === 'paused';
  const isStarting = mode === 'starting';
  const isProcessing = mode === 'processing';
  const isError = mode === 'error';
  const isPaused = mode === 'paused';

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

  // Get capture button label
  const getCaptureLabel = () => {
    switch (captureType) {
      case 'video': return 'REC';
      case 'gif': return 'GIF';
      case 'screenshot': return 'SNAP';
      default: return 'GO';
    }
  };

  // Render the right panel based on mode
  const renderRightPanel = () => {
    // === COUNTDOWN (starting mode) ===
    if (isStarting) {
      const showCountdown = countdownSeconds !== undefined && countdownSeconds > 0;
      return (
        <div className="glass-right-panel glass-right-panel--countdown">
          {/* Top: Cancel button */}
          <button
            type="button"
            onClick={onCancel}
            className="glass-btn glass-btn--sm glass-btn--danger"
            title="Cancel"
          >
            <X size={14} />
          </button>
          {/* Bottom: Countdown */}
          {showCountdown ? (
            <div className="glass-countdown-large select-none">
              {countdownSeconds}
            </div>
          ) : (
            <div className="glass-spinner-large" />
          )}
        </div>
      );
    }

    // === RECORDING CONTROLS (recording/paused mode) ===
    if (isRecording) {
      return (
        <div className="glass-right-panel glass-right-panel--recording">
          {/* Top: Control buttons */}
          <div className="glass-recording-controls">
            {/* Pause/Resume button (not for GIF) */}
            {!isGif && (
              <button
                type="button"
                onClick={handlePauseResume}
                className="glass-btn glass-btn--md"
                title={isPaused ? 'Resume' : 'Pause'}
              >
                {isPaused ? (
                  <Circle size={14} className="text-red-400" fill="currentColor" />
                ) : (
                  <Pause size={14} className="text-amber-400" fill="currentColor" />
                )}
              </button>
            )}

            {/* Stop button */}
            <button
              type="button"
              onClick={onStop}
              className="glass-btn glass-btn--md"
              title="Stop and save"
            >
              <Square size={14} className="text-white" fill="currentColor" />
            </button>

            {/* Cancel button */}
            <button
              type="button"
              onClick={onCancel}
              className="glass-btn glass-btn--md glass-btn--danger"
              title="Cancel recording"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          </div>

          {/* Bottom: Timer + Format */}
          <div className="glass-recording-status">
            <div className={`glass-recording-dot ${isPaused ? 'glass-recording-dot--paused' : ''}`} />
            <span className="glass-text glass-text--mono text-sm font-medium">
              {formatTime(elapsedTime)}
            </span>
            <div className={`glass-badge px-2 py-0.5 text-[9px] uppercase tracking-wider select-none ${
              isGif ? 'glass-badge--purple' : 'glass-badge--blue'
            }`}>
              {format}
            </div>
          </div>
        </div>
      );
    }

    // === PROCESSING (GIF encoding) ===
    if (isProcessing) {
      return (
        <div className="glass-right-panel glass-right-panel--processing">
          {/* Top: Cancel button */}
          <button
            type="button"
            onClick={onCancel}
            className="glass-btn glass-btn--sm glass-btn--danger"
            title="Cancel"
          >
            <X size={14} />
          </button>
          {/* Bottom: Progress */}
          <div className="glass-spinner" />
          <span className="glass-text--muted text-xs select-none">
            {Math.round(progress * 100)}%
          </span>
        </div>
      );
    }

    // === ERROR ===
    if (isError) {
      return (
        <div className="glass-right-panel glass-right-panel--error">
          <button
            type="button"
            onClick={onCancel}
            className="glass-btn glass-btn--sm glass-btn--danger"
            title="Close"
          >
            <X size={14} />
          </button>
          <div className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
          <span className="text-red-400 text-[10px] select-none text-center leading-tight px-1">
            {errorMessage || 'Failed'}
          </span>
        </div>
      );
    }

    // === DEFAULT: Redo + Cancel on top, Capture button below ===
    return (
      <div className="glass-right-panel glass-right-panel--selection">
        {/* Top: Redo + Cancel */}
        <div className="glass-right-panel-actions">
          <button
            onClick={onRedo}
            className="glass-btn glass-btn--sm"
            title="Redraw region"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={onCancel}
            className="glass-btn glass-btn--sm glass-btn--danger"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>
        {/* Bottom: Capture button */}
        <button
          onClick={onCapture}
          className="glass-capture-btn-circle"
          title={captureType === 'screenshot' ? 'Take screenshot' : 'Start recording'}
        >
          <span className="glass-capture-btn-label">{getCaptureLabel()}</span>
        </button>
      </div>
    );
  };

  // Disable mode changes during recording
  const handleModeChange = useCallback((newMode: CaptureType) => {
    if (!isRecording && !isStarting && !isProcessing) {
      onCaptureTypeChange(newMode);
    }
  }, [isRecording, isStarting, isProcessing, onCaptureTypeChange]);

  return (
    <div
      className="glass-toolbar glass-toolbar--two-row pointer-events-auto"
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerMove={stopPropagation}
      onClick={stopPropagation}
    >
      {/* Left panel: Grabber + Mode selector (spans both rows) */}
      <div className="glass-toolbar-left">
        {/* Drag handle */}
        <div
          {...dragHandleProps}
          className="glass-drag-handle-vertical"
          title="Drag to move"
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {/* Mode selector: Video, GIF, Screenshot (vertical) */}
        <ModeSelector
          activeMode={captureType}
          onModeChange={handleModeChange}
          disabled={isRecording || isStarting || isProcessing}
        />
      </div>

      {/* Main content area (2 columns) */}
      <div className={`glass-toolbar-content ${(isRecording || isStarting || isProcessing) ? 'opacity-50 pointer-events-none' : ''}`}>
        {/* Column 1: Dimensions, FPS, Quality */}
        <div className="glass-toolbar-col">
          <DimensionSelect
            width={width}
            height={height}
            onDimensionChange={onDimensionChange}
            disabled={isRecording || isStarting || isProcessing}
          />
          <SettingsCol1 mode={captureType} />
        </div>

        {/* Column 2: Cursor, Audio, Countdown, Max */}
        <div className="glass-toolbar-col">
          <SettingsCol2 mode={captureType} />
        </div>

        {/* Column 3: Webcam (video/gif only) */}
        {(captureType === 'video' || captureType === 'gif') && (
          <div className="glass-toolbar-col">
            <SettingsCol3 mode={captureType} />
          </div>
        )}
      </div>

      {/* Right panel - swaps based on mode */}
      {renderRightPanel()}
    </div>
  );
};

export default CaptureToolbar;
