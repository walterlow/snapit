/**
 * CaptureToolbarWindow - Unified toolbar for screen capture.
 * 
 * Simplified architecture:
 * - Rust creates fixed-size window at correct position, shows immediately
 * - Frontend just renders centered content, no sizing/positioning logic
 * - Selection updates only affect dimension display, Rust handles repositioning
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { CaptureToolbar, type ToolbarMode } from '../components/CaptureToolbar/CaptureToolbar';
import { useCaptureSettingsStore } from '../stores/captureSettingsStore';
import type { RecordingState, RecordingFormat } from '../types';

const CaptureToolbarWindow: React.FC = () => {
  // Parse initial dimensions from URL
  const initialDimensions = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      width: parseInt(params.get('width') || '0', 10),
      height: parseInt(params.get('height') || '0', 10),
    };
  }, []);

  // Capture settings from store
  const {
    settings,
    activeMode: captureType,
    isInitialized,
    loadSettings,
    setActiveMode: setCaptureType,
  } = useCaptureSettingsStore();

  // UI state
  const [dimensions, setDimensions] = useState(initialDimensions);
  const [mode, setMode] = useState<ToolbarMode>('selection');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [countdownSeconds, setCountdownSeconds] = useState<number | undefined>();

  // Refs
  const isRecordingActiveRef = useRef(false);
  const recordingInitiatedRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Load settings on mount
  useEffect(() => {
    if (!isInitialized) {
      loadSettings();
    }
  }, [isInitialized, loadSettings]);

  // Measure content and resize window to fit (with buffer for dropdowns)
  useEffect(() => {
    const DROPDOWN_BUFFER = 200; // Extra space for dropdown menus

    const measureAndResize = async () => {
      if (!toolbarRef.current) return;

      // Use getBoundingClientRect to get actual rendered size
      const rect = toolbarRef.current.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height) + DROPDOWN_BUFFER;

      if (width > 0 && height > 0) {
        try {
          await invoke('resize_capture_toolbar', { width, height });
        } catch (e) {
          console.error('Failed to resize toolbar:', e);
        }
      }
    };

    // Measure after render settles
    const timeoutId = setTimeout(measureAndResize, 50);
    return () => clearTimeout(timeoutId);
  }, [mode, captureType]); // Re-measure when mode or capture type changes

  // Listen for selection updates (dimensions only - Rust handles repositioning)
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    
    const setup = async () => {
      unlisten = await listen<{ width: number; height: number }>('selection-updated', (event) => {
        setDimensions({ width: event.payload.width, height: event.payload.height });
      });
    };
    
    setup();
    return () => { unlisten?.(); };
  }, []);

  // Listen for recording state changes
  useEffect(() => {
    let unlistenClosed: UnlistenFn | null = null;
    let unlistenState: UnlistenFn | null = null;
    let unlistenFormat: UnlistenFn | null = null;

    const setupListeners = async () => {
      const currentWindow = getCurrentWebviewWindow();
      
      unlistenClosed = await listen('capture-overlay-closed', () => {
        if (!recordingInitiatedRef.current) {
          currentWindow.close().catch(console.error);
        }
      });

      unlistenState = await listen<RecordingState>('recording-state-changed', (event) => {
        const state = event.payload;
        
        switch (state.status) {
          case 'countdown':
            isRecordingActiveRef.current = false;
            setMode('starting');
            setElapsedTime(0);
            setProgress(0);
            setErrorMessage(undefined);
            setCountdownSeconds(state.secondsRemaining);
            break;
          case 'recording':
            if (!isRecordingActiveRef.current) {
              isRecordingActiveRef.current = true;
              setElapsedTime(state.elapsedSecs);
            }
            setMode('recording');
            break;
          case 'paused':
            setMode('paused');
            setElapsedTime(state.elapsedSecs);
            break;
          case 'processing':
            setMode('processing');
            setProgress(state.progress);
            break;
          case 'completed':
          case 'idle':
            isRecordingActiveRef.current = false;
            setMode('selection');
            setElapsedTime(0);
            setProgress(0);
            Promise.all([
              invoke('hide_recording_border').catch(() => {}),
              invoke('hide_countdown_window').catch(() => {}),
              invoke('restore_main_window').catch(() => {}),
            ]).finally(() => {
              currentWindow.close().catch(console.error);
            });
            break;
          case 'error':
            isRecordingActiveRef.current = false;
            setErrorMessage(state.message);
            setMode('error');
            invoke('hide_recording_border').catch(() => {});
            invoke('hide_countdown_window').catch(() => {});
            setTimeout(() => {
              setMode('selection');
              setElapsedTime(0);
              setProgress(0);
              setErrorMessage(undefined);
              invoke('restore_main_window').catch(() => {}).finally(() => {
                currentWindow.close().catch(console.error);
              });
            }, 3000);
            break;
        }
      });

      unlistenFormat = await listen<RecordingFormat>('recording-format', (event) => {
        setFormat(event.payload);
      });
    };

    setupListeners();
    return () => {
      unlistenClosed?.();
      unlistenState?.();
      unlistenFormat?.();
    };
  }, []);

  // Timer for elapsed time during recording
  useEffect(() => {
    if (mode !== 'recording') return;
    const interval = setInterval(() => setElapsedTime(t => t + 0.1), 100);
    return () => clearInterval(interval);
  }, [mode]);

  // Handlers
  const handleCapture = useCallback(async () => {
    try {
      if (captureType === 'screenshot') {
        // Screenshot capture
        await invoke('capture_overlay_confirm', { action: 'screenshot' });
      } else {
        // Video or GIF recording
        recordingInitiatedRef.current = true;
        setMode('starting');

        // Get settings based on capture type
        const captureSettings = captureType === 'video' ? settings.video : settings.gif;
        const countdownSecs = captureSettings.countdownSecs;
        const systemAudioEnabled = captureType === 'video' ? settings.video.captureSystemAudio : false;

        await invoke('set_recording_countdown', { secs: countdownSecs });
        await invoke('set_recording_system_audio', { enabled: systemAudioEnabled });
        await invoke('capture_overlay_confirm', { action: 'recording' });
      }
    } catch (e) {
      console.error('Failed to capture:', e);
      recordingInitiatedRef.current = false;
      setMode('selection');
    }
  }, [captureType, settings]);

  const handleRedo = useCallback(async () => {
    try {
      await invoke('capture_overlay_reselect');
    } catch (e) {
      console.error('Failed to reselect:', e);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      if (mode !== 'selection') {
        await invoke('cancel_recording');
      } else {
        await invoke('capture_overlay_cancel');
      }
    } catch (e) {
      console.error('Failed to cancel:', e);
    }
  }, [mode]);

  const handlePause = useCallback(async () => {
    try { await invoke('pause_recording'); } catch (e) { console.error('Failed to pause:', e); }
  }, []);

  const handleResume = useCallback(async () => {
    try { await invoke('resume_recording'); } catch (e) { console.error('Failed to resume:', e); }
  }, []);

  const handleStop = useCallback(async () => {
    try { await invoke('stop_recording'); } catch (e) { console.error('Failed to stop:', e); }
  }, []);

  const handleDimensionChange = useCallback(async (width: number, height: number) => {
    try {
      await invoke('capture_overlay_set_dimensions', { width, height });
    } catch (e) {
      console.error('Failed to set dimensions:', e);
    }
  }, []);

  return (
    <div ref={toolbarRef} className="toolbar-container">
      <CaptureToolbar
        mode={mode}
        captureType={captureType}
        width={dimensions.width}
        height={dimensions.height}
        onCapture={handleCapture}
        onCaptureTypeChange={setCaptureType}
        onRedo={handleRedo}
        onCancel={handleCancel}
        format={format}
        elapsedTime={elapsedTime}
        progress={progress}
        errorMessage={errorMessage}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        countdownSeconds={countdownSeconds}
        onDimensionChange={handleDimensionChange}
      />
    </div>
  );
};

export default CaptureToolbarWindow;
