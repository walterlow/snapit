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
import type { CaptureType, RecordingState, RecordingFormat } from '../types';

const CaptureToolbarWindow: React.FC = () => {
  // Parse initial dimensions from URL
  const initialDimensions = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      width: parseInt(params.get('width') || '0', 10),
      height: parseInt(params.get('height') || '0', 10),
    };
  }, []);

  // UI state
  const [dimensions, setDimensions] = useState(initialDimensions);
  const [includeCursor, setIncludeCursor] = useState(true);
  const [captureType, setCaptureType] = useState<CaptureType>('video');
  const [mode, setMode] = useState<ToolbarMode>('selection');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [countdownEnabled, setCountdownEnabled] = useState(true);
  const [countdownSeconds, setCountdownSeconds] = useState<number | undefined>();
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(true);
  
  // Refs
  const isRecordingActiveRef = useRef(false);
  const recordingInitiatedRef = useRef(false);

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
  const handleRecord = useCallback(async () => {
    try {
      recordingInitiatedRef.current = true;
      setMode('starting');
      await invoke('set_recording_countdown', { secs: countdownEnabled ? 3 : 0 });
      await invoke('set_recording_system_audio', { enabled: systemAudioEnabled });
      await invoke('capture_overlay_confirm', { action: 'recording' });
    } catch (e) {
      console.error('Failed to start recording:', e);
      recordingInitiatedRef.current = false;
      setMode('selection');
    }
  }, [countdownEnabled, systemAudioEnabled]);

  const handleScreenshot = useCallback(async () => {
    try {
      await invoke('capture_overlay_confirm', { action: 'screenshot' });
    } catch (e) {
      console.error('Failed to take screenshot:', e);
    }
  }, []);

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
    <div className="toolbar-container">
      <CaptureToolbar
        mode={mode}
        captureType={captureType}
        width={dimensions.width}
        height={dimensions.height}
        includeCursor={includeCursor}
        onToggleCursor={() => setIncludeCursor(p => !p)}
        onRecord={handleRecord}
        onScreenshot={handleScreenshot}
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
        countdownEnabled={countdownEnabled}
        onToggleCountdown={() => setCountdownEnabled(p => !p)}
        systemAudioEnabled={systemAudioEnabled}
        onToggleSystemAudio={() => setSystemAudioEnabled(p => !p)}
        onDimensionChange={handleDimensionChange}
      />
    </div>
  );
};

export default CaptureToolbarWindow;
