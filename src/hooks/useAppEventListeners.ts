/**
 * Consolidated event listeners for App.tsx
 *
 * Groups multiple Tauri event listeners into a single hook to:
 * - Reduce the number of useEffect hooks in App.tsx
 * - Ensure consistent cleanup patterns
 * - Centralize event handling logic
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import { useSettingsStore } from '../stores/settingsStore';

interface AppEventCallbacks {
  /** Called when a recording completes - should refresh the library */
  onRecordingComplete: () => void;
  /** Called when a fast capture completes (file path) */
  onCaptureCompleteFast: (data: {
    file_path: string;
    width: number;
    height: number;
  }) => Promise<void>;
}

/**
 * Hook that sets up all Tauri event listeners for the main App.
 *
 * Consolidates these listeners:
 * - recording-state-changed: Refresh library on recording complete
 * - open-settings: Open settings modal from tray
 * - create-capture-toolbar: Create selection toolbar window
 * - capture-complete-fast: Handle screenshot capture (raw RGBA file path)
 */
export function useAppEventListeners(callbacks: AppEventCallbacks) {
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];

    // Recording state changes - refresh library when complete
    unlisteners.push(
      listen<{ status: string }>('recording-state-changed', (event) => {
        if (event.payload.status === 'completed') {
          console.log('[App] Recording completed, refreshing library...');
          // Delay to ensure file is fully written
          const t1 = setTimeout(() => {
            callbacks.onRecordingComplete();
            // Refresh again after thumbnails might be generated
            const t2 = setTimeout(() => callbacks.onRecordingComplete(), 2000);
            timeoutIds.push(t2);
          }, 500);
          timeoutIds.push(t1);
        }
      })
    );

    // Open settings from tray menu
    unlisteners.push(
      listen('open-settings', () => {
        useSettingsStore.getState().openSettingsModal();
      })
    );

    // Create capture toolbar window from D2D overlay
    unlisteners.push(
      listen<{ x: number; y: number; width: number; height: number }>(
        'create-capture-toolbar',
        async (event) => {
          const { x, y, width, height } = event.payload;

          // Close any existing toolbar window first
          const existing = await WebviewWindow.getByLabel('capture-toolbar');
          if (existing) {
            try {
              await existing.close();
            } catch {
              // Ignore
            }
            await new Promise((r) => setTimeout(r, 50));
          }

          // Create toolbar window - starts hidden, frontend will position and show
          const url = `/capture-toolbar.html?x=${x}&y=${y}&width=${width}&height=${height}`;
          const win = new WebviewWindow('capture-toolbar', {
            url,
            title: 'Selection Toolbar',
            width: 900,
            height: 300,
            x: x + Math.floor(width / 2) - 450,
            y: y + height + 8,
            resizable: false,
            decorations: false,
            alwaysOnTop: true,
            transparent: true,
            skipTaskbar: true,
            shadow: false,
            visible: false,
            focus: false,
          });

          win.once('tauri://error', (e) => {
            console.error('Failed to create capture toolbar:', e);
          });
        }
      )
    );

    // Fast capture complete (file path)
    unlisteners.push(
      listen<{ file_path: string; width: number; height: number }>(
        'capture-complete-fast',
        async (event) => {
          // Show toast immediately - don't wait for save to complete
          toast.success('Screenshot captured');
          try {
            await callbacks.onCaptureCompleteFast(event.payload);
          } catch {
            // Silently fail - the capture is already displayed
          }
        }
      )
    );

    // Cleanup function
    return () => {
      timeoutIds.forEach(clearTimeout);
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [callbacks]);
}
