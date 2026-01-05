/**
 * WebcamPreviewWindow - Native webcam preview using Rust capture service.
 *
 * Uses native webcam capture via nokhwa (Rust) for consistent timing with recording.
 * Polls for JPEG frames from Rust and displays them in an <img> element.
 * Recording is handled entirely in Rust (WebcamEncoder) - no browser MediaRecorder.
 * The window is excluded from screen capture (SetWindowDisplayAffinity).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { WebcamSettings, WebcamSize, WebcamShape } from '@/types/generated';
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

// Frame polling interval (ms) - ~30fps
const FRAME_POLL_INTERVAL = 33;

// JPEG quality for preview (0-100)
const PREVIEW_QUALITY = 75;

const WebcamPreviewWindow: React.FC = () => {
  const [frameData, setFrameData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [settings, setSettings] = useState<WebcamSettings>(DEFAULT_SETTINGS);
  
  const frameIntervalRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const captureStartedRef = useRef(false);
  const currentDeviceRef = useRef<number | null>(null);

  // Listen for settings changes from the toolbar
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', (event) => {
      webcamLogger.debug('Settings changed:', event.payload);
      setSettings(event.payload);
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

  // Poll for frames from native capture service
  const pollFrame = useCallback(async () => {
    if (!mountedRef.current) return;

    try {
      const frame = await invoke<string | null>('get_webcam_preview_frame', {
        quality: PREVIEW_QUALITY,
      });

      if (frame && mountedRef.current) {
        setFrameData(`data:image/jpeg;base64,${frame}`);
        setError(null);
      }
    } catch (e) {
      // Only log errors occasionally to avoid spam
      webcamLogger.debug('Frame poll error:', e);
    }
  }, []);

  // Start frame polling (separate from capture start to avoid re-polling issues)
  const startPolling = useCallback(() => {
    if (frameIntervalRef.current) return; // Already polling
    frameIntervalRef.current = window.setInterval(pollFrame, FRAME_POLL_INTERVAL);
    webcamLogger.debug('Frame polling started');
  }, [pollFrame]);

  const stopPolling = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
      webcamLogger.debug('Frame polling stopped');
    }
  }, []);

  // Start native webcam capture service (only once on mount, or when device changes)
  useEffect(() => {
    mountedRef.current = true;
    
    const startCapture = async () => {
      const deviceIndex = settings.deviceIndex;
      
      // Skip if already started with this device
      if (captureStartedRef.current && currentDeviceRef.current === deviceIndex) {
        webcamLogger.debug('Capture already running for device', deviceIndex);
        return;
      }
      
      try {
        webcamLogger.debug('Starting native capture, device:', deviceIndex);
        await invoke('start_webcam_preview', { deviceIndex });
        captureStartedRef.current = true;
        currentDeviceRef.current = deviceIndex;
        webcamLogger.debug('Native capture started');

        // Start polling for frames
        startPolling();

        // Exclude window from screen capture
        try {
          await invoke('exclude_webcam_from_capture');
          webcamLogger.debug('Window excluded from capture');
        } catch (e) {
          webcamLogger.warn('Failed to exclude from capture:', e);
        }
      } catch (e) {
        webcamLogger.error('Failed to start native capture:', e);
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : 'Failed to access webcam');
        }
      }
    };

    startCapture();

    // Cleanup only stops polling, NOT the capture service
    // Capture service is stopped by closePreview in the store
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [settings.deviceIndex, startPolling, stopPolling]);

  // Stop capture when window is closed (called from close event)
  const stopCapture = useCallback(async () => {
    stopPolling();
    if (captureStartedRef.current) {
      try {
        await invoke('stop_webcam_preview');
        captureStartedRef.current = false;
        currentDeviceRef.current = null;
        webcamLogger.debug('Native capture stopped');
      } catch (e) {
        webcamLogger.error('Failed to stop capture:', e);
      }
    }
  }, [stopPolling]);

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
      await stopCapture();
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
  }, [stopCapture]);

  // Enable window dragging
  const handleMouseDown = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch {
      // Ignore errors
    }
  }, []);

  // Get shape styles
  const getShapeStyles = (shape: WebcamShape): React.CSSProperties => {
    const baseStyles: React.CSSProperties = {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      transform: settings.mirror ? 'scaleX(-1)' : undefined,
    };

    if (shape === 'circle') {
      return {
        ...baseStyles,
        borderRadius: '50%',
      };
    }

    return {
      ...baseStyles,
      borderRadius: '12px',
    };
  };

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
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: settings.shape === 'circle' ? '50%' : '12px',
          overflow: 'hidden',
          background: 'rgba(0, 0, 0, 0.8)',
          border: isRecording
            ? '3px solid #ef4444'
            : '2px solid rgba(255, 255, 255, 0.2)',
        }}
      >
        {error ? (
          <div
            style={{
              width: '100%',
              height: '100%',
              background: 'rgba(0, 0, 0, 0.8)',
              color: '#ff6b6b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              padding: '8px',
              textAlign: 'center',
            }}
          >
            {error}
          </div>
        ) : frameData ? (
          <img
            src={frameData}
            alt="Webcam preview"
            style={getShapeStyles(settings.shape)}
            draggable={false}
          />
        ) : (
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
            }}
          >
            Loading...
          </div>
        )}
      </div>
    </div>
  );
};

export default WebcamPreviewWindow;
