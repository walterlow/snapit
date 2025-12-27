/**
 * CaptureToolbarWindow - Unified toolbar for screen capture.
 *
 * Architecture:
 * - Frontend creates window via App.tsx listener
 * - Frontend measures content, calculates position (with multi-monitor support)
 * - Frontend calls Rust to set bounds and show window
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, type Monitor } from '@tauri-apps/api/window';
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

interface ToolbarPosition {
  x: number;
  y: number;
}

const MARGIN = 8;

/**
 * Calculate optimal toolbar position with multi-monitor support.
 *
 * Algorithm:
 * 1. Find which monitor contains the selection center
 * 2. Try positioning below selection (preferred)
 * 3. If doesn't fit below, try above selection
 * 4. If doesn't fit on current monitor, switch to alternate monitor (centered)
 * 5. Clamp to monitor bounds as final fallback
 */
async function calculateToolbarPosition(
  selection: SelectionBounds,
  toolbarWidth: number,
  toolbarHeight: number
): Promise<ToolbarPosition> {
  const monitors = await availableMonitors();

  const selectionCenterX = selection.x + selection.width / 2;
  const selectionCenterY = selection.y + selection.height / 2;

  // Find monitor containing selection center
  const currentMonitor = monitors.find(m => {
    const pos = m.position;
    const size = m.size;
    return (
      selectionCenterX >= pos.x &&
      selectionCenterX < pos.x + size.width &&
      selectionCenterY >= pos.y &&
      selectionCenterY < pos.y + size.height
    );
  });

  // Calculate centered X position
  const centeredX = Math.floor(selectionCenterX - toolbarWidth / 2);

  // Position below selection
  const belowY = selection.y + selection.height + MARGIN;

  // Position above selection
  const aboveY = selection.y - toolbarHeight - MARGIN;

  // Helper to check if toolbar fits at position within a monitor
  const fitsInMonitor = (x: number, y: number, monitor: Monitor): boolean => {
    const pos = monitor.position;
    const size = monitor.size;
    return (
      x >= pos.x + MARGIN &&
      x + toolbarWidth <= pos.x + size.width - MARGIN &&
      y >= pos.y + MARGIN &&
      y + toolbarHeight <= pos.y + size.height - MARGIN
    );
  };

  // Helper to clamp position within monitor bounds
  const clampToMonitor = (x: number, y: number, monitor: Monitor): ToolbarPosition => {
    const pos = monitor.position;
    const size = monitor.size;
    return {
      x: Math.max(pos.x + MARGIN, Math.min(x, pos.x + size.width - MARGIN - toolbarWidth)),
      y: Math.max(pos.y + MARGIN, Math.min(y, pos.y + size.height - MARGIN - toolbarHeight)),
    };
  };

  // Helper to get centered position on a monitor
  const centerOnMonitor = (monitor: Monitor): ToolbarPosition => {
    const pos = monitor.position;
    const size = monitor.size;
    return {
      x: pos.x + Math.floor((size.width - toolbarWidth) / 2),
      y: pos.y + Math.floor((size.height - toolbarHeight) / 2),
    };
  };

  if (currentMonitor) {
    // Try 1: Below selection
    if (fitsInMonitor(centeredX, belowY, currentMonitor)) {
      return { x: centeredX, y: belowY };
    }

    // Try 2: Above selection
    if (fitsInMonitor(centeredX, aboveY, currentMonitor)) {
      return { x: centeredX, y: aboveY };
    }

    // Try 3: Alternate monitor (primary ↔ secondary)
    const isPrimary = currentMonitor.name === monitors.find(m => {
      // Check if this is the primary monitor (position 0,0 is often primary)
      return m.position.x === 0 && m.position.y === 0;
    })?.name;

    const alternateMonitor = isPrimary
      ? monitors.find(m => m.name !== currentMonitor.name)
      : monitors.find(m => m.position.x === 0 && m.position.y === 0) || monitors[0];

    if (alternateMonitor && alternateMonitor.name !== currentMonitor.name) {
      return centerOnMonitor(alternateMonitor);
    }

    // Try 4: Clamp to current monitor
    return clampToMonitor(centeredX, belowY, currentMonitor);
  }

  // Fallback: Use first monitor or screen origin
  if (monitors.length > 0) {
    return clampToMonitor(centeredX, belowY, monitors[0]);
  }

  // Ultimate fallback
  return { x: centeredX, y: belowY };
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
  const contentRef = useRef<HTMLDivElement>(null);

  // Animated dimensions state - explicit pixel values for CSS transitions
  const [animatedSize, setAnimatedSize] = useState<{ width: number; height: number } | null>(null);

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

  // Track if window has been shown (to avoid re-showing on mode change)
  const windowShownRef = useRef(false);

  // Initial measurement and positioning on mount
  // Measures content, calculates position (with multi-monitor support), sets bounds, and shows window
  useEffect(() => {
    if (!contentRef.current || windowShownRef.current) return;

    const measureAndShow = async () => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;

      const contentWidth = Math.ceil(rect.width);
      const contentHeight = Math.ceil(rect.height);

      // Set animated size for CSS transitions
      setAnimatedSize({ width: contentWidth, height: contentHeight });

      // Calculate window dimensions
      const dropdownBuffer = 200; // Extra space for dropdown menus
      const windowWidth = contentWidth;
      const windowHeight = contentHeight + dropdownBuffer;

      // Use multi-monitor positioning algorithm
      // This tries: below selection → above selection → alternate monitor → clamp
      const pos = await calculateToolbarPosition(initialBounds, windowWidth, windowHeight);

      try {
        // Set bounds and show window
        await invoke('set_capture_toolbar_bounds', {
          x: pos.x,
          y: pos.y,
          width: windowWidth,
          height: windowHeight,
        });
        windowShownRef.current = true;
      } catch (e) {
        console.error('Failed to set toolbar bounds:', e);
      }
    };

    // Delay to ensure content has rendered
    const timeoutId = setTimeout(measureAndShow, 50);
    return () => clearTimeout(timeoutId);
  }, [initialBounds]);

  // Measure content on mode/capture type changes for animation
  useEffect(() => {
    if (!contentRef.current || !windowShownRef.current) return;

    const measureAndAnimate = () => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const newWidth = Math.ceil(rect.width);
        const newHeight = Math.ceil(rect.height);

        // Only update if dimensions actually changed
        setAnimatedSize(prev => {
          if (prev && prev.width === newWidth && prev.height === newHeight) {
            return prev;
          }
          return { width: newWidth, height: newHeight };
        });
      }
    };

    // Small delay to ensure DOM has updated
    const timeoutId = setTimeout(measureAndAnimate, 30);
    return () => clearTimeout(timeoutId);
  }, [mode, captureType]);

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

  // Listen for selection updates (dimension display + webcam positioning)
  useEffect(() => {
    let unlistenSelection: UnlistenFn | null = null;
    let unlistenAnchor: UnlistenFn | null = null;
    let unlistenDragged: UnlistenFn | null = null;

    const setup = async () => {
      // Listen for selection bounds updates (for dimension display and webcam positioning)
      // Note: Toolbar does NOT reposition on drag - only on init/reselection
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
      {/* Animated wrapper with explicit pixel dimensions for smooth CSS transitions */}
      <div
        className="toolbar-animated-wrapper"
        style={animatedSize ? {
          width: animatedSize.width,
          height: animatedSize.height,
        } : undefined}
      >
        {/* Content measurement ref - inner content determines natural size */}
        <div ref={contentRef} className="toolbar-content-measure">
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
      </div>
    </div>
  );
};

export default CaptureToolbarWindow;
