import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AudioInputDevice } from '../types/generated';

interface AudioInputState {
  // State
  devices: AudioInputDevice[];
  isLoadingDevices: boolean;
  devicesError: string | null;

  // Actions
  loadDevices: () => Promise<void>;
}

export const useAudioInputStore = create<AudioInputState>((set) => ({
  devices: [],
  isLoadingDevices: false,
  devicesError: null,

  loadDevices: async () => {
    set({ isLoadingDevices: true, devicesError: null });
    try {
      const devices = await invoke<AudioInputDevice[]>('list_audio_input_devices');
      set({ devices, isLoadingDevices: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ devicesError: message, isLoadingDevices: false });
      console.error('Failed to load audio input devices:', error);
    }
  },
}));

// Selectors
export const useAudioInputDevices = () =>
  useAudioInputStore((state) => state.devices);
