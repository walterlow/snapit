/**
 * WebcamPreviewWindow - GPU-accelerated webcam preview.
 *
 * Uses wgpu to render camera frames directly to the window surface.
 * No JPEG encoding, no IPC polling - smooth 30fps GPU-rendered preview.
 *
 * NOTE: GPU initialization is now handled by Rust (Cap pattern).
 * This component just handles the UI overlay (dragging, recording indicator).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { WebcamSettings, WebcamSize } from '@/types/generated';
import { webcamLogger } from '@/utils/logger';

// Preview window size based on webcam size setting
const PREVIEW_SIZES: Record<WebcamSize, number> = {
  small: 120,
  medium: 160,
  large: 200,
};

const WebcamPreviewWindow: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [shape, setShape] = useState<'circle' | 'rectangle'>('circle');

  const mountedRef = useRef(true);

  // Load initial settings to get shape
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await invoke<WebcamSettings>('get_webcam_settings_cmd');
        setShape(settings.shape);
      } catch (e) {
        webcamLogger.error('Failed to load settings:', e);
      }
    };
    loadSettings();
  }, []);

  // Listen for settings changes from the toolbar
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', async (event) => {
      webcamLogger.debug('Settings changed:', event.payload);
      setShape(event.payload.shape);

      // Update GPU preview settings
      try {
        await invoke('update_gpu_webcam_preview_settings', {
          size: event.payload.size,
          shape: event.payload.shape,
          mirror: event.payload.mirror,
        });
      } catch (e) {
        webcamLogger.warn('Failed to update GPU preview settings:', e);
      }

      // Resize window
      try {
        const win = getCurrentWindow();
        const newSize = PREVIEW_SIZES[event.payload.size];
        await win.setSize(new LogicalSize(newSize, newSize));
      } catch (e) {
        webcamLogger.error('Failed to resize window:', e);
      }
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Listen for recording state changes (for visual indicator only)
  useEffect(() => {
    const unlistenStart = listen('recording-state-changed', (event) => {
      const state = event.payload as { type: string };
      if (state.type === 'Recording') {
        setIsRecording(true);
      } else if (state.type === 'Idle' || state.type === 'Completed' || state.type === 'Error') {
        setIsRecording(false);
      }
    });

    return () => {
      unlistenStart.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Listen for close event
  useEffect(() => {
    const unlisten = listen('webcam-preview-close', async () => {
      webcamLogger.debug('Received close event');
      try {
        const win = getCurrentWindow();
        await win.close();
      } catch (e) {
        webcamLogger.error('Error closing window:', e);
      }
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Enable window dragging
  const handleMouseDown = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch {
      // Ignore errors
    }
  }, []);

  // The GPU renders directly to the window surface, so we only need:
  // 1. A transparent container for dragging
  // 2. An error overlay if something fails
  // 3. A recording indicator border
  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: '100%',
        height: '100%',
        cursor: 'grab',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Recording indicator border
        boxSizing: 'border-box',
        border: isRecording ? '3px solid #ef4444' : 'none',
        borderRadius: shape === 'circle' ? '50%' : '12px',
      }}
    >
      {error && (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'rgba(0, 0, 0, 0.9)',
            color: '#ff6b6b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            padding: '8px',
            textAlign: 'center',
            borderRadius: shape === 'circle' ? '50%' : '12px',
          }}
        >
          {error}
        </div>
      )}
      {/* GPU renders webcam directly to window surface - no <img> needed */}
    </div>
  );
};

export default WebcamPreviewWindow;
