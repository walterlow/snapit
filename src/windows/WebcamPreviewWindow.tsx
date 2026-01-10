/**
 * WebcamPreviewWindow - GPU-accelerated webcam preview.
 *
 * Uses wgpu to render camera frames directly to the window surface.
 * No JPEG encoding, no IPC polling - smooth 30fps GPU-rendered preview.
 *
 * NOTE: GPU initialization is now handled by Rust (Cap pattern).
 * This component just handles the UI overlay (dragging, recording indicator, controls).
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
  const [error] = useState<string | null>(null);
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

  // Listen for settings changes from the toolbar or local controls
  useEffect(() => {
    const unlisten = listen<WebcamSettings>('webcam-settings-changed', async (event) => {
      webcamLogger.debug('Settings changed:', event.payload);
      setSettings(event.payload);

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
      // This command hides preview, disables webcam in Rust config,
      // and emits 'webcam-disabled-from-preview' event for frontend
      await invoke('close_webcam_from_preview');
    } catch (e) {
      webcamLogger.error('Failed to close preview:', e);
    }
  }, []);

  // Toggle shape (circle -> rectangle -> circle)
  const handleToggleShape = useCallback(async () => {
    const newShape: WebcamShape = settings.shape === 'circle' ? 'rectangle' : 'circle';
    try {
      await invoke('set_webcam_shape', { shape: newShape });
      const newSettings = { ...settings, shape: newShape };
      setSettings(newSettings);
      // Emit to sync with toolbar
      emit('webcam-settings-changed', newSettings).catch(() => {});
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
      // Emit to sync with toolbar
      emit('webcam-settings-changed', newSettings).catch(() => {});
    } catch (e) {
      webcamLogger.error('Failed to toggle mirror:', e);
    }
  }, [settings]);

  const shape = settings.shape;

  // The GPU renders directly to the window surface, so we only need:
  // 1. A transparent container for dragging
  // 2. An error overlay if something fails
  // 3. A recording indicator border
  // 4. Hover-visible control bar
  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width: '100%',
        height: '100%',
        cursor: 'grab',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
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

      {/* Hover-visible control bar */}
      <div
        className="webcam-controls"
        style={{
          position: 'absolute',
          bottom: shape === 'circle' ? '15%' : '8px',
          left: '50%',
          transform: `translateX(-50%) translateY(${isHovered ? '0' : '8px'})`,
          display: 'flex',
          gap: '2px',
          padding: '3px',
          borderRadius: '10px',
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          opacity: isHovered ? 1 : 0,
          transition: 'opacity 0.15s ease, transform 0.15s ease',
          pointerEvents: isHovered ? 'auto' : 'none',
          cursor: 'default',
        }}
      >
        {/* Close button */}
        <button
          onClick={handleClose}
          title="Close preview"
          style={{
            width: '24px',
            height: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: '6px',
            background: 'transparent',
            color: 'rgba(255, 255, 255, 0.8)',
            cursor: 'pointer',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
            e.currentTarget.style.color = '#fff';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
          }}
        >
          <X size={14} />
        </button>

        {/* Shape toggle button */}
        <button
          onClick={handleToggleShape}
          title={`Shape: ${shape} (click to change)`}
          style={{
            width: '24px',
            height: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: '6px',
            background: shape === 'rectangle' ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            color: 'rgba(255, 255, 255, 0.8)',
            cursor: 'pointer',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => {
            if (shape !== 'rectangle') {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
            }
            e.currentTarget.style.color = '#fff';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = shape === 'rectangle' ? 'rgba(255, 255, 255, 0.2)' : 'transparent';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
          }}
        >
          {shape === 'circle' ? <Circle size={14} /> : <Square size={14} />}
        </button>

        {/* Mirror toggle button */}
        <button
          onClick={handleToggleMirror}
          title={`Mirror: ${settings.mirror ? 'On' : 'Off'}`}
          style={{
            width: '24px',
            height: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: '6px',
            background: settings.mirror ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            color: 'rgba(255, 255, 255, 0.8)',
            cursor: 'pointer',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => {
            if (!settings.mirror) {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
            }
            e.currentTarget.style.color = '#fff';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = settings.mirror ? 'rgba(255, 255, 255, 0.2)' : 'transparent';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
          }}
        >
          <FlipHorizontal2 size={14} />
        </button>
      </div>

      {/* GPU renders webcam directly to window surface - no <img> needed */}
    </div>
  );
};

export default WebcamPreviewWindow;
