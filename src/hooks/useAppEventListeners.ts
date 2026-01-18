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
import { libraryLogger } from '../utils/logger';

interface ThumbnailReadyEvent {
  captureId: string;
  thumbnailPath: string;
}

interface AppEventCallbacks {
  /** Called when a recording completes - should refresh the library */
  onRecordingComplete: () => void;
  /** Called when a thumbnail is generated for a capture */
  onThumbnailReady: (captureId: string, thumbnailPath: string) => void;
  /** Called when a fast capture completes (file path) */
  onCaptureCompleteFast: (data: {
    file_path: string;
    width: number;
    height: number;
  }) => Promise<void>;
  /** Called when a capture is deleted from editor window - refresh library */
  onCaptureDeleted: () => void;
}

/**
 * Hook that sets up all Tauri event listeners for the main App.
 *
 * Consolidates these listeners:
 * - recording-state-changed: Refresh library on recording complete
 * - thumbnail-ready: Update specific capture's thumbnail when generated
 * - open-settings: Open settings modal from tray
 * - create-capture-toolbar: Create selection toolbar window
 * - capture-complete-fast: Handle screenshot capture (raw RGBA file path)
 * - capture-deleted: Refresh library when capture is deleted from editor
 */
export function useAppEventListeners(callbacks: AppEventCallbacks) {
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];

    // Recording state changes - refresh library when complete
    unlisteners.push(
      listen<{ status: string }>('recording-state-changed', (event) => {
        if (event.payload.status === 'completed') {
          libraryLogger.info('Recording completed, refreshing library...');
          // Small delay to ensure file is fully written
          const t1 = setTimeout(() => {
            callbacks.onRecordingComplete();
          }, 500);
          timeoutIds.push(t1);
        }
      })
    );

    // Thumbnail ready - update specific capture's thumbnail
    unlisteners.push(
      listen<ThumbnailReadyEvent>('thumbnail-ready', (event) => {
        const { captureId, thumbnailPath } = event.payload;
        libraryLogger.info(`Thumbnail ready for ${captureId}`);
        callbacks.onThumbnailReady(captureId, thumbnailPath);
      })
    );

    // Open settings from tray menu
    unlisteners.push(
      listen('open-settings', () => {
        useSettingsStore.getState().openSettingsModal();
      })
    );

    // Update capture toolbar bounds from D2D overlay
    // If toolbar exists, confirm selection and update; if not, let Rust create it
    unlisteners.push(
      listen<{
        x: number;
        y: number;
        width: number;
        height: number;
        sourceType?: 'area' | 'window' | 'display';
        windowId?: number | null;
        sourceTitle?: string | null;
        monitorIndex?: number | null;
        monitorName?: string | null;
      }>(
        'create-capture-toolbar',
        async (event) => {
          const { x, y, width, height, sourceType, windowId, sourceTitle, monitorIndex, monitorName } = event.payload;

          // Check if toolbar already exists
          const existing = await WebviewWindow.getByLabel('capture-toolbar');
          if (existing) {
            // Toolbar exists - emit confirm-selection to mark selection confirmed and reposition
            // This is a NEW selection from overlay, not an adjustment update
            // Pass through all metadata for proper recording mode
            await existing.emit('confirm-selection', {
              x, y, width, height,
              sourceType,
              windowId,
              sourceTitle,
              monitorIndex,
              monitorName
            });
            // Bring to front
            await existing.show();
            await existing.setFocus();
            return;
          }

          // Toolbar doesn't exist - create it via Rust command
          // This ensures consistent window creation
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_capture_toolbar', { x, y, width, height });
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

    // Capture deleted from editor window - refresh library
    unlisteners.push(
      listen<{ projectId: string }>('capture-deleted', () => {
        libraryLogger.info('Capture deleted from editor, refreshing library...');
        callbacks.onCaptureDeleted();
      })
    );

    // Cleanup function
    return () => {
      timeoutIds.forEach(clearTimeout);
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [callbacks]);
}
