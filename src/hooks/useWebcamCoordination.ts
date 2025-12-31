/**
 * useWebcamCoordination - Manages webcam preview window lifecycle.
 *
 * Handles:
 * - Loading webcam settings from Rust on mount
 * - Opening/closing webcam preview window
 * - Listening for webcam errors during recording
 */

import { useEffect, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useWebcamSettingsStore } from '../stores/webcamSettingsStore';

interface WebcamErrorEvent {
  message: string;
  is_fatal: boolean;
}

interface UseWebcamCoordinationReturn {
  /** Close the webcam preview window */
  closeWebcamPreview: () => Promise<void>;
}

export function useWebcamCoordination(): UseWebcamCoordinationReturn {
  const { closePreview } = useWebcamSettingsStore();

  // Load webcam settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      const { loadSettings } = useWebcamSettingsStore.getState();
      await loadSettings();
    };
    loadSettings();
  }, []);

  // Listen for webcam errors during recording
  useEffect(() => {
    let unlistenWebcamError: UnlistenFn | null = null;

    const setupWebcamErrorListener = async () => {
      unlistenWebcamError = await listen<WebcamErrorEvent>('webcam-error', (event) => {
        const { message, is_fatal } = event.payload;
        console.error('[WEBCAM ERROR]', message, 'Fatal:', is_fatal);

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

  const closeWebcamPreview = useCallback(async () => {
    await closePreview();
  }, [closePreview]);

  return {
    closeWebcamPreview,
  };
}
