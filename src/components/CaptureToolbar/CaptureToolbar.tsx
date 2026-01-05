/**
 * CaptureToolbar - Redesigned minimal capture toolbar
 *
 * Layout: Horizontal toolbar with glassmorphism styling
 * [X] | [Display] [Window] [Area] | [Camera ▾] [Mic ▾] [System Audio] | [⚙️]
 * 
 * During recording: Shows timer + controls instead of settings
 */

import React, { useCallback } from 'react';
import { X, Square, Pause, Circle, Zap } from 'lucide-react';
import type { CaptureType, RecordingFormat } from '../../types';
import { ModeSelector } from './ModeSelector';
import { SourceSelector, type CaptureSource } from './SourceSelector';
import { DimensionSelect } from './DimensionSelect';
import { SourceInfoDisplay } from './SourceInfoDisplay';
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
  /** Current capture source */
  captureSource?: CaptureSource;
  /** Region dimensions */
  width: number;
  height: number;
  /** Source type: 'area', 'window', or 'display' */
  sourceType?: 'area' | 'window' | 'display';
  /** Window/app title if sourceType is 'window' */
  sourceTitle?: string | null;
  /** Monitor name if sourceType is 'display' */
  monitorName?: string | null;
  /** Monitor index if sourceType is 'display' */
  monitorIndex?: number | null;
  /** Whether a selection has been confirmed (shows record button) */
  selectionConfirmed?: boolean;
  /** Start recording or take screenshot (based on captureType) */
  onCapture: () => void;
  /** Change capture type */
  onCaptureTypeChange: (type: CaptureType) => void;
  /** Change capture source (for Area selection) */
  onCaptureSourceChange?: (source: CaptureSource) => void;
  /** Called when a capture is completed from Display/Window pickers */
  onCaptureComplete?: () => void;
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
  captureSource: _captureSource = 'area',
  width,
  height,
  sourceType,
  sourceTitle,
  monitorName,
  monitorIndex,
  selectionConfirmed = false,
  onCapture,
  onCaptureTypeChange,
  onCaptureSourceChange,
  onCaptureComplete,
  onRedo,
  onCancel,
  format = 'mp4',
  elapsedTime = 0,
  progress: _progress = 0,
  errorMessage,
  onPause,
  onResume,
  onStop,
  countdownSeconds,
  onDimensionChange,
  onOpenSettings,
}) => {
  const isGif = captureType === 'gif' || format === 'gif';
  const isRecording = mode === 'recording' || mode === 'paused';
  const isStarting = mode === 'starting';
  const isProcessing = mode === 'processing';
  const isError = mode === 'error';
  const isPaused = mode === 'paused';
  const isVideoMode = captureType === 'video'; // Only video supports webcam/audio

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
      case 'gif': return 'REC';
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
              Saving...
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
    <div className="glass-toolbar glass-toolbar--two-row pointer-events-auto">
      {/* Row 1: Mode selector (Video/GIF/Screenshot) - full width */}
      <div className="glass-toolbar-row">
        <ModeSelector
          activeMode={captureType}
          onModeChange={handleModeChange}
          disabled={isRecording || isStarting || isProcessing}
          fullWidth
        />
      </div>

      {/* Row 2: Source selector OR dimensions/info, devices, settings */}
      <div className="glass-toolbar-row">
        {/* Show source info based on selection type, or source selector if no selection */}
        {selectionConfirmed ? (
          // Selection confirmed - show appropriate info based on source type
          sourceType === 'window' || sourceType === 'display' ? (
            <SourceInfoDisplay
              sourceType={sourceType}
              sourceTitle={sourceTitle}
              monitorName={monitorName}
              monitorIndex={monitorIndex}
              onBack={onRedo}
              disabled={isRecording || isStarting || isProcessing}
            />
          ) : (
            // Area selection - show dimension selector
            <DimensionSelect
              width={width}
              height={height}
              onDimensionChange={onDimensionChange}
              onBack={onRedo}
              disabled={isRecording || isStarting || isProcessing}
            />
          )
        ) : (
          // No selection - show source selector
          <SourceSelector
            onSelectArea={() => handleSourceChange('area')}
            captureType={captureType}
            onCaptureComplete={onCaptureComplete}
            disabled={isRecording || isStarting || isProcessing}
          />
        )}

        {/* Video mode only: Show device selectors (GIF doesn't support audio/webcam) */}
        {isVideoMode && (
          <>
            <div className="glass-divider-vertical" />

            <div className="glass-devices-section">
              <div className="glass-device-column">
                <DevicePopover disabled={isRecording || isStarting || isProcessing} />
                <div className="glass-audio-meter--column-spacer" />
              </div>

              <div className="glass-device-column">
                <MicrophonePopover disabled={isRecording || isStarting || isProcessing} />
                <AudioLevelMeter
                  enabled
                  level={isMicEnabled ? micLevel : 0}
                  className="glass-audio-meter--column"
                />
              </div>

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

        <div className="glass-divider-vertical" />

        <SettingsPopover
          mode={captureType}
          disabled={isRecording || isStarting || isProcessing}
          onOpenSettings={onOpenSettings}
        />

        <div className="w-2" />

        <button
          onClick={onCapture}
          className="glass-capture-btn-pill"
          title={captureType === 'screenshot' ? 'Take screenshot' : (isVideoMode && settings.video.quickCapture ? 'Start quick recording' : 'Start recording')}
          disabled={!selectionConfirmed}
        >
          {isVideoMode && settings.video.quickCapture && (
            <Zap size={12} strokeWidth={2.5} className="glass-capture-btn-icon" />
          )}
          <span className="glass-capture-btn-label">{getCaptureLabel()}</span>
        </button>
      </div>
    </div>
  );
};

export default CaptureToolbar;
