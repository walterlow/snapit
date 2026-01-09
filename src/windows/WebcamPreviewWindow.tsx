/**
 * WebcamPreviewWindow - GPU-accelerated webcam preview.
 *
 * Uses wgpu to render camera frames directly to the window surface.
 * No JPEG encoding, no IPC polling - smooth 30fps GPU-rendered preview.
 * The window content is transparent; GPU draws the webcam feed with shape masking.
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

// Default settings for preview window
const DEFAULT_SETTINGS: WebcamSettings = {
  enabled: true,
  deviceIndex: 0,
  position: { type: 'bottomRight' },
  size: 'medium',
  shape: 'circle',
  mirror: false,
};

const WebcamPreviewWindow: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [settings, setSettings] = useState<WebcamSettings>(DEFAULT_SETTINGS);
  const [gpuReady, setGpuReady] = useState(false);
  
  const mountedRef = useRef(true);
  const gpuStartedRef = useRef(false);
  const currentDeviceRef = useRef<number | null>(null);

  // Listen for settings changes from the toolbar
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', async (event) => {
      webcamLogger.debug('Settings changed:', event.payload);
      setSettings(event.payload);
      
      // Update GPU preview settings if running
      if (gpuStartedRef.current) {
        try {
          await invoke('update_gpu_webcam_preview_settings', {
            size: event.payload.size,
            shape: event.payload.shape,
            mirror: event.payload.mirror,
          });
        } catch (e) {
          webcamLogger.warn('Failed to update GPU preview settings:', e);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Resize window when size setting changes
  useEffect(() => {
    const resizeWindow = async () => {
      try {
        const win = getCurrentWindow();
        const newSize = PREVIEW_SIZES[settings.size];
        await win.setSize(new LogicalSize(newSize, newSize));
      } catch (e) {
        webcamLogger.error('Failed to resize window:', e);
      }
    };

    resizeWindow();
  }, [settings.size]);

  // Start GPU webcam preview
  useEffect(() => {
    mountedRef.current = true;
    
    const startGpuPreview = async () => {
      const deviceIndex = settings.deviceIndex;
      
      // Skip if already started with this device
      if (gpuStartedRef.current && currentDeviceRef.current === deviceIndex) {
        webcamLogger.debug('GPU preview already running for device', deviceIndex);
        return;
      }
      
      try {
        webcamLogger.debug('Starting GPU webcam preview, device:', deviceIndex);
        
        await invoke('start_gpu_webcam_preview', {
          deviceIndex,
          size: settings.size,
          shape: settings.shape,
          mirror: settings.mirror,
        });
        
        gpuStartedRef.current = true;
        currentDeviceRef.current = deviceIndex;
        setGpuReady(true);
        setError(null);
        webcamLogger.debug('GPU webcam preview started');

        // Exclude window from screen capture
        try {
          await invoke('exclude_webcam_from_capture');
          webcamLogger.debug('Window excluded from capture');
        } catch (e) {
          webcamLogger.warn('Failed to exclude from capture:', e);
        }
      } catch (e) {
        webcamLogger.error('Failed to start GPU webcam preview:', e);
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    startGpuPreview();

    return () => {
      mountedRef.current = false;
    };
  }, [settings.deviceIndex, settings.size, settings.shape, settings.mirror]);

  // Stop GPU preview when window is closed
  const stopGpuPreview = useCallback(async () => {
    if (gpuStartedRef.current) {
      try {
        await invoke('stop_gpu_webcam_preview');
        gpuStartedRef.current = false;
        currentDeviceRef.current = null;
        setGpuReady(false);
        webcamLogger.debug('GPU webcam preview stopped');
      } catch (e) {
        webcamLogger.error('Failed to stop GPU preview:', e);
      }
    }
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

  // Listen for close event from main window
  useEffect(() => {
    const unlisten = listen('webcam-preview-close', async () => {
      webcamLogger.debug('Received close event');
      await stopGpuPreview();
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
  }, [stopGpuPreview]);

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
  // 2. An error overlay if GPU init failed
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
        borderRadius: settings.shape === 'circle' ? '50%' : '12px',
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
            borderRadius: settings.shape === 'circle' ? '50%' : '12px',
          }}
        >
          {error}
        </div>
      )}
      {!error && !gpuReady && (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'rgba(0, 0, 0, 0.8)',
            color: '#888',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            borderRadius: settings.shape === 'circle' ? '50%' : '12px',
          }}
        >
          Loading...
        </div>
      )}
      {/* GPU renders webcam directly to window surface - no <img> needed */}
    </div>
  );
};

export default WebcamPreviewWindow;
