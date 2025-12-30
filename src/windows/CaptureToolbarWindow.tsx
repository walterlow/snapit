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
import { toast, Toaster } from 'sonner';
import { CaptureToolbar, type ToolbarMode } from '../components/CaptureToolbar/CaptureToolbar';
import type { CaptureSource } from '../components/CaptureToolbar/SourceSelector';
import { useCaptureSettingsStore } from '../stores/captureSettingsStore';
import { useWebcamSettingsStore } from '../stores/webcamSettingsStore';
import { useSettingsStore } from '../stores/settingsStore';
import { createErrorHandler } from '../utils/errorReporting';
import { useTheme } from '../hooks/useTheme';
import type { RecordingState, RecordingFormat } from '../types';

interface WebcamErrorEvent {
  message: string;
  is_fatal: boolean;
}

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
const SHADOW_PADDING = 32; // Padding around toolbar for shadow rendering

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
  // Parse initial selection bounds and mode from URL
  const { initialBounds, isStartupMode } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    return {
      isStartupMode: mode === 'startup',
      initialBounds: {
        x: parseInt(params.get('x') || '0', 10),
        y: parseInt(params.get('y') || '0', 10),
        width: parseInt(params.get('width') || '0', 10),
        height: parseInt(params.get('height') || '0', 10),
      } as SelectionBounds
    };
  }, []);

  // Apply theme to this window
  useTheme();

  // Capture settings from store
  const {
    settings,
    activeMode: captureType,
    isInitialized,
    loadSettings,
    setActiveMode: setCaptureType,
  } = useCaptureSettingsStore();

  // Webcam settings
  const { settings: webcamSettings, closePreview: closeWebcamPreview } = useWebcamSettingsStore();

  // UI state
  const [selectionBounds, setSelectionBounds] = useState<SelectionBounds>(initialBounds);
  const selectionBoundsRef = useRef<SelectionBounds>(initialBounds);
  const [mode, setMode] = useState<ToolbarMode>('selection');
  const [format, setFormat] = useState<RecordingFormat>('mp4');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [countdownSeconds, setCountdownSeconds] = useState<number | undefined>();
  const [captureSource, setCaptureSource] = useState<CaptureSource>('area');

  // Refs
  const isRecordingActiveRef = useRef(false);
  const recordingInitiatedRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);


  // Load settings on mount
  useEffect(() => {
    if (!isInitialized) {
      loadSettings();
    }
  }, [isInitialized, loadSettings]);

  // Load webcam settings from Rust and restore preview state on mount
  // Skip in startup mode - webcam is only for active capture sessions
  useEffect(() => {
    if (isStartupMode) return; // Skip webcam init in startup mode

    const initWebcam = async () => {
      // Load settings from Rust (source of truth, shared across windows)
      const { loadSettings } = useWebcamSettingsStore.getState();
      await loadSettings();

      const { settings, previewOpen, togglePreview } = useWebcamSettingsStore.getState();
      console.log('[Toolbar] After loading - webcam state:', { enabled: settings.enabled, previewOpen });

      // If webcam was enabled but preview isn't open, open it
      if (settings.enabled && !previewOpen) {
        console.log('[Toolbar] Reopening webcam preview');
        await togglePreview();
      } else if (settings.enabled && previewOpen) {
        // Just bring existing preview to front
        try {
          await invoke('bring_webcam_preview_to_front');
        } catch {
          // Ignore - webcam preview might not exist
        }
      }
    };

    // Delay to ensure overlay is created first
    const timeoutId = setTimeout(initWebcam, 200);
    return () => clearTimeout(timeoutId);
  }, [isStartupMode]);

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

      // Calculate window dimensions with padding for shadow rendering
      const windowWidth = contentWidth + (SHADOW_PADDING * 2); // padding on both sides
      const windowHeight = contentHeight + (SHADOW_PADDING * 2); // padding top and bottom

      // In startup mode, just resize and show - position was set by Rust
      // In capture mode, calculate position based on selection bounds
      if (isStartupMode) {
        try {
          // Resize the window to fit content
          await invoke('resize_capture_toolbar', {
            width: windowWidth,
            height: windowHeight,
          });
          // Show the window (it's positioned by Rust in show_startup_toolbar)
          const currentWindow = getCurrentWebviewWindow();
          await currentWindow.show();
          windowShownRef.current = true;
        } catch (e) {
          console.error('Failed to show startup toolbar:', e);
        }
      } else {
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
      }
    };

    // Delay to ensure content has rendered
    const timeoutId = setTimeout(measureAndShow, 50);
    return () => clearTimeout(timeoutId);
  }, [initialBounds, isStartupMode]);


  // ResizeObserver - resize Tauri window when ANY content changes (including portaled popovers)
  // Observes document.body to catch all DOM changes automatically
  useEffect(() => {
    let lastWidth = 0;
    let lastHeight = 0;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const calculateAndResize = () => {
      // Get the bounding box of all content including portaled elements
      const body = document.body;
      const scrollWidth = body.scrollWidth;
      const scrollHeight = body.scrollHeight;
      
      // Also check for any Radix portaled content that might extend beyond
      const portalElements = document.querySelectorAll('[data-radix-popper-content-wrapper]');
      let maxBottom = scrollHeight;
      let maxRight = scrollWidth;
      
      portalElements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        maxBottom = Math.max(maxBottom, rect.bottom);
        maxRight = Math.max(maxRight, rect.right);
      });

      const newWidth = Math.ceil(Math.max(scrollWidth, maxRight));
      const newHeight = Math.ceil(Math.max(scrollHeight, maxBottom));

      // Only resize if dimensions actually changed
      if (newWidth !== lastWidth || newHeight !== lastHeight) {
        lastWidth = newWidth;
        lastHeight = newHeight;
        invoke('resize_capture_toolbar', { width: newWidth, height: newHeight }).catch(
          createErrorHandler({ operation: 'resize capture toolbar', silent: true })
        );
      }
    };

    // Debounced resize to avoid excessive calls
    const debouncedResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(calculateAndResize, 16); // ~1 frame
    };

    // Observe document body for any size changes
    const resizeObserver = new ResizeObserver(debouncedResize);
    resizeObserver.observe(document.body);

    // Also observe for DOM mutations (popover portals being added/removed)
    const mutationObserver = new MutationObserver(debouncedResize);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-state'],
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, []);

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
  // Skip in startup mode - no active selection
  useEffect(() => {
    if (isStartupMode) return; // Skip selection listeners in startup mode

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
  }, [isStartupMode, moveWebcamToCurrentAnchor]);

  // Position webcam on initial mount (after a delay for window creation)
  // Skip in startup mode - no active selection
  useEffect(() => {
    if (isStartupMode) return; // Skip webcam positioning in startup mode

    const initWebcamPosition = async () => {
      // Wait a bit for webcam preview to be created
      await new Promise(resolve => setTimeout(resolve, 500));
      await moveWebcamToCurrentAnchor(initialBounds);
    };

    initWebcamPosition();
  }, [initialBounds, isStartupMode, moveWebcamToCurrentAnchor]);

  // Note: We do NOT close webcam on unmount - it stays open during reselection
  // Webcam is only closed via handleCancel or when recording completes

  // Listen for recording state changes
  useEffect(() => {
    let unlistenClosed: UnlistenFn | null = null;
    let unlistenReselecting: UnlistenFn | null = null;
    let unlistenState: UnlistenFn | null = null;
    let unlistenFormat: UnlistenFn | null = null;

    const setupListeners = async () => {
      const currentWindow = getCurrentWebviewWindow();

      unlistenClosed = await listen('capture-overlay-closed', async () => {
        // Close webcam preview when overlay closes (actual cancel/close)
        await closeWebcamPreview();

        if (!recordingInitiatedRef.current) {
          currentWindow.close().catch(
            createErrorHandler({ operation: 'close toolbar on overlay closed', silent: true })
          );
        }
      });

      // Listen for reselection - close preview during selection, but remember enabled state
      unlistenReselecting = await listen('capture-overlay-reselecting', async () => {
        console.log('[Toolbar] Received capture-overlay-reselecting event');

        // Close the preview window during selection (but enabled setting is preserved in Rust)
        const { previewOpen } = useWebcamSettingsStore.getState();
        if (previewOpen) {
          // Just close the window, don't change enabled setting
          try {
            await invoke('close_webcam_preview');
          } catch {
            // Ignore
          }
          useWebcamSettingsStore.setState({ previewOpen: false });
        }

        currentWindow.close().catch(
          createErrorHandler({ operation: 'close toolbar on reselecting', silent: true })
        );
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
              // Close webcam preview when recording ends
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
            // Close webcam preview on recording error
            closeWebcamPreview().catch(
              createErrorHandler({ operation: 'close webcam preview', silent: true })
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
      unlistenReselecting?.();
      unlistenState?.();
      unlistenFormat?.();
    };
  }, []);

  // Listen for webcam errors during recording
  useEffect(() => {
    let unlistenWebcamError: UnlistenFn | null = null;

    const setupWebcamErrorListener = async () => {
      unlistenWebcamError = await listen<WebcamErrorEvent>('webcam-error', (event) => {
        const { message, is_fatal } = event.payload;
        console.error('[WEBCAM ERROR]', message, 'Fatal:', is_fatal);

        // Show toast notification
        if (is_fatal) {
          toast.error('Webcam disconnected', {
            description: 'Webcam capture has stopped. Recording will continue without webcam.',
            duration: 5000,
          });
        } else {
          toast.warning('Webcam issue', {
            description: message,
            duration: 3000,
          });
        }
      });
    };

    setupWebcamErrorListener();
    return () => {
      unlistenWebcamError?.();
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
      // In startup mode, trigger capture based on source
      if (isStartupMode) {
        const currentWindow = getCurrentWebviewWindow();
        
        if (captureSource === 'display') {
          // Fullscreen capture - close toolbar and capture
          await currentWindow.hide();
          
          if (captureType === 'screenshot') {
            // Fast fullscreen screenshot
            const result = await invoke<{ file_path: string; width: number; height: number }>('capture_fullscreen_fast');
            await invoke('open_editor_fast', {
              filePath: result.file_path,
              width: result.width,
              height: result.height,
            });
            await currentWindow.close();
          } else {
            // Video/GIF recording - use overlay with fullscreen selection
            const ctStr = captureType === 'gif' ? 'gif' : 'video';
            await invoke('show_overlay', { captureType: ctStr });
            await currentWindow.close();
          }
        } else {
          // Area or Window - show overlay for region selection
          const ctStr = captureType === 'screenshot' ? 'screenshot' : captureType === 'gif' ? 'gif' : 'video';
          await currentWindow.hide();
          await invoke('show_overlay', { captureType: ctStr });
          await currentWindow.close();
        }
        return;
      }

      // In capture mode (with active selection), confirm the capture
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
        await invoke('set_recording_microphone_device', { index: settings.video.microphoneDeviceIndex });
        await invoke('set_recording_fps', { fps });
        await invoke('set_recording_include_cursor', { include: includeCursor });
        await invoke('set_recording_max_duration', { secs: maxDurationSecs ?? 0 });

        // Video uses quality percentage, GIF uses quality preset
        if (captureType === 'video') {
          await invoke('set_recording_quality', { quality: settings.video.quality });
        } else {
          await invoke('set_gif_quality_preset', { preset: settings.gif.qualityPreset });
        }

        // Sync webcam enabled state to Rust before recording
        await invoke('set_webcam_enabled', { enabled: webcamSettings.enabled });

        await invoke('capture_overlay_confirm', { action: 'recording' });
      }
    } catch (e) {
      console.error('Failed to capture:', e);
      recordingInitiatedRef.current = false;
      setMode('selection');
    }
  }, [captureType, captureSource, isStartupMode, settings, webcamSettings.enabled]);

  const handleRedo = useCallback(async () => {
    console.log('[Toolbar] handleRedo called');
    try {
      await invoke('capture_overlay_reselect');
      console.log('[Toolbar] capture_overlay_reselect invoked');
    } catch (e) {
      console.error('Failed to reselect:', e);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      // In startup mode, just close the toolbar window
      if (isStartupMode) {
        const currentWindow = getCurrentWebviewWindow();
        await currentWindow.close();
        return;
      }

      // In capture mode, close webcam preview and cancel overlay/recording
      await closeWebcamPreview();

      if (mode !== 'selection') {
        await invoke('cancel_recording');
      } else {
        await invoke('capture_overlay_cancel');
      }
    } catch (e) {
      console.error('Failed to cancel:', e);
    }
  }, [isStartupMode, mode, closeWebcamPreview]);

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

  const handleCaptureSourceChange = useCallback(async (source: CaptureSource) => {
    setCaptureSource(source);
    
    // In startup mode, clicking a source immediately triggers capture
    if (isStartupMode) {
      const currentWindow = getCurrentWebviewWindow();
      
      try {
        if (source === 'display') {
          // Fullscreen capture
          await currentWindow.hide();
          
          if (captureType === 'screenshot') {
            const result = await invoke<{ file_path: string; width: number; height: number }>('capture_fullscreen_fast');
            await invoke('open_editor_fast', {
              filePath: result.file_path,
              width: result.width,
              height: result.height,
            });
            await currentWindow.close();
          } else {
            // Video/GIF - trigger overlay for fullscreen (user can resize if needed)
            const ctStr = captureType === 'gif' ? 'gif' : 'video';
            await invoke('show_overlay', { captureType: ctStr });
            await currentWindow.close();
          }
        } else {
          // Area or Window - show overlay for region/window selection
          const ctStr = captureType === 'screenshot' ? 'screenshot' : captureType === 'gif' ? 'gif' : 'video';
          await currentWindow.hide();
          await invoke('show_overlay', { captureType: ctStr });
          await currentWindow.close();
        }
      } catch (e) {
        console.error('Failed to trigger capture:', e);
        await currentWindow.show();
      }
    }
  }, [isStartupMode, captureType]);

  const handleOpenSettings = useCallback(() => {
    useSettingsStore.getState().openSettingsModal();
  }, []);

  return (
    <>
      <div ref={toolbarRef} className="toolbar-container">
        {/* Wrapper - window resizes to fit content */}
        <div className="toolbar-animated-wrapper">
          {/* Content measurement ref - used to resize Tauri window */}
          <div ref={contentRef} className="toolbar-content-measure">
            <CaptureToolbar
              mode={mode}
              captureType={captureType}
              captureSource={captureSource}
              width={selectionBounds.width}
              height={selectionBounds.height}
              isStartupMode={isStartupMode}
              onCapture={handleCapture}
              onCaptureTypeChange={setCaptureType}
              onCaptureSourceChange={handleCaptureSourceChange}
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
              onOpenSettings={handleOpenSettings}
            />
          </div>
        </div>
      </div>
      {/* Toast notifications for webcam errors */}
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: 'rgba(0, 0, 0, 0.85)',
            color: '#fff',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
          },
        }}
      />
    </>
  );
};

export default CaptureToolbarWindow;
