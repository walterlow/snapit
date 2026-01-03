/**
 * useRecordingEvents - Listens for recording state changes from Rust backend.
 *
 * Manages the recording lifecycle: idle → countdown → recording → paused → processing → completed/error
 * Emits callbacks for state transitions so the toolbar can respond appropriately.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { RecordingState, RecordingFormat } from '../types';
import type { ToolbarMode } from '../components/CaptureToolbar/CaptureToolbar';
import { createErrorHandler } from '../utils/errorReporting';
import { useWebcamSettingsStore } from '../stores/webcamSettingsStore';
import { recordingLogger } from '../utils/logger';

interface UseRecordingEventsReturn {
  /** Current toolbar mode based on recording state */
  mode: ToolbarMode;
  /** Set mode manually (e.g., when starting recording) */
  setMode: (mode: ToolbarMode) => void;
  /** Recording format (mp4/gif) */
  format: RecordingFormat;
  /** Elapsed recording time in seconds */
  elapsedTime: number;
  /** Processing progress (0-1) */
  progress: number;
  /** Error message if in error state */
  errorMessage: string | undefined;
  /** Countdown seconds remaining */
  countdownSeconds: number | undefined;
  /** Ref to current mode (for use in closures) */
  modeRef: React.MutableRefObject<ToolbarMode>;
  /** Whether recording has been initiated (for cleanup logic) */
  recordingInitiatedRef: React.MutableRefObject<boolean>;
  /** Whether recording is currently active */
  isRecordingActiveRef: React.MutableRefObject<boolean>;
}

