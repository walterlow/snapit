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
import { X, Circle, Square, FlipHorizontal2 } from 'lucide-react';
import type { WebcamSettings, WebcamSize, WebcamShape } from '@/types/generated';
import { webcamLogger } from '@/utils/logger';

// Preview window size based on webcam size setting
const PREVIEW_SIZES: Record<WebcamSize, number> = {
  small: 120,
  medium: 160,
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
    size: 'medium',
    shape: 'circle',
    mirror: true,
  });

  const mountedRef = useRef(true);
  const frameRequestRef = useRef<number | null>(null);

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
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', async (event) => {
      webcamLogger.debug('Settings changed:', event.payload);
      setSettings(event.payload);

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

  // Enable window dragging (only when not clicking controls)
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    // Don't start dragging if clicking on controls
    if ((e.target as HTMLElement).closest('.webcam-controls')) {
      return;
    }
    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch {
      // Ignore errors
    }
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

  const isCircle = settings.shape === 'circle';
  const borderRadius = isCircle ? '50%' : '12px';

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-black cursor-move"
      style={{ borderRadius }}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Webcam feed */}
      {imageSrc ? (
        <img
          src={imageSrc}
          alt="Webcam preview"
          className="w-full h-full object-cover"
          style={{
            borderRadius,
            transform: settings.mirror ? 'scaleX(-1)' : 'none',
          }}
          draggable={false}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-white/50 text-xs"
          style={{ borderRadius }}
        >
          Loading...
        </div>
      )}

      {/* Recording indicator */}
      {isRecording && (
        <div className="absolute top-2 right-2 w-3 h-3 rounded-full bg-red-500 animate-pulse" />
      )}

      {/* Controls overlay (visible on hover) */}
      {isHovered && !isRecording && (
        <div
          className="webcam-controls absolute inset-0 flex items-center justify-center gap-2 bg-black/40"
          style={{ borderRadius }}
        >
          {/* Close button */}
          <button
            onClick={handleClose}
            className="p-1.5 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
            title="Close preview"
          >
            <X size={14} />
          </button>

          {/* Shape toggle */}
          <button
            onClick={handleToggleShape}
            className="p-1.5 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
            title={isCircle ? 'Switch to rectangle' : 'Switch to circle'}
          >
            {isCircle ? <Square size={14} /> : <Circle size={14} />}
          </button>

          {/* Mirror toggle */}
          <button
            onClick={handleToggleMirror}
            className="p-1.5 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
            title={settings.mirror ? 'Disable mirror' : 'Enable mirror'}
            style={{ opacity: settings.mirror ? 1 : 0.5 }}
          >
            <FlipHorizontal2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
};

export default WebcamPreviewWindow;
