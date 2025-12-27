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
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { CaptureToolbar, type ToolbarMode } from '../components/CaptureToolbar/CaptureToolbar';
import { useCaptureSettingsStore } from '../stores/captureSettingsStore';
import { useWebcamSettingsStore } from '../stores/webcamSettingsStore';
import { createErrorHandler } from '../utils/errorReporting';
import type { RecordingState, RecordingFormat } from '../types';

interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CaptureToolbarWindow: React.FC = () => {
  // Parse initial selection bounds from URL
  const initialBounds = useMemo((): SelectionBounds => {
    const params = new URLSearchParams(window.location.search);
    return {
      x: parseInt(params.get('x') || '0', 10),
      y: parseInt(params.get('y') || '0', 10),
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

  // Webcam settings
  const { closePreview: closeWebcamPreview } = useWebcamSettingsStore();

  // UI state
  const [selectionBounds, setSelectionBounds] = useState<SelectionBounds>(initialBounds);
  const selectionBoundsRef = useRef<SelectionBounds>(initialBounds);
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

  // Bring webcam preview to front after overlay is created
  useEffect(() => {
    const bringWebcamToFront = async () => {
      try {
        await invoke('bring_webcam_preview_to_front');
      } catch {
        // Ignore - webcam preview might not exist
      }
    };

    // Delay to ensure overlay is created first
    const timeoutId = setTimeout(bringWebcamToFront, 200);
    return () => clearTimeout(timeoutId);
  }, []);

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

  // Helper to move webcam to its current anchor position
  const moveWebcamToCurrentAnchor = useCallback(async (bounds: SelectionBounds) => {
    const { settings, previewOpen } = useWebcamSettingsStore.getState();
    if (!previewOpen || !settings.enabled) return;

    // Only reposition for preset anchors, not custom positions
    if (settings.position.type === 'custom') return;

    try {
      await invoke('move_webcam_to_anchor', {
        anchor: settings.position.type,
        selX: bounds.x,
        selY: bounds.y,
        selWidth: bounds.width,
        selHeight: bounds.height,
      });
    } catch (e) {
      console.error('Failed to move webcam to anchor:', e);
    }
  }, []);

  // Listen for selection updates and reposition webcam
  useEffect(() => {
    let unlistenSelection: UnlistenFn | null = null;
    let unlistenAnchor: UnlistenFn | null = null;
    let unlistenDragged: UnlistenFn | null = null;

    const setup = async () => {
      // Listen for selection bounds updates
      unlistenSelection = await listen<SelectionBounds>('selection-updated', async (event) => {
        const bounds = event.payload;
        setSelectionBounds(bounds);
        selectionBoundsRef.current = bounds;

        // Reposition webcam to follow selection (only if using anchor preset)
        await moveWebcamToCurrentAnchor(bounds);
      });

      // Listen for webcam anchor changes (also triggered on webcam preview init)
      unlistenAnchor = await listen<{ anchor: string }>('webcam-anchor-changed', async (event) => {
        const { anchor } = event.payload;
        const bounds = selectionBoundsRef.current;
        try {
          // Move webcam to anchor position
          await invoke('move_webcam_to_anchor', {
            anchor,
            selX: bounds.x,
            selY: bounds.y,
            selWidth: bounds.width,
            selHeight: bounds.height,
          });
          // Also emit selection bounds so webcam preview knows the bounds for clamping
          await emit('selection-updated', bounds);
        } catch (e) {
          console.error('Failed to move webcam to anchor:', e);
        }
      });

      // Listen for webcam being dragged (switches to "None"/custom anchor)
      unlistenDragged = await listen<{ type: 'custom'; x: number; y: number }>('webcam-position-dragged', () => {
        // Update store to show "None" in dropdown
        const store = useWebcamSettingsStore.getState();
        store.settings.position = { type: 'custom', x: 0, y: 0 };
        // Force re-render by updating via setState pattern
        useWebcamSettingsStore.setState({
          settings: { ...store.settings, position: { type: 'custom', x: 0, y: 0 } }
        });
      });
    };

    setup();
    return () => {
      unlistenSelection?.();
      unlistenAnchor?.();
      unlistenDragged?.();
    };
  }, [moveWebcamToCurrentAnchor]);

  // Position webcam on initial mount (after a delay for window creation)
  useEffect(() => {
    const initWebcamPosition = async () => {
      // Wait a bit for webcam preview to be created
      await new Promise(resolve => setTimeout(resolve, 500));
      await moveWebcamToCurrentAnchor(initialBounds);
    };

    initWebcamPosition();
  }, [initialBounds, moveWebcamToCurrentAnchor]);

  // Cleanup: close webcam preview when toolbar window unmounts
  useEffect(() => {
    return () => {
      // Close webcam preview on unmount (covers all edge cases)
      closeWebcamPreview();
    };
  }, [closeWebcamPreview]);

  // Listen for recording state changes
  useEffect(() => {
    let unlistenClosed: UnlistenFn | null = null;
    let unlistenState: UnlistenFn | null = null;
    let unlistenFormat: UnlistenFn | null = null;

    const setupListeners = async () => {
      const currentWindow = getCurrentWebviewWindow();
      
      unlistenClosed = await listen('capture-overlay-closed', async () => {
        // Close webcam preview when overlay closes
        await closeWebcamPreview();

        if (!recordingInitiatedRef.current) {
          currentWindow.close().catch(
            createErrorHandler({ operation: 'close toolbar on overlay closed', silent: true })
          );
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
              invoke('hide_recording_border').catch(
                createErrorHandler({ operation: 'hide recording border', silent: true })
              ),
              invoke('hide_countdown_window').catch(
                createErrorHandler({ operation: 'hide countdown window', silent: true })
              ),
              invoke('restore_main_window').catch(
                createErrorHandler({ operation: 'restore main window', silent: true })
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
        const countdownSecs = captureType === 'video' ? settings.video.countdownSecs : settings.gif.countdownSecs;
        const systemAudioEnabled = captureType === 'video' ? settings.video.captureSystemAudio : false;
        const fps = captureType === 'video' ? settings.video.fps : settings.gif.fps;
        const includeCursor = captureType === 'video' ? settings.video.includeCursor : settings.gif.includeCursor;
        const maxDurationSecs = captureType === 'video' ? settings.video.maxDurationSecs : settings.gif.maxDurationSecs;

        // Pass all recording settings to Rust before starting
        await invoke('set_recording_countdown', { secs: countdownSecs });
        await invoke('set_recording_system_audio', { enabled: systemAudioEnabled });
        await invoke('set_recording_fps', { fps });
        await invoke('set_recording_include_cursor', { include: includeCursor });
        await invoke('set_recording_max_duration', { secs: maxDurationSecs ?? 0 });

        // Video uses quality percentage, GIF uses quality preset
        if (captureType === 'video') {
          await invoke('set_recording_quality', { quality: settings.video.quality });
        } else {
          await invoke('set_gif_quality_preset', { preset: settings.gif.qualityPreset });
        }

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
      // Close webcam preview if open
      await closeWebcamPreview();

      if (mode !== 'selection') {
        await invoke('cancel_recording');
      } else {
        await invoke('capture_overlay_cancel');
      }
    } catch (e) {
      console.error('Failed to cancel:', e);
    }
  }, [mode, closeWebcamPreview]);

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
        width={selectionBounds.width}
        height={selectionBounds.height}
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
