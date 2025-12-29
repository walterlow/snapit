/**
 * App Initialization Hook
 *
 * Consolidates startup effects from App.tsx:
 * - Load captures on mount
 * - Run startup cleanup (orphan files, missing thumbnails)
 * - Initialize settings and register global shortcuts
 * - Sync recording state on window focus
 *
 * Extracted to reduce App.tsx complexity while maintaining identical behavior.
 */

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCaptureStore } from '../stores/captureStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useVideoRecordingStore } from '../stores/videoRecordingStore';
import { registerAllShortcuts, setShortcutHandler } from '../utils/hotkeyManager';
import { createErrorHandler } from '../utils/errorReporting';

interface UseAppInitializationProps {
  /** Handler for new capture shortcut */
  triggerNewCapture: () => Promise<void>;
  /** Handler for fullscreen capture shortcut */
  triggerFullscreenCapture: () => Promise<void>;
  /** Handler for all monitors capture shortcut */
  triggerAllMonitorsCapture: () => Promise<void>;
}

/**
 * Hook that handles all app initialization effects.
 * Must be called once at the app root level.
 */
export function useAppInitialization({
  triggerNewCapture,
  triggerFullscreenCapture,
  triggerAllMonitorsCapture,
}: UseAppInitializationProps) {
  const { loadCaptures } = useCaptureStore();

  // Load captures on mount
  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Run startup cleanup (orphan temp files, missing thumbnails)
  useEffect(() => {
    invoke('startup_cleanup').catch(
      createErrorHandler({ operation: 'startup cleanup', silent: true })
    );
  }, []);

  // Initialize settings and register shortcuts (non-blocking)
  useEffect(() => {
    // Set up shortcut handlers IMMEDIATELY (synchronous, no blocking)
    setShortcutHandler('new_capture', triggerNewCapture);
    setShortcutHandler('fullscreen_capture', triggerFullscreenCapture);
    setShortcutHandler('all_monitors_capture', triggerAllMonitorsCapture);

    // Defer heavy initialization to after first paint for responsive UI
    const initSettings = async () => {
      try {
        const { loadSettings } = useSettingsStore.getState();
        await loadSettings();

        // Run backend sync and shortcut registration in parallel
        const updatedSettings = useSettingsStore.getState().settings;
        await Promise.allSettled([
          invoke('set_close_to_tray', { enabled: updatedSettings.general.minimizeToTray }),
          registerAllShortcuts(),
        ]);
      } catch (error) {
        console.error('Failed to initialize settings:', error);
      }
    };

    // Use requestIdleCallback if available, otherwise setTimeout
    // This ensures UI renders first before heavy init work
    if ('requestIdleCallback' in window) {
      (window as typeof window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => initSettings());
    } else {
      setTimeout(initSettings, 0);
    }
  }, [triggerNewCapture, triggerFullscreenCapture, triggerAllMonitorsCapture]);

  // Sync recording state with backend on window focus
  // This handles edge cases where frontend/backend state may drift
  useEffect(() => {
    const handleFocus = () => {
      useVideoRecordingStore.getState().refreshStatus();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);
}
