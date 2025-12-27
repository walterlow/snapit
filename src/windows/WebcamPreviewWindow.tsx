/**
 * WebcamPreviewWindow - Draggable webcam preview for positioning overlay.
 *
 * Uses browser's getUserMedia for live preview. The window can be dragged
 * to set the webcam position for recordings.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import type { WebcamSettings, WebcamShape, WebcamSize } from '@/types/generated';

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
  mirror: true,
};

interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WebcamPreviewWindow: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [settings, setSettings] = useState<WebcamSettings>(DEFAULT_SETTINGS);
  const selectionBoundsRef = useRef<SelectionBounds | null>(null);

  // Listen for settings changes from the toolbar
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', (event) => {
      console.log('[WebcamPreview] Settings changed:', event.payload);
      setSettings(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for selection bounds updates (for clamping)
  useEffect(() => {
    const unlisten = listen<SelectionBounds>('selection-updated', (event) => {
      selectionBoundsRef.current = event.payload;
    });

    return () => {
      unlisten.then((fn) => fn());
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
        console.error('[WebcamPreview] Failed to resize window:', e);
      }
    };

    resizeWindow();
  }, [settings.size]);

  // Get the device ID for the selected webcam
  const getDeviceId = useCallback(async () => {
    const deviceList = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = deviceList.filter((d) => d.kind === 'videoinput');
    return videoDevices[settings.deviceIndex]?.deviceId;
  }, [settings.deviceIndex]);

  // Start webcam stream
  useEffect(() => {
    let mounted = true;

    const startStream = async () => {
      try {
        // Stop existing stream
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }

        const deviceId = await getDeviceId();
        const constraints: MediaStreamConstraints = {
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: 320, height: 240 }
            : { width: 320, height: 240 },
          audio: false,
        };

        const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (mounted) {
          setStream(mediaStream);
          setError(null);
          if (videoRef.current) {
            videoRef.current.srcObject = mediaStream;
          }
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to access webcam');
        }
      }
    };

    startStream();

    return () => {
      mounted = false;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [settings.deviceIndex]);

  // Bring window to front (above D2D overlay)
  const bringToFront = useCallback(async () => {
    try {
      await invoke('bring_webcam_preview_to_front');
    } catch {
      // Ignore errors
    }
  }, []);

  // Handle mouse enter - bring to front
  const handleMouseEnter = useCallback(() => {
    bringToFront();
  }, [bringToFront]);

  // Custom drag handling with clamping
  const dragStateRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startWinX: number;
    startWinY: number;
  } | null>(null);

  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click

    // Bring to front before starting drag
    await bringToFront();

    try {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();

      // Store initial positions
      dragStateRef.current = {
        startMouseX: e.screenX,
        startMouseY: e.screenY,
        startWinX: pos.x,
        startWinY: pos.y,
      };

      setIsDragging(true);
    } catch {
      // Ignore errors
    }
  }, [bringToFront]);

  // Global mouse move/up handlers for custom drag
  useEffect(() => {
    const webcamSize = PREVIEW_SIZES[settings.size];
    const padding = 16;

    const handleMouseMove = async (e: MouseEvent) => {
      if (!dragStateRef.current) return;

      const bounds = selectionBoundsRef.current;
      const { startMouseX, startMouseY, startWinX, startWinY } = dragStateRef.current;

      // Calculate new position based on mouse delta
      const deltaX = e.screenX - startMouseX;
      const deltaY = e.screenY - startMouseY;
      let newX = startWinX + deltaX;
      let newY = startWinY + deltaY;

      // Clamp to selection bounds if we have them
      if (bounds) {
        const minX = bounds.x + padding;
        const maxX = bounds.x + bounds.width - webcamSize - padding;
        const minY = bounds.y + padding;
        const maxY = bounds.y + bounds.height - webcamSize - padding;

        newX = Math.max(minX, Math.min(maxX, newX));
        newY = Math.max(minY, Math.min(maxY, newY));
      }

      // Move window to clamped position
      try {
        const win = getCurrentWindow();
        await win.setPosition(new PhysicalPosition(newX, newY));
      } catch {
        // Ignore errors
      }
    };

    const handleMouseUp = async () => {
      if (!dragStateRef.current) return;

      dragStateRef.current = null;
      setIsDragging(false);

      // Update final position in settings (both Rust and frontend store)
      try {
        const win = getCurrentWindow();
        const position = await win.outerPosition();
        const customPosition = { type: 'custom' as const, x: position.x, y: position.y };

        // Update Rust state
        await invoke('set_webcam_position', { position: customPosition });

        // Emit event so store updates to show "None" in dropdown
        await emit('webcam-position-dragged', customPosition);
      } catch {
        // Ignore errors
      }
    };

    // Add global listeners
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [settings.size]);

  // Listen for close event from main window
  useEffect(() => {
    const unlisten = listen('webcam-preview-close', async () => {
      console.log('[WebcamPreview] Received close event');
      // Stop the stream before closing
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      try {
        const win = getCurrentWindow();
        await win.close();
      } catch (e) {
        console.error('[WebcamPreview] Error closing window:', e);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [stream]);

  // Also close if component unmounts
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [stream]);

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
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseDown={handleMouseDown}
      style={{
        width: '100%',
        height: '100%',
        cursor: isDragging ? 'grabbing' : 'grab',
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
          border: '2px solid rgba(255, 255, 255, 0.2)',
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
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={getShapeStyles(settings.shape)}
          />
        )}
      </div>
    </div>
  );
};

export default WebcamPreviewWindow;
