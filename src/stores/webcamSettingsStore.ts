import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { WebcamDevice, WebcamSettings, WebcamPosition, WebcamSize, WebcamShape } from '../types/generated';
import { createErrorHandler } from '../utils/errorReporting';

interface WebcamSettingsState {
  // State
  settings: WebcamSettings;
  devices: WebcamDevice[];
  isLoadingDevices: boolean;
  devicesError: string | null;
  previewOpen: boolean;

  // Actions
  loadSettings: () => Promise<void>;
  loadDevices: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setDevice: (deviceIndex: number) => Promise<void>;
  setPosition: (position: WebcamPosition) => Promise<void>;
  setSize: (size: WebcamSize) => Promise<void>;
  setShape: (shape: WebcamShape) => Promise<void>;
  setMirror: (mirror: boolean) => Promise<void>;
  togglePreview: () => Promise<void>;
  closePreview: () => Promise<void>;
}

const DEFAULT_WEBCAM_SETTINGS: WebcamSettings = {
  enabled: false,
  deviceIndex: 0,
  position: { type: 'bottomRight' },
  size: 'medium',
  shape: 'circle',
  mirror: true,
};

// Preview window size based on webcam size setting
const PREVIEW_SIZES: Record<WebcamSize, number> = {
  small: 120,
  medium: 160,
  large: 200,
};


