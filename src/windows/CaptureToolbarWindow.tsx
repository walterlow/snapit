/**
 * CaptureToolbarWindow - Unified toolbar for screen capture.
 *
 * Architecture:
 * - Frontend creates window via App.tsx listener
 * - Frontend measures content, calculates position (with multi-monitor support)
 * - Frontend calls Rust to set bounds and show window
 *
 * Hooks handle the complexity:
 * - useToolbarPositioning: Window sizing and multi-monitor placement
 * - useRecordingEvents: Recording state machine
 * - useSelectionEvents: Selection bounds updates
 * - useWebcamCoordination: Webcam preview lifecycle
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Toaster } from 'sonner';
import { Titlebar } from '../components/Titlebar/Titlebar';
import { CaptureToolbar } from '../components/CaptureToolbar/CaptureToolbar';
import type { CaptureSource } from '../components/CaptureToolbar/SourceSelector';
import { useCaptureSettingsStore } from '../stores/captureSettingsStore';
import { useWebcamSettingsStore } from '../stores/webcamSettingsStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTheme } from '../hooks/useTheme';
import { useRecordingEvents } from '../hooks/useRecordingEvents';
import { useSelectionEvents } from '../hooks/useSelectionEvents';
import { useWebcamCoordination } from '../hooks/useWebcamCoordination';
import { useToolbarPositioning } from '../hooks/useToolbarPositioning';

const CaptureToolbarWindow: React.FC = () => {
  // No URL params - toolbar always starts in "startup" state (no selection)
  // Bounds come from events: confirm-selection, selection-updated, reset-to-startup

  // Apply theme
  useTheme();

  // Refs for layout
  const toolbarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Capture settings
  const {
    settings,
    activeMode: captureType,
    isInitialized,
    loadSettings,
    setActiveMode: setCaptureType,
  } = useCaptureSettingsStore();

  // Webcam settings
  const { settings: webcamSettings } = useWebcamSettingsStore();

  // UI state
  const [captureSource, setCaptureSource] = useState<CaptureSource>('area');

  // Load settings on mount
  useEffect(() => {
    if (!isInitialized) {
      loadSettings();
    }
  }, [isInitialized, loadSettings]);

  // --- Hooks for window management ---

  // Webcam coordination (errors, preview lifecycle)
  const { closeWebcamPreview } = useWebcamCoordination();

  // Recording state machine
  const {
    mode,
    setMode,
    format,
    elapsedTime,
    progress,
    errorMessage,
    countdownSeconds,
    recordingInitiatedRef,
  } = useRecordingEvents();

  // Selection bounds tracking
  const {
    selectionBounds,
    selectionBoundsRef,
    selectionConfirmed,
  } = useSelectionEvents();

  // Measure content and resize window to fit
  useToolbarPositioning({ contentRef });

  // --- Event handlers ---

  // Close popovers when window loses focus
  useEffect(() => {
    const handleBlur = () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // ESC key handler - use ref to prevent key repeat from closing after reset
  const escHandledRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode === 'selection' && !e.repeat) {
        e.preventDefault();

        // Prevent key repeat from triggering close after reset
        if (escHandledRef.current) return;

        await closeWebcamPreview();

        if (selectionConfirmed) {
          // Has active selection - reset to startup state
          escHandledRef.current = true;
          try {
            await invoke('capture_overlay_cancel');
          } catch {
            // Overlay may already be closed - that's fine
          }
          await emit('reset-to-startup', null);
          // Allow ESC again after a short delay
          setTimeout(() => { escHandledRef.current = false; }, 200);
        } else {
          // No selection (startup mode) - close the toolbar
          const currentWindow = getCurrentWebviewWindow();
          await currentWindow.close();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, selectionConfirmed, closeWebcamPreview]);

  // --- Action handlers ---

  const handleCapture = useCallback(async () => {
    try {
      // No selection confirmed - trigger overlay first
      if (!selectionConfirmed) {
        const currentWindow = getCurrentWebviewWindow();

        if (captureSource === 'display') {
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
            const ctStr = captureType === 'gif' ? 'gif' : 'video';
            await invoke('show_overlay', { captureType: ctStr });
            // Toolbar stays hidden, overlay will show it when selection is made
          }
        } else {
          const ctStr = captureType === 'screenshot' ? 'screenshot' : captureType === 'gif' ? 'gif' : 'video';
          await currentWindow.hide();
          await invoke('show_overlay', { captureType: ctStr });
          // Toolbar stays hidden, overlay will show it when selection is made
        }
        return;
      }

      // Capture mode with active selection
      if (captureType === 'screenshot') {
        await invoke('capture_overlay_confirm', { action: 'screenshot' });
      } else {
        // Video or GIF recording
        recordingInitiatedRef.current = true;
        setMode('starting');

        const countdownSecs = captureType === 'video' ? settings.video.countdownSecs : settings.gif.countdownSecs;
        const systemAudioEnabled = captureType === 'video' ? settings.video.captureSystemAudio : false;
        const fps = captureType === 'video' ? settings.video.fps : settings.gif.fps;
        const quality = captureType === 'video' ? settings.video.quality : 80;
        const gifQualityPreset = settings.gif.qualityPreset;
        const includeCursor = captureType === 'video' ? settings.video.includeCursor : settings.gif.includeCursor;
        const maxDurationSecs = captureType === 'video' ? settings.video.maxDurationSecs : settings.gif.maxDurationSecs;
        const microphoneDeviceIndex = settings.video.microphoneDeviceIndex;

        if (captureType === 'video') {
          await invoke('set_hide_desktop_icons', { enabled: settings.video.hideDesktopIcons });
          await invoke('set_webcam_enabled', { enabled: webcamSettings.enabled });
        } else {
          // GIF mode: no webcam support
          await invoke('set_webcam_enabled', { enabled: false });
        }

        const overlayReadyPromise = new Promise<void>((resolve) => {
          const timeoutId = setTimeout(resolve, 500);
          import('@tauri-apps/api/event').then(({ listen }) => {
            listen('overlay-ready-for-recording', () => {
              clearTimeout(timeoutId);
              resolve();
            });
          });
        });

        await invoke('capture_overlay_confirm', { action: 'recording' });
        await overlayReadyPromise;

        const bounds = selectionBoundsRef.current;

        await invoke('show_recording_border', {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });

        const formatStr = captureType === 'gif' ? 'gif' : 'mp4';
        await emit('recording-format', formatStr);

        if (countdownSecs > 0) {
          await invoke('show_countdown_window', {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          });
        }

        const recordingSettings = {
          format: captureType === 'gif' ? 'gif' : 'mp4',
          mode: {
            type: 'region' as const,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
          fps,
          maxDurationSecs: maxDurationSecs ?? null,
          includeCursor,
          audio: {
            captureSystemAudio: systemAudioEnabled,
            microphoneDeviceIndex: microphoneDeviceIndex ?? null,
          },
          quality,
          gifQualityPreset,
          countdownSecs,
        };

        await invoke('start_recording', { settings: recordingSettings });
      }
    } catch (e) {
      console.error('Failed to capture:', e);
      recordingInitiatedRef.current = false;
      setMode('selection');
    }
  }, [captureType, captureSource, selectionConfirmed, settings, webcamSettings.enabled, selectionBoundsRef, recordingInitiatedRef, setMode]);

  const handleRedo = useCallback(async () => {
    try {
      await invoke('capture_overlay_reselect');
    } catch (e) {
      console.error('Failed to reselect:', e);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      await closeWebcamPreview();

      if (mode !== 'selection') {
        // During recording - cancel the recording
        await invoke('cancel_recording');
      } else if (selectionConfirmed) {
        // Has active selection - try to cancel overlay (may already be closed)
        try {
          await invoke('capture_overlay_cancel');
        } catch {
          // Overlay may already be closed - that's fine
        }
        // Emit reset event directly since overlay may not be running
        await emit('reset-to-startup', null);
      } else {
        // No selection (startup mode) - close the toolbar
        const currentWindow = getCurrentWebviewWindow();
        await currentWindow.close();
      }
    } catch (e) {
      console.error('Failed to cancel:', e);
    }
  }, [mode, selectionConfirmed, closeWebcamPreview]);

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

    // Trigger overlay when no selection is confirmed (startup state)
    if (!selectionConfirmed) {
      const currentWindow = getCurrentWebviewWindow();

      try {
        if (source === 'display') {
          await currentWindow.hide();

          if (captureType === 'screenshot') {
            const result = await invoke<{ file_path: string; width: number; height: number }>('capture_fullscreen_fast');
            await invoke('open_editor_fast', {
              filePath: result.file_path,
              width: result.width,
              height: result.height,
            });
            // Close toolbar after screenshot complete
            await currentWindow.close();
          } else {
            const ctStr = captureType === 'gif' ? 'gif' : 'video';
            await invoke('show_overlay', { captureType: ctStr });
            // Toolbar stays hidden, overlay will show it when selection is made
          }
        } else {
          const ctStr = captureType === 'screenshot' ? 'screenshot' : captureType === 'gif' ? 'gif' : 'video';
          await currentWindow.hide();
          await invoke('show_overlay', { captureType: ctStr });
          // Toolbar stays hidden, overlay will show it when selection is made
        }
      } catch (e) {
        console.error('Failed to trigger capture:', e);
        await currentWindow.show();
      }
    }
  }, [selectionConfirmed, captureType]);

  const handleOpenSettings = useCallback(() => {
    useSettingsStore.getState().openSettingsModal();
  }, []);

  const handleCaptureComplete = useCallback(async () => {
    const currentWindow = getCurrentWebviewWindow();
    await currentWindow.close();
  }, []);

  const handleModeChange = useCallback((newMode: typeof captureType) => {
    if (mode === 'selection') {
      setCaptureType(newMode);
    }
  }, [mode, setCaptureType]);

  const handleTitlebarClose = useCallback(async () => {
    // Cancel overlay when toolbar is closed
    try {
      await invoke('capture_overlay_cancel');
    } catch {
      // Overlay may not be running
    }
    await closeWebcamPreview();
  }, [closeWebcamPreview]);

  // --- Render ---

  return (
    <div className="app-container">
      <Titlebar title="SnapIt Capture" showLogo={false} showMaximize={false} onClose={handleTitlebarClose} />
      <div ref={toolbarRef} className="toolbar-container">
        <div className="toolbar-animated-wrapper">
          <div ref={contentRef} className="toolbar-content-measure">
            <CaptureToolbar
              mode={mode}
              captureType={captureType}
              width={selectionBounds.width}
              height={selectionBounds.height}
              selectionConfirmed={selectionConfirmed}
              onCapture={handleCapture}
              onCaptureTypeChange={handleModeChange}
              onCaptureSourceChange={handleCaptureSourceChange}
              onCaptureComplete={handleCaptureComplete}
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
    </div>
  );
};

export default CaptureToolbarWindow;
