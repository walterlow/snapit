/**
 * CaptureControlsWindow - Unified fullscreen WebView for recording controls.
 * 
 * Combines recording border + toolbar in a single window.
 * - Border: Absolutely positioned at selection, pointer-events: none
 * - Toolbar: Positioned below/above selection, receives clicks
 * 
 * No window sizing complexity - just CSS positioning in a fullscreen transparent WebView.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { CaptureToolbar, type ToolbarMode } from '../components/CaptureToolbar/CaptureToolbar';
import type { CaptureType, RecordingState, RecordingFormat } from '../types';

const TOOLBAR_HEIGHT = 56; // h-14
const TOOLBAR_MARGIN = 12;

interface SelectionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MonitorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CaptureControlsWindow: React.FC = () => {
  // Parse initial data from URL
  const initialData = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      selection: {
        x: parseInt(params.get('x') || '0', 10),
        y: parseInt(params.get('y') || '0', 10),
        width: parseInt(params.get('width') || '400', 10),
        height: parseInt(params.get('height') || '300', 10),
      },
      monitor: {
        x: parseInt(params.get('monX') || '0', 10),
        y: parseInt(params.get('monY') || '0', 10),
        width: parseInt(params.get('monW') || '1920', 10),
        height: parseInt(params.get('monH') || '1080', 10),
      },
      virtualScreen: {
        x: parseInt(params.get('vsX') || '0', 10),
        y: parseInt(params.get('vsY') || '0', 10),
        width: parseInt(params.get('vsW') || '1920', 10),
        height: parseInt(params.get('vsH') || '1080', 10),
      },
    };
  }, []);

  const [selection, setSelection] = useState<SelectionRegion>(initialData.selection);
  const [monitor] = useState<MonitorBounds>(initialData.monitor);
  const [virtualScreen] = useState(initialData.virtualScreen);
  
  // UI state
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
  const [isPaused, setIsPaused] = useState(false);
  
  // Refs
  const isRecordingActiveRef = useRef(false);
  const recordingInitiatedRef = useRef(false);

  // Calculate toolbar position (below selection, or above if no room)
  const toolbarPosition = useMemo(() => {
    const selBottom = selection.y + selection.height;
    const selCenterX = selection.x + selection.width / 2;
    
    // Check if toolbar fits below selection
    const toolbarWidth = 500; // Approximate max width
    const belowY = selBottom + TOOLBAR_MARGIN;
    const monitorBottom = monitor.y + monitor.height;
    
    let posY: number;
    if (belowY + TOOLBAR_HEIGHT + TOOLBAR_MARGIN < monitorBottom) {
      posY = belowY;
    } else {
      // Place above selection
      posY = selection.y - TOOLBAR_HEIGHT - TOOLBAR_MARGIN;
    }
    
    // Center horizontally, clamp to monitor bounds
    let posX = selCenterX - toolbarWidth / 2;
    posX = Math.max(monitor.x + TOOLBAR_MARGIN, posX);
    posX = Math.min(monitor.x + monitor.width - toolbarWidth - TOOLBAR_MARGIN, posX);
    
    // Convert to CSS position (relative to virtual screen origin)
    return {
      left: posX - virtualScreen.x,
      top: posY - virtualScreen.y,
    };
  }, [selection, monitor, virtualScreen]);

  // Selection position in CSS coordinates (relative to virtual screen)
  const selectionCSS = useMemo(() => ({
    left: selection.x - virtualScreen.x,
    top: selection.y - virtualScreen.y,
    width: selection.width,
    height: selection.height,
  }), [selection, virtualScreen]);

  // Listen for selection updates
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    
    const setup = async () => {
      unlisten = await listen<{ x: number; y: number; width: number; height: number }>('selection-updated', (event) => {
        setSelection(event.payload);
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
            setIsPaused(false);
            break;
          case 'recording':
            if (!isRecordingActiveRef.current) {
              isRecordingActiveRef.current = true;
              setElapsedTime(state.elapsedSecs);
            }
            setMode('recording');
            setIsPaused(false);
            break;
          case 'paused':
            setMode('paused');
            setElapsedTime(state.elapsedSecs);
            setIsPaused(true);
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

  // Recording border style - show during countdown, recording, and paused
  const showBorder = mode === 'starting' || mode === 'recording' || mode === 'paused';
  const borderColor = isPaused ? '#F59E0B' : '#EF4444';
  const borderPulse = mode === 'recording'; // Only pulse during active recording

  return (
    <div className="capture-controls-container">
      {/* Recording Border - shown during countdown, recording, and paused */}
      {showBorder && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: selectionCSS.left,
            top: selectionCSS.top,
            width: selectionCSS.width,
            height: selectionCSS.height,
            border: `2px solid ${borderColor}`,
            boxShadow: `inset 0 0 0 1px ${borderColor}40`,
            animation: borderPulse ? 'pulse 2s ease-in-out infinite' : 'none',
          }}
        />
      )}

      {/* Toolbar - always shown, receives clicks */}
      <div
        className="toolbar-wrapper absolute"
        style={{
          left: toolbarPosition.left,
          top: toolbarPosition.top,
        }}
      >
        <CaptureToolbar
          mode={mode}
          captureType={captureType}
          width={selection.width}
          height={selection.height}
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
        />
      </div>

      {/* Pulse animation for border */}
      <style>{`
        @keyframes pulse {
          0%, 100% {
            box-shadow: inset 0 0 0 1px ${borderColor}40;
          }
          50% {
            box-shadow: inset 0 0 8px 2px ${borderColor}60;
          }
        }
      `}</style>
    </div>
  );
};

export default CaptureControlsWindow;