export function useRecordingEvents(): UseRecordingEventsReturn {
  const [mode, setModeState] = useState<ToolbarMode>('selection');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [countdownSeconds, setCountdownSeconds] = useState<number | undefined>();

  // Refs for synchronous access in event handlers
  const modeRef = useRef<ToolbarMode>('selection');
  const recordingInitiatedRef = useRef(false);
  const isRecordingActiveRef = useRef(false);
  
  // Track the last backend sync for accurate time calculation
  const lastBackendSyncRef = useRef<{ backendTime: number; localTime: number } | null>(null);

  // Wrapper to update both state and ref
  const setMode = useCallback((newMode: ToolbarMode) => {
    modeRef.current = newMode;
    setModeState(newMode);
  }, []);

  // Timer for elapsed time during recording
  // Uses hybrid approach: backend sync + local interpolation for smooth display
  useEffect(() => {
    if (mode !== 'recording') return;
    
    // Initialize sync point when timer starts
    if (!lastBackendSyncRef.current) {
      lastBackendSyncRef.current = { backendTime: 0, localTime: Date.now() };
    }
    const startTime = Date.now();
    recordingLogger.debug('Frontend timer STARTED at', new Date().toISOString());
    
    const interval = setInterval(() => {
      const sync = lastBackendSyncRef.current;
      if (sync) {
        // Calculate: backend_elapsed + local_delta since last sync
        const localDelta = (Date.now() - sync.localTime) / 1000;
        setElapsedTime(sync.backendTime + localDelta);
      }
    }, 100);
    
    return () => {
      clearInterval(interval);
      const finalTime = lastBackendSyncRef.current?.backendTime ?? 0;
      const localDuration = (Date.now() - startTime) / 1000;
      recordingLogger.debug('Frontend timer STOPPED. Backend sync:', finalTime.toFixed(3), 's, Local:', localDuration.toFixed(3), 's');
      // Don't null the ref - preserves last value for debugging
    };
  }, [mode]);

  // Listen for recording state changes
  // IMPORTANT: Empty dependency array - listeners set up once and never recreated
  // This prevents race conditions where listeners are recreated during recording
  useEffect(() => {
    let unlistenState: UnlistenFn | null = null;
    let unlistenFormat: UnlistenFn | null = null;
    let unlistenClosed: UnlistenFn | null = null;
    let unlistenReselecting: UnlistenFn | null = null;

    const currentWindow = getCurrentWebviewWindow();

    // Helper to close webcam preview - uses store directly to avoid stale closures
    const closeWebcamPreview = async () => {
      try {
        await useWebcamSettingsStore.getState().closePreview();
      } catch {
        // Ignore
      }
    };

    const setupListeners = async () => {
      // Recording state changes
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
            recordingLogger.debug('Received recording state, backend elapsedSecs:', state.elapsedSecs);
            if (!isRecordingActiveRef.current) {
              isRecordingActiveRef.current = true;
              recordingLogger.debug('Recording mode ACTIVATED, initial elapsedSecs:', state.elapsedSecs);
            }
            // Sync with backend elapsed time - store for hybrid timer calculation
            // Timer will interpolate between backend updates for smooth display
            lastBackendSyncRef.current = { backendTime: state.elapsedSecs, localTime: Date.now() };
            setElapsedTime(state.elapsedSecs);
            setMode('recording');
            break;

          case 'paused':
            setMode('paused');
            setElapsedTime(state.elapsedSecs);
            break;

          case 'processing':
            recordingLogger.debug('Received processing state - timer should stop now');
            setMode('processing');
            setProgress(state.progress);
            break;

          case 'completed':
            recordingLogger.info('Recording COMPLETED. Backend duration:', state.durationSecs, 's, file:', state.outputPath);
            isRecordingActiveRef.current = false;
            setMode('selection');
            setElapsedTime(0);
            setProgress(0);
            Promise.all([
              invoke('hide_recording_border').catch(
                createErrorHandler({ operation: 'hide recording border', silent: true })
              ),
              invoke('hide_countdown_window').catch(
                createErrorHandler({ operation: 'hide countdown window', silent: true })
              ),
              invoke('restore_main_window').catch(
                createErrorHandler({ operation: 'restore main window', silent: true })
              ),
              closeWebcamPreview().catch(
                createErrorHandler({ operation: 'close webcam preview', silent: true })
              ),
            ]).finally(() => {
              currentWindow.close().catch(
                createErrorHandler({ operation: 'close toolbar window', silent: true })
              );
            });
            break;
          case 'idle':
            isRecordingActiveRef.current = false;
            setMode('selection');
            setElapsedTime(0);
            setProgress(0);
            Promise.all([
              invoke('hide_recording_border').catch(
                createErrorHandler({ operation: 'hide recording border', silent: true })
              ),
              invoke('hide_countdown_window').catch(
                createErrorHandler({ operation: 'hide countdown window', silent: true })
              ),
              invoke('restore_main_window').catch(
                createErrorHandler({ operation: 'restore main window', silent: true })
              ),
              closeWebcamPreview().catch(
                createErrorHandler({ operation: 'close webcam preview', silent: true })
              ),
            ]).finally(() => {
              currentWindow.close().catch(
                createErrorHandler({ operation: 'close toolbar window', silent: true })
              );
            });
            break;

          case 'error':
            isRecordingActiveRef.current = false;
            setErrorMessage(state.message);
            setMode('error');
            invoke('hide_recording_border').catch(
              createErrorHandler({ operation: 'hide recording border', silent: true })
            );
            invoke('hide_countdown_window').catch(
              createErrorHandler({ operation: 'hide countdown window', silent: true })
            );
            closeWebcamPreview().catch(
              createErrorHandler({ operation: 'close webcam preview', silent: true })
            );
            // Auto-recover after 3 seconds
            setTimeout(() => {
              setMode('selection');
              setElapsedTime(0);
              setProgress(0);
              setErrorMessage(undefined);
              invoke('restore_main_window').catch(
                createErrorHandler({ operation: 'restore main window', silent: true })
              ).finally(() => {
                currentWindow.close().catch(
                  createErrorHandler({ operation: 'close toolbar window', silent: true })
                );
              });
            }, 3000);
            break;
        }
      });

      // Recording format
      unlistenFormat = await listen<RecordingFormat>('recording-format', (event) => {
        setFormat(event.payload);
      });

      // Overlay closed (not during recording) - just clean up webcam, don't close toolbar
      unlistenClosed = await listen('capture-overlay-closed', async () => {
        await closeWebcamPreview();
        // Don't close toolbar - user may want to select a different source
      });

      // Reselecting - just close webcam preview, keep toolbar open
      unlistenReselecting = await listen('capture-overlay-reselecting', async () => {
        // Close webcam preview window during selection (enabled setting preserved in Rust)
        try {
          await invoke('close_webcam_preview');
        } catch {
          // Ignore
        }
        // Don't close toolbar - keep it open for the new selection
      });
    };

    setupListeners();

    return () => {
      unlistenState?.();
      unlistenFormat?.();
      unlistenClosed?.();
      unlistenReselecting?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - listeners must not be recreated

  return {
    mode,
    setMode,
    format,
    elapsedTime,
    progress,
    errorMessage,
    countdownSeconds,
    modeRef,
    recordingInitiatedRef,
    isRecordingActiveRef,
  };
}
