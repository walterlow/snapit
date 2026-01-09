import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import type { WebcamDevice, WebcamSettings, WebcamPosition, WebcamSize, WebcamShape } from '../types/generated';
import { createErrorHandler } from '../utils/errorReporting';
import { webcamLogger } from '../utils/logger';

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

// Guard against concurrent preview creation
let isCreatingPreview = false;

export const useWebcamSettingsStore = create<WebcamSettingsState>((set, get) => ({
  settings: { ...DEFAULT_WEBCAM_SETTINGS },
  devices: [],
  isLoadingDevices: false,
  devicesError: null,
  previewOpen: false,

  loadSettings: async () => {
    try {
      const settings = await invoke<WebcamSettings>('get_webcam_settings_cmd');
      webcamLogger.debug('Loaded settings from Rust:', settings);
      // Merge with current state to preserve previewOpen
      set((state) => ({
        settings: { ...state.settings, ...settings }
      }));
      webcamLogger.debug('After set, store state:', get().settings);
    } catch (error) {
      webcamLogger.error('Failed to load settings from Rust:', error);
    }
  },

  loadDevices: async () => {
    set({ isLoadingDevices: true, devicesError: null });
    try {
      // Use native Rust device enumeration (no browser getUserMedia needed)
      const videoDevices = await invoke<WebcamDevice[]>('list_webcam_devices');
      webcamLogger.debug('Found webcam devices (native):', videoDevices);
      set({ devices: videoDevices, isLoadingDevices: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ devicesError: message, isLoadingDevices: false });
      webcamLogger.error('Failed to load webcam devices:', error);
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
      webcamLogger.error('Failed to set webcam enabled:', error);
    }
  },

  setDevice: async (deviceIndex: number) => {
    try {
      await invoke('set_webcam_device', { deviceIndex });
      set((state) => ({
        settings: { ...state.settings, deviceIndex },
      }));
    } catch (error) {
      webcamLogger.error('Failed to set webcam device:', error);
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
      webcamLogger.error('Failed to set webcam position:', error);
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
      webcamLogger.error('Failed to set webcam size:', error);
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
      webcamLogger.error('Failed to set webcam shape:', error);
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
      webcamLogger.error('Failed to set webcam mirror:', error);
    }
  },

  togglePreview: async () => {
    const { previewOpen, settings, closePreview } = get();

    if (previewOpen) {
      // Close preview using the reliable closePreview method
      await closePreview();
    } else {
      // Prevent concurrent preview creation (race from multiple focus events)
      if (isCreatingPreview) {
        webcamLogger.debug('Preview creation already in progress, skipping');
        return;
      }
      isCreatingPreview = true;

      try {
        webcamLogger.debug('Opening preview via Rust (Cap pattern)');

        // Use new Rust-controlled flow (Cap pattern):
        // - Creates window HIDDEN
        // - Initializes wgpu
        // - Shows window after GPU is ready
        await invoke('show_camera_preview', { deviceIndex: settings.deviceIndex });

        set({ previewOpen: true });
        webcamLogger.debug('Preview opened successfully');

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
      } catch (error) {
        webcamLogger.error('Failed to open webcam preview:', error);
        set({ previewOpen: false });
      } finally {
        isCreatingPreview = false;
      }
    }
  },

  closePreview: async () => {
    // Reset creation guard first to allow re-creation after close
    isCreatingPreview = false;

    // Use new Rust-controlled hide (Cap pattern)
    try {
      await invoke('hide_camera_preview');
      webcamLogger.debug('Preview closed via Rust');
    } catch (e) {
      webcamLogger.error('Failed to close preview:', e);
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