export const useWebcamSettingsStore = create<WebcamSettingsState>((set, get) => ({
  settings: { ...DEFAULT_WEBCAM_SETTINGS },
  devices: [],
  isLoadingDevices: false,
  devicesError: null,
  previewOpen: false,

  loadSettings: async () => {
    try {
      const settings = await invoke<WebcamSettings>('get_webcam_settings_cmd');
      console.log('[WebcamStore] Loaded settings from Rust:', settings);
      // Merge with current state to preserve previewOpen
      set((state) => ({
        settings: { ...state.settings, ...settings }
      }));
      console.log('[WebcamStore] After set, store state:', get().settings);
    } catch (error) {
      console.error('[WebcamStore] Failed to load settings from Rust:', error);
    }
  },

  loadDevices: async () => {
    set({ isLoadingDevices: true, devicesError: null });
    try {
      // Use browser's MediaDevices API to enumerate webcams
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        throw new Error('MediaDevices API not supported');
      }

      // Request camera permission first (needed to get device labels)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        // Stop the stream immediately - we just needed permission
        stream.getTracks().forEach(track => track.stop());
      } catch (permError) {
        console.warn('[WebcamStore] Camera permission denied or unavailable:', permError);
        // Continue anyway - we might still get device IDs without labels
      }

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = allDevices
        .filter(device => device.kind === 'videoinput')
        .map((device, index): WebcamDevice => ({
          index,
          name: device.label || `Camera ${index + 1}`,
          description: device.deviceId ? `ID: ${device.deviceId.substring(0, 8)}...` : null,
        }));

      console.log('[WebcamStore] Found webcam devices:', videoDevices);
      set({ devices: videoDevices, isLoadingDevices: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ devicesError: message, isLoadingDevices: false });
      console.error('Failed to load webcam devices:', error);
    }
  },

  setEnabled: async (enabled: boolean) => {
    try {
      await invoke('set_webcam_enabled', { enabled });
      set((state) => ({
        settings: { ...state.settings, enabled },
      }));
      if (enabled) {
        // Auto-open preview when webcam is enabled
        const { previewOpen, togglePreview } = useWebcamSettingsStore.getState();
        if (!previewOpen) {
          await togglePreview();
        }
      } else {
        // Close preview when webcam is disabled
        const { closePreview } = useWebcamSettingsStore.getState();
        await closePreview();
      }
    } catch (error) {
      console.error('Failed to set webcam enabled:', error);
    }
  },

  setDevice: async (deviceIndex: number) => {
    try {
      await invoke('set_webcam_device', { deviceIndex });
      set((state) => ({
        settings: { ...state.settings, deviceIndex },
      }));
    } catch (error) {
      console.error('Failed to set webcam device:', error);
    }
  },

  setPosition: async (position: WebcamPosition) => {
    try {
      await invoke('set_webcam_position', { position });
      set((state) => ({
        settings: { ...state.settings, position },
      }));
      // Emit event so CaptureToolbarWindow can reposition the preview
      if (get().previewOpen && position.type !== 'custom') {
        emit('webcam-anchor-changed', { anchor: position.type }).catch(
          createErrorHandler({ operation: 'emit webcam-anchor-changed', silent: true })
        );
      }
    } catch (error) {
      console.error('Failed to set webcam position:', error);
    }
  },

  setSize: async (size: WebcamSize) => {
    try {
      await invoke('set_webcam_size', { size });
      const newSettings = { ...get().settings, size };
      set({ settings: newSettings });
      // Notify preview window of change
      if (get().previewOpen) {
        emit('webcam-settings-changed', newSettings).catch(
          createErrorHandler({ operation: 'emit webcam-settings-changed', silent: true })
        );
        // If using an anchor position, trigger recalculation for new size
        if (newSettings.position.type !== 'custom') {
          emit('webcam-anchor-changed', { anchor: newSettings.position.type }).catch(
            createErrorHandler({ operation: 'emit webcam-anchor-changed', silent: true })
          );
        }
      }
    } catch (error) {
      console.error('Failed to set webcam size:', error);
    }
  },

  setShape: async (shape: WebcamShape) => {
    try {
      await invoke('set_webcam_shape', { shape });
      const newSettings = { ...get().settings, shape };
      set({ settings: newSettings });
      // Notify preview window of change
      if (get().previewOpen) {
        emit('webcam-settings-changed', newSettings).catch(
          createErrorHandler({ operation: 'emit webcam-settings-changed', silent: true })
        );
      }
    } catch (error) {
      console.error('Failed to set webcam shape:', error);
    }
  },

  setMirror: async (mirror: boolean) => {
    try {
      await invoke('set_webcam_mirror', { mirror });
      const newSettings = { ...get().settings, mirror };
      set({ settings: newSettings });
      // Notify preview window of change
      if (get().previewOpen) {
        emit('webcam-settings-changed', newSettings).catch(
          createErrorHandler({ operation: 'emit webcam-settings-changed', silent: true })
        );
      }
    } catch (error) {
      console.error('Failed to set webcam mirror:', error);
    }
  },

  togglePreview: async () => {
    const { previewOpen, settings, closePreview } = get();

    if (previewOpen) {
      // Close preview using the reliable closePreview method
      await closePreview();
    } else {
      // First ensure any stale preview is closed
      try {
        await invoke('stop_native_webcam_preview');
      } catch {
        // Ignore - might not be running
      }
      try {
        await invoke('stop_webcam_preview');
      } catch {
        // Ignore - might not be running
      }
      try {
        await invoke('close_webcam_preview');
      } catch {
        // Ignore - window might not exist
      }

      // Small delay to ensure cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Create WebView-based preview window
      // The window component handles both browser getUserMedia (for preview)
      // and Rust crabcamera service (for recording)
      try {
        const size = PREVIEW_SIZES[settings.size];
        const win = new WebviewWindow('webcam-preview', {
          url: '/webcam-preview.html',
          title: 'Webcam Preview',
          width: size,
          height: size,
          resizable: false,
          decorations: false,
          alwaysOnTop: true,
          transparent: true,
          skipTaskbar: true,
          shadow: false,
          center: false,
          x: 100,
          y: 100,
        });

        win.once('tauri://created', async () => {
          set({ previewOpen: true });
          // Emit settings to the new window
          emit('webcam-settings-changed', settings).catch(
            createErrorHandler({ operation: 'emit webcam-settings-changed', silent: true })
          );
          
          // Exclude preview from screen capture (so it doesn't appear in recordings)
          try {
            await invoke('exclude_webcam_from_capture');
          } catch (e) {
            console.warn('[WebcamStore] Failed to exclude preview from capture:', e);
          }
          
          // Trigger anchor positioning after a delay
          setTimeout(async () => {
            try {
              await invoke('bring_webcam_preview_to_front');
              // Emit anchor change so CaptureToolbarWindow can position the webcam
              if (settings.position.type !== 'custom') {
                emit('webcam-anchor-changed', { anchor: settings.position.type }).catch(
                  createErrorHandler({ operation: 'emit webcam-anchor-changed', silent: true })
                );
              }
            } catch {
              // Ignore
            }
          }, 300);
        });

        win.once('tauri://close-requested', () => {
          set({ previewOpen: false });
        });

        win.once('tauri://destroyed', () => {
          set({ previewOpen: false });
        });

        win.once('tauri://error', (e) => {
          console.error('Failed to create webcam preview:', e);
          set({ previewOpen: false });
        });
      } catch (error) {
        console.error('Failed to open webcam preview:', error);
      }
    }
  },

  closePreview: async () => {
    // Stop native preview (Windows GDI)
    try {
      await invoke('stop_native_webcam_preview');
    } catch {
      // Ignore - might not be running
    }

    // Use Rust command to close the WebView window (most reliable)
    try {
      await invoke('close_webcam_preview');
    } catch (e) {
      console.error('Failed to close preview via Rust:', e);
    }

    // Also emit event as backup
    try {
      await emit('webcam-preview-close');
    } catch {
      // Ignore
    }

    set({ previewOpen: false });
  },
}));

// Selectors
export const useWebcamEnabled = () =>
  useWebcamSettingsStore((state) => state.settings.enabled);

export const useWebcamDevices = () =>
  useWebcamSettingsStore((state) => state.devices);

export const useWebcamSettings = () =>
  useWebcamSettingsStore((state) => state.settings);
