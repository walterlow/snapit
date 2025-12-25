/**
 * DcompToolbarWindow - Unified toolbar for DirectComposition overlay.
 * 
 * This window appears below the selection region and handles BOTH:
 * 1. Selection mode: region selection controls (record, screenshot, redo, cancel)
 * 2. Recording mode: recording controls (timer, pause/resume, stop, cancel)
 * 
 * The toolbar transitions between modes based on recording state events.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { RecordingToolbar, type ToolbarMode } from '../components/RegionSelector/RecordingToolbar';
import type { CaptureType, RecordingState, RecordingFormat } from '../types';

const DcompToolbarWindow: React.FC = () => {
  // Parse initial dimensions from URL params (passed when window is created)
  const initialDimensions = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return {
      width: parseInt(urlParams.get('width') || '0', 10),
      height: parseInt(urlParams.get('height') || '0', 10),
    };
  }, []);

  const [dimensions, setDimensions] = useState(initialDimensions);
  const [includeCursor, setIncludeCursor] = useState(true);
  // For now, default to 'video' - could be passed via window label or event
  const captureType: CaptureType = 'video';

  // Recording state
  const [mode, setMode] = useState<ToolbarMode>('selection');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  
  // Countdown settings
  const [countdownEnabled, setCountdownEnabled] = useState(true);
  const [countdownSeconds, setCountdownSeconds] = useState<number | undefined>();
  
  // Track if we've already started the local timer for current recording session
  const isRecordingActiveRef = useRef(false);
  
  // Track if we've initiated recording (to prevent closing on overlay-closed event)
  const recordingInitiatedRef = useRef(false);
  
  // Ref to measure toolbar content for dynamic window resizing
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Expose global function for Rust to call via eval()
  // This bypasses Tauri events which have issues in this context
  useEffect(() => {
    const updateFn = (width: number, height: number) => {
      console.log('[DcompToolbar] __updateDimensions called:', width, height);
      setDimensions({ width, height });
    };
    
    // Set on window object
    (window as unknown as { __updateDimensions: typeof updateFn }).__updateDimensions = updateFn;
    console.log('[DcompToolbar] Global __updateDimensions function registered');
    
    return () => {
      delete (window as unknown as { __updateDimensions?: unknown }).__updateDimensions;
    };
  }, []);

  // Listen for overlay closed event and recording state changes
  useEffect(() => {
    let unlistenClosed: UnlistenFn | null = null;
    let unlistenState: UnlistenFn | null = null;
    let unlistenFormat: UnlistenFn | null = null;

    const setupListeners = async () => {
      const currentWindow = getCurrentWebviewWindow();
      
      // Listen for overlay closed event
      // Only close if we haven't initiated recording (recording keeps toolbar open)
      unlistenClosed = await listen('dcomp-overlay-closed', () => {
        if (!recordingInitiatedRef.current) {
          currentWindow.close().catch(console.error);
        }
      });

      // Listen for recording state changes
      unlistenState = await listen<RecordingState>('recording-state-changed', (event) => {
        const state = event.payload;
        console.log('[DcompToolbar] State changed:', state.status);
        
        switch (state.status) {
          case 'countdown':
            // Recording starting - show countdown
            isRecordingActiveRef.current = false;
            setMode('starting');
            setElapsedTime(0);
            setProgress(0);
            setErrorMessage(undefined);
            // Extract countdown seconds from state (snake_case from Rust)
            if ('seconds_remaining' in state) {
              setCountdownSeconds((state as unknown as { seconds_remaining: number }).seconds_remaining);
            }
            break;
          case 'recording':
            // Only reset elapsed time when first transitioning to recording
            if (!isRecordingActiveRef.current) {
              isRecordingActiveRef.current = true;
              setElapsedTime('elapsedSecs' in state ? state.elapsedSecs : 0);
            }
            setMode('recording');
            break;
          case 'paused':
            setMode('paused');
            if ('elapsedSecs' in state) {
              setElapsedTime(state.elapsedSecs);
            }
            break;
          case 'processing':
            setMode('processing');
            if ('progress' in state) {
              setProgress(state.progress);
            }
            break;
          case 'completed':
          case 'idle':
            // Recording ended - reset to selection mode
            isRecordingActiveRef.current = false;
            setMode('selection');
            setElapsedTime(0);
            setProgress(0);
            // Hide windows and restore main window, then close toolbar
            // Must await these before closing to ensure they complete
            Promise.all([
              invoke('hide_recording_border').catch(() => {}),
              invoke('hide_countdown_window').catch(() => {}),
              invoke('restore_main_window').catch(() => {}),
            ]).finally(() => {
              currentWindow.close().catch(console.error);
            });
            break;
          case 'error':
            const errorMsg = 'message' in state ? state.message : 'Unknown error';
            isRecordingActiveRef.current = false;
            setErrorMessage(errorMsg);
            setMode('error');
            // Hide border and countdown immediately
            invoke('hide_recording_border').catch(() => {});
            invoke('hide_countdown_window').catch(() => {});
            // Auto-close after showing error
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

      // Listen for format changes
      unlistenFormat = await listen<RecordingFormat>('recording-format', (event) => {
        console.log('[DcompToolbar] Format changed:', event.payload);
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

  // Resize window to fit toolbar content
  useEffect(() => {
    // Small delay to ensure DOM is rendered
    const timer = setTimeout(() => {
      if (toolbarRef.current) {
        const rect = toolbarRef.current.getBoundingClientRect();
        // Add padding around the content
        const padding = 24;
        const width = Math.ceil(rect.width) + padding;
        const height = Math.ceil(rect.height) + padding;
        
        console.log('[DcompToolbar] Resizing window to:', width, height);
        invoke('resize_dcomp_toolbar', { width, height }).catch(console.error);
      }
    }, 50);
    
    return () => clearTimeout(timer);
  }, [mode]); // Re-measure when mode changes (different toolbar layouts)

  // Handlers
  const handleRecord = useCallback(async () => {
    try {
      // Mark that we've initiated recording so we don't close on overlay-closed event
      recordingInitiatedRef.current = true;
      setMode('starting');
      
      // Set countdown preference before starting (0 = instant, 3 = 3 second countdown)
      await invoke('set_recording_countdown', { secs: countdownEnabled ? 3 : 0 });
      
      // Confirm the overlay selection - this triggers the Rust side to:
      // 1. Close the overlay
      // 2. Show the recording border
      // 3. Start the recording
      // The toolbar stays open and will receive recording-state-changed events
      await invoke('dcomp_overlay_confirm', { action: 'recording' });
      
    } catch (e) {
      console.error('Failed to start recording:', e);
      recordingInitiatedRef.current = false;
      setMode('selection');
    }
  }, [countdownEnabled]);
  
  const handleToggleCountdown = useCallback(() => {
    setCountdownEnabled(prev => !prev);
  }, []);

  const handleScreenshot = useCallback(async () => {
    try {
      await invoke('dcomp_overlay_confirm', { action: 'screenshot' });
    } catch (e) {
      console.error('Failed to take screenshot:', e);
    }
  }, []);

  const handleRedo = useCallback(async () => {
    try {
      await invoke('dcomp_overlay_reselect');
    } catch (e) {
      console.error('Failed to reselect:', e);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      // If we're recording, cancel the recording
      if (mode !== 'selection') {
        console.log('[DcompToolbar] Cancel clicked during recording, invoking cancel_recording...');
        await invoke('cancel_recording');
      } else {
        // Selection mode - cancel the overlay
        await invoke('dcomp_overlay_cancel');
      }
    } catch (e) {
      console.error('Failed to cancel:', e);
    }
  }, [mode]);

  const handleToggleCursor = useCallback(() => {
    setIncludeCursor(prev => !prev);
  }, []);

  // Recording control handlers
  const handlePause = useCallback(async () => {
    console.log('[DcompToolbar] Pause clicked');
    try {
      await invoke('pause_recording');
    } catch (e) {
      console.error('Failed to pause recording:', e);
    }
  }, []);

  const handleResume = useCallback(async () => {
    console.log('[DcompToolbar] Resume clicked');
    try {
      await invoke('resume_recording');
    } catch (e) {
      console.error('Failed to resume recording:', e);
    }
  }, []);

  const handleStop = useCallback(async () => {
    console.log('[DcompToolbar] Stop clicked');
    try {
      await invoke('stop_recording');
    } catch (e) {
      console.error('Failed to stop recording:', e);
    }
  }, []);

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-none">
      <div ref={toolbarRef}>
        <RecordingToolbar
          mode={mode}
          captureType={captureType}
          width={dimensions.width}
          height={dimensions.height}
          includeCursor={includeCursor}
          onToggleCursor={handleToggleCursor}
          onRecord={handleRecord}
          onScreenshot={handleScreenshot}
          onRedo={handleRedo}
          onCancel={handleCancel}
          // Recording mode props
          format={format}
          elapsedTime={elapsedTime}
          progress={progress}
          errorMessage={errorMessage}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
          // Countdown props
          countdownSeconds={countdownSeconds}
          countdownEnabled={countdownEnabled}
          onToggleCountdown={handleToggleCountdown}
        />
      </div>
    </div>
  );
};

export default DcompToolbarWindow;
