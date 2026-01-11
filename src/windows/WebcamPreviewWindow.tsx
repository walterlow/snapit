/**
 * WebcamPreviewWindow - Simple JPEG-based webcam preview.
 *
 * Polls for JPEG frames from Rust backend and displays them in an img tag.
 * Much simpler and often faster than GPU-based rendering.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { X, Circle, Square, FlipHorizontal2, Maximize2, Minimize2 } from 'lucide-react';
import type { WebcamSettings, WebcamSize, WebcamShape } from '@/types/generated';
import { webcamLogger } from '@/utils/logger';

// Control bar height
const CONTROL_BAR_HEIGHT = 40;
// Gap between control bar and preview
const CONTROL_GAP = 8;
// Top padding to prevent clipping
const TOP_PADDING = 4;

// Preview circle size based on webcam size setting
const CIRCLE_SIZES: Record<WebcamSize, number> = {
  small: 160,
  large: 200,
};

const WebcamPreviewWindow: React.FC = () => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [settings, setSettings] = useState<WebcamSettings>({
    enabled: true,
    deviceIndex: 0,
    position: { type: 'bottomRight' },
    size: 'small',
    shape: 'circle',
    mirror: true,
  });

  const mountedRef = useRef(true);
  const frameRequestRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSizeRef = useRef({ width: 0, height: 0 });

  // Resize window to fit content
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeWindow = async () => {
      const rect = container.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);

      // Skip if size hasn't changed
      if (width === lastSizeRef.current.width && height === lastSizeRef.current.height) {
        return;
      }
      if (width === 0 || height === 0) return;

      lastSizeRef.current = { width, height };

      try {
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(width, height));
        webcamLogger.debug(`Resized window to ${width}x${height}`);
      } catch (e) {
        webcamLogger.error('Failed to resize window:', e);
      }
    };

    // Initial resize
    resizeWindow();

    // Watch for size changes
    const observer = new ResizeObserver(() => {
      resizeWindow();
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  // Load initial settings
  useEffect(() => {
    const loadInitialSettings = async () => {
      try {
        const loaded = await invoke<WebcamSettings>('get_webcam_settings_cmd');
        setSettings(loaded);
      } catch (e) {
        webcamLogger.error('Failed to load settings:', e);
      }
    };
    loadInitialSettings();
  }, []);

  // Poll for JPEG frames
  useEffect(() => {
    mountedRef.current = true;
    let lastFrameTime = 0;
    const targetFps = 30;
    const frameInterval = 1000 / targetFps;

    const pollFrame = async () => {
      if (!mountedRef.current) return;

      const now = performance.now();
      if (now - lastFrameTime >= frameInterval) {
        try {
          const frame = await invoke<string | null>('get_webcam_preview_frame', { quality: 75 });
          if (frame && mountedRef.current) {
            setImageSrc(`data:image/jpeg;base64,${frame}`);
          }
          lastFrameTime = now;
        } catch (e) {
          // Ignore errors during polling
        }
      }

      if (mountedRef.current) {
        frameRequestRef.current = requestAnimationFrame(pollFrame);
      }
    };

    frameRequestRef.current = requestAnimationFrame(pollFrame);

    return () => {
      mountedRef.current = false;
      if (frameRequestRef.current) {
        cancelAnimationFrame(frameRequestRef.current);
      }
    };
  }, []);

  // Listen for settings changes from the toolbar or local controls
  // ResizeObserver handles window resizing automatically when content changes
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', (event) => {
      webcamLogger.debug('Settings changed:', event.payload);
      setSettings(event.payload);
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

  // Close/hide the preview and disable webcam
  const handleClose = useCallback(async () => {
    try {
      await invoke('close_webcam_from_preview');
    } catch (e) {
      webcamLogger.error('Failed to close preview:', e);
    }
  }, []);

  // Toggle shape
  const handleToggleShape = useCallback(async () => {
    const newShape: WebcamShape = settings.shape === 'circle' ? 'rectangle' : 'circle';
    try {
      await invoke('set_webcam_shape', { shape: newShape });
      const newSettings = { ...settings, shape: newShape };
      setSettings(newSettings);
      emit('webcam-settings-changed', newSettings);
    } catch (e) {
      webcamLogger.error('Failed to toggle shape:', e);
    }
  }, [settings]);

  // Toggle mirror
  const handleToggleMirror = useCallback(async () => {
    const newMirror = !settings.mirror;
    try {
      await invoke('set_webcam_mirror', { mirror: newMirror });
      const newSettings = { ...settings, mirror: newMirror };
      setSettings(newSettings);
      emit('webcam-settings-changed', newSettings);
    } catch (e) {
      webcamLogger.error('Failed to toggle mirror:', e);
    }
  }, [settings]);

  // Toggle size: small <-> large
  const handleToggleSize = useCallback(async () => {
    const newSize: WebcamSize = settings.size === 'small' ? 'large' : 'small';
    try {
      await invoke('set_webcam_size', { size: newSize });
      const newSettings = { ...settings, size: newSize };
      setSettings(newSettings);
      emit('webcam-settings-changed', newSettings);
      // Trigger anchor recalculation for new size
      if (settings.position.type !== 'custom') {
        emit('webcam-anchor-changed', { anchor: settings.position.type });
      }
    } catch (e) {
      webcamLogger.error('Failed to toggle size:', e);
    }
  }, [settings]);

  // Handle window dragging
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    // Don't drag if clicking on buttons
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }
    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch {
      // Ignore errors
    }
  }, []);

  const isCircle = settings.shape === 'circle';
  const borderRadius = isCircle ? '50%' : '12px';
  const circleSize = CIRCLE_SIZES[settings.size];

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: `${circleSize}px`,
        paddingTop: `${TOP_PADDING}px`,
        cursor: 'move',
        gap: `${CONTROL_GAP}px`,
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Controls bar */}
      <div
        style={{
          height: `${CONTROL_BAR_HEIGHT}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '6px 10px',
            background: 'rgba(0, 0, 0, 0.9)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '8px',
            opacity: isHovered && !isRecording ? 1 : 0,
            transform: isHovered && !isRecording ? 'translateY(0)' : 'translateY(-8px)',
            transition: 'opacity 0.2s, transform 0.2s',
          }}
        >
          <button
            onClick={handleToggleShape}
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: 'transparent',
              border: 'none',
              color: 'rgba(255, 255, 255, 0.8)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title={isCircle ? 'Switch to rectangle' : 'Switch to circle'}
          >
            {isCircle ? <Square size={16} /> : <Circle size={16} />}
          </button>
          <button
            onClick={handleToggleMirror}
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: 'transparent',
              border: 'none',
              color: 'rgba(255, 255, 255, 0.8)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: settings.mirror ? 1 : 0.5,
            }}
            title={settings.mirror ? 'Disable mirror' : 'Enable mirror'}
          >
            <FlipHorizontal2 size={16} />
          </button>
          <button
            onClick={handleToggleSize}
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: 'transparent',
              border: 'none',
              color: 'rgba(255, 255, 255, 0.8)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title={settings.size === 'small' ? 'Enlarge' : 'Shrink'}
          >
            {settings.size === 'large' ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            onClick={handleClose}
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: 'transparent',
              border: 'none',
              color: 'rgba(255, 255, 255, 0.8)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Close preview"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Webcam feed - explicit square size */}
      <div
        style={{
          width: `${circleSize}px`,
          height: `${circleSize}px`,
          overflow: 'hidden',
          background: '#000',
          borderRadius,
        }}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt="Webcam preview"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              borderRadius,
              transform: settings.mirror ? 'scaleX(-1)' : 'none',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
            draggable={false}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255, 255, 255, 0.5)',
              fontSize: '12px',
              borderRadius,
              pointerEvents: 'none',
            }}
          >
            Loading...
          </div>
        )}

        {/* Recording indicator */}
        {isRecording && (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              background: '#ef4444',
              animation: 'pulse 2s infinite',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  );
};

export default WebcamPreviewWindow;
