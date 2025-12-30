/**
 * CaptureToolbar - Redesigned minimal capture toolbar
 *
 * Layout: Horizontal toolbar with glassmorphism styling
 * [X] | [Display] [Window] [Area] | [Camera ▾] [Mic ▾] [System Audio] | [⚙️]
 * 
 * During recording: Shows timer + controls instead of settings
 */

import React, { useCallback } from 'react';
import {
  X, GripVertical,
  Square, Pause, Circle
} from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { CaptureType, RecordingFormat } from '../../types';
import { ModeSelector } from './ModeSelector';
import { SourceSelector, type CaptureSource } from './SourceSelector';
import { DevicePopover } from './DevicePopover';
import { MicrophonePopover } from './MicrophonePopover';
import { SystemAudioToggle } from './SystemAudioToggle';
import { SettingsPopover } from './SettingsPopover';
import { AudioLevelMeter } from './AudioLevelMeter';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
import { useRustAudioLevels } from '@/hooks/useRustAudioLevels';

export type ToolbarMode = 'selection' | 'starting' | 'recording' | 'paused' | 'processing' | 'error';

interface CaptureToolbarProps {
  /** Toolbar mode */
  mode: ToolbarMode;
  /** Current capture type */
  captureType: CaptureType;
  /** Current capture source (display/window/area) */
  captureSource?: CaptureSource;
  /** Region dimensions */
  width: number;
  height: number;
  /** Whether toolbar is in startup mode (source buttons trigger capture) */
  isStartupMode?: boolean;
  /** Start recording or take screenshot (based on captureType) */
  onCapture: () => void;
  /** Change capture type */
  onCaptureTypeChange: (type: CaptureType) => void;
  /** Change capture source */
  onCaptureSourceChange?: (source: CaptureSource) => void;
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
  /** Open settings modal */
  onOpenSettings?: () => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export const CaptureToolbar: React.FC<CaptureToolbarProps> = ({
  mode,
  captureType,
  captureSource = 'area',
  width: _width,
  height: _height,
  isStartupMode = false,
  onCapture,
  onCaptureTypeChange,
  onCaptureSourceChange,
  onRedo: _onRedo,
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
  onOpenSettings,
}) => {
  const isGif = captureType === 'gif' || format === 'gif';
  const isRecording = mode === 'recording' || mode === 'paused';
  const isStarting = mode === 'starting';
  const isProcessing = mode === 'processing';
  const isError = mode === 'error';
  const isPaused = mode === 'paused';
  const isVideoMode = captureType === 'video' || captureType === 'gif';

  // Get audio settings for level meters
  const { settings } = useCaptureSettingsStore();
  const micDeviceIndex = settings.video.microphoneDeviceIndex;
  const isMicEnabled = micDeviceIndex !== null;
  const isSystemAudioEnabled = settings.video.captureSystemAudio;

  // Use Rust WASAPI audio monitoring for both mic and system audio
  // This provides accurate levels from the same sources used during recording
  const { micLevel, systemLevel } = useRustAudioLevels({
    micDeviceIndex: isMicEnabled ? micDeviceIndex : null,
    monitorSystemAudio: isSystemAudioEnabled,
    enabled: isVideoMode && !isRecording && !isStarting && !isProcessing,
  });

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

  // Disable mode changes during recording
  const handleModeChange = useCallback((newMode: CaptureType) => {
    if (!isRecording && !isStarting && !isProcessing) {
      onCaptureTypeChange(newMode);
    }
  }, [isRecording, isStarting, isProcessing, onCaptureTypeChange]);

  // Handle source change
  const handleSourceChange = useCallback((source: CaptureSource) => {
    if (!isRecording && !isStarting && !isProcessing) {
      onCaptureSourceChange?.(source);
    }
  }, [isRecording, isStarting, isProcessing, onCaptureSourceChange]);

  // Render recording UI
  if (isRecording || isStarting || isProcessing || isError) {
    return (
      <div className="glass-toolbar glass-toolbar--minimal pointer-events-auto">
        {/* Drag handle */}
        <div
          onMouseDown={handleDragStart}
          className="glass-drag-handle-minimal"
          title="Drag to move"
        >
          <GripVertical size={14} className="pointer-events-none" />
        </div>

        {/* Recording status */}
        {isRecording && (
          <div className="glass-recording-section">
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
        )}

        {/* Countdown */}
        {isStarting && (
          <div className="glass-countdown-section">
            {countdownSeconds !== undefined && countdownSeconds > 0 ? (
              <div className="glass-countdown-large select-none">
                {countdownSeconds}
              </div>
            ) : (
              <div className="glass-spinner-large" />
            )}
          </div>
        )}

        {/* Processing */}
        {isProcessing && (
          <div className="glass-processing-section">
            <div className="glass-spinner" />
            <span className="glass-text--muted text-xs select-none">
              {Math.round(progress * 100)}%
            </span>
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="glass-error-section">
            <div className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
            <span className="text-red-400 text-[10px] select-none">
              {errorMessage || 'Failed'}
            </span>
          </div>
        )}

        {/* Divider */}
        <div className="glass-divider-vertical" />

        {/* Controls */}
        <div className="glass-controls-section">
          {/* Pause/Resume button (not for GIF, not during starting/processing/error) */}
          {isRecording && !isGif && (
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
          {isRecording && (
            <button
              type="button"
              onClick={onStop}
              className="glass-btn glass-btn--md"
              title="Stop and save"
            >
              <Square size={14} className="text-white" fill="currentColor" />
            </button>
          )}

          {/* Cancel button */}
          <button
            type="button"
            onClick={onCancel}
            className="glass-btn glass-btn--md glass-btn--danger"
            title="Cancel"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  }

  // Render selection UI (default state)
  return (
    <div className="glass-toolbar glass-toolbar--minimal pointer-events-auto">
      {/* Close button */}
      <button
        onClick={onCancel}
        className="glass-close-btn"
        title="Cancel"
      >
        <X size={16} strokeWidth={2} />
      </button>

      {/* Divider */}
      <div className="glass-divider-vertical" />

      {/* Mode selector (Video/GIF/Screenshot) */}
      <ModeSelector
        activeMode={captureType}
        onModeChange={handleModeChange}
        disabled={isRecording || isStarting || isProcessing}
      />

      {/* Divider */}
      <div className="glass-divider-vertical" />

      {/* Source selector (Display/Window/Area) */}
      <SourceSelector
        activeSource={captureSource}
        onSourceChange={handleSourceChange}
        disabled={isRecording || isStarting || isProcessing}
      />

      {/* Video mode: Show device selectors in columns */}
      {isVideoMode && (
        <>
          {/* Divider */}
          <div className="glass-divider-vertical" />

          {/* Device selectors - 3 columns with consistent height */}
          <div className="glass-devices-section">
            {/* Camera column - spacer for consistent layout */}
            <div className="glass-device-column">
              <DevicePopover disabled={isRecording || isStarting || isProcessing} />
              <div className="glass-audio-meter--column-spacer" />
            </div>

            {/* Microphone column with level meter */}
            <div className="glass-device-column">
              <MicrophonePopover disabled={isRecording || isStarting || isProcessing} />
              <AudioLevelMeter
                enabled
                level={isMicEnabled ? micLevel : 0}
                className="glass-audio-meter--column"
              />
            </div>

            {/* System Audio column with level meter */}
            <div className="glass-device-column">
              <SystemAudioToggle disabled={isRecording || isStarting || isProcessing} />
              <AudioLevelMeter
                enabled
                level={isSystemAudioEnabled ? systemLevel : 0}
                className="glass-audio-meter--column"
              />
            </div>
          </div>
        </>
      )}

      {/* Divider */}
      <div className="glass-divider-vertical" />

      {/* Settings gear */}
      <SettingsPopover 
        mode={captureType}
        disabled={isRecording || isStarting || isProcessing}
        onOpenSettings={onOpenSettings}
      />

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="glass-drag-handle-minimal"
        title="Drag to move"
      >
        <GripVertical size={14} className="pointer-events-none" />
      </div>

      {/* Capture button - hidden in startup mode (source buttons trigger capture) */}
      {!isStartupMode && (
        <button
          onClick={onCapture}
          className="glass-capture-btn-pill"
          title={captureType === 'screenshot' ? 'Take screenshot' : 'Start recording'}
        >
          <span className="glass-capture-btn-label">{getCaptureLabel()}</span>
        </button>
      )}
    </div>
  );
};

export default CaptureToolbar;
