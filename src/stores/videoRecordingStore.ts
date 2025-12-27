/**
 * Video Recording Store
 *
 * Manages video and GIF recording state, including start/stop/pause controls,
 * progress tracking, and recording settings.
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type {
  RecordingFormat,
  RecordingMode,
  RecordingSettings,
  RecordingState,
  RecordingStatus,
  StartRecordingResult,
} from '../types';

interface VideoRecordingStore {
  // State
  recordingState: RecordingState;
  settings: RecordingSettings;
  isInitialized: boolean;

  // Actions
  initialize: () => Promise<void>;
  cleanup: () => void;

  // Settings
  updateSettings: (settings: Partial<RecordingSettings>) => void;
  setFormat: (format: RecordingFormat) => void;
  setMode: (mode: RecordingMode) => void;
  setFps: (fps: number) => void;
  setMaxDuration: (seconds: number | null) => void;
  setQuality: (quality: number) => void;
  setCountdown: (seconds: number) => void;
  toggleSystemAudio: () => void;
  toggleMicrophone: () => void;
  toggleCursor: () => void;

  // Recording controls
  startRecording: (mode?: RecordingMode) => Promise<boolean>;
  stopRecording: () => Promise<boolean>;
  cancelRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;

  // Status
  refreshStatus: () => Promise<void>;
  resetToIdle: () => void;
  isRecording: () => boolean;
  isPaused: () => boolean;
  isProcessing: () => boolean;
}

// Default settings
const defaultSettings: RecordingSettings = {
  format: 'mp4',
  mode: { type: 'monitor', monitorIndex: 0 },
  fps: 30,
  maxDurationSecs: null,
  includeCursor: true,
  audio: {
    captureSystemAudio: true,
    captureMicrophone: false,
  },
  quality: 80,
  gifQualityPreset: 'balanced',
  countdownSecs: 3,
};

// Event listener cleanup function
let unlistenFn: UnlistenFn | null = null;

export const useVideoRecordingStore = create<VideoRecordingStore>((set, get) => ({
  // Initial state
  recordingState: { status: 'idle' },
  settings: defaultSettings,
  isInitialized: false,

  // Initialize the store and set up event listeners
  initialize: async () => {
    if (get().isInitialized) return;

    // Set up event listener for recording state changes
    unlistenFn = await listen<RecordingState>('recording-state-changed', (event) => {
      const newState = event.payload;
      set({ recordingState: newState });
      
      // Auto-reset to idle after terminal states (completed/error) so user can start a new recording
      if (newState.status === 'completed' || newState.status === 'error') {
        // Brief delay to allow UI to show completion/error state before resetting
        setTimeout(() => {
          set({ recordingState: { status: 'idle' } });
        }, 100);
      }
    });

    // Get initial status from backend
    await get().refreshStatus();

    set({ isInitialized: true });
  },

  // Clean up event listeners
  cleanup: () => {
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
    set({ isInitialized: false });
  },

  // Update settings
  updateSettings: (newSettings) => {
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    }));
  },

  setFormat: (format) => {
    set((state) => ({
      settings: { ...state.settings, format },
    }));
  },

  setMode: (mode) => {
    set((state) => ({
      settings: { ...state.settings, mode },
    }));
  },

  setFps: (fps) => {
    // Clamp to valid range
    const clampedFps = Math.min(60, Math.max(10, fps));
    set((state) => ({
      settings: { ...state.settings, fps: clampedFps },
    }));
  },

  setMaxDuration: (seconds) => {
    set((state) => ({
      settings: { ...state.settings, maxDurationSecs: seconds },
    }));
  },

  setQuality: (quality) => {
    const clampedQuality = Math.min(100, Math.max(1, quality));
    set((state) => ({
      settings: { ...state.settings, quality: clampedQuality },
    }));
  },

  setCountdown: (seconds) => {
    const clampedCountdown = Math.min(10, Math.max(0, seconds));
    set((state) => ({
      settings: { ...state.settings, countdownSecs: clampedCountdown },
    }));
  },

  toggleSystemAudio: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        audio: {
          ...state.settings.audio,
          captureSystemAudio: !state.settings.audio.captureSystemAudio,
        },
      },
    }));
  },

  toggleMicrophone: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        audio: {
          ...state.settings.audio,
          captureMicrophone: !state.settings.audio.captureMicrophone,
        },
      },
    }));
  },

  toggleCursor: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        includeCursor: !state.settings.includeCursor,
      },
    }));
  },

  // Start recording
  startRecording: async (mode) => {
    const { settings, recordingState } = get();

    // Don't start if already recording
    if (recordingState.status !== 'idle') {
      console.warn('Cannot start recording: already in progress');
      return false;
    }

    const recordingSettings: RecordingSettings = {
      ...settings,
      mode: mode ?? settings.mode,
    };

    try {
      const result = await invoke<StartRecordingResult>('start_recording', {
        settings: recordingSettings,
      });

      return result.success;
    } catch (error) {
      console.error('Failed to start recording:', error);
      set({
        recordingState: {
          status: 'error',
          message: String(error),
        },
      });
      return false;
    }
  },

  // Stop recording and save
  // Returns immediately after sending stop command.
  // Actual completion comes via 'recording-state-changed' event.
  stopRecording: async () => {
    const { recordingState } = get();

    if (recordingState.status !== 'recording' && recordingState.status !== 'paused') {
      console.warn('Cannot stop recording: not recording');
      return false;
    }

    try {
      await invoke('stop_recording');
      return true;
    } catch (error) {
      console.error('Failed to stop recording:', error);
      set({
        recordingState: {
          status: 'error',
          message: String(error),
        },
      });
      return false;
    }
  },

  // Cancel recording without saving
  cancelRecording: async () => {
    try {
      await invoke('cancel_recording');
      // Don't set state here - the backend will emit 'recording-state-changed'
      // after the capture thread cleans up and deletes the file.
    } catch (error) {
      console.error('Failed to cancel recording:', error);
    }
  },

  // Pause recording (MP4 only)
  pauseRecording: async () => {
    const { recordingState, settings } = get();

    if (recordingState.status !== 'recording') {
      console.warn('Cannot pause: not recording');
      return;
    }

    if (settings.format === 'gif') {
      console.warn('Cannot pause GIF recording');
      return;
    }

    try {
      await invoke('pause_recording');
    } catch (error) {
      console.error('Failed to pause recording:', error);
    }
  },

  // Resume paused recording
  resumeRecording: async () => {
    const { recordingState } = get();

    if (recordingState.status !== 'paused') {
      console.warn('Cannot resume: not paused');
      return;
    }

    try {
      await invoke('resume_recording');
    } catch (error) {
      console.error('Failed to resume recording:', error);
    }
  },

  // Refresh status from backend
  refreshStatus: async () => {
    try {
      const status = await invoke<RecordingStatus>('get_recording_status');
      set({
        recordingState: status.state,
        settings: status.settings ?? get().settings,
      });
    } catch (error) {
      console.error('Failed to get recording status:', error);
    }
  },

  // Reset state to idle (for starting new capture sessions)
  resetToIdle: () => {
    const { recordingState } = get();
    // Only reset if not actively recording
    if (recordingState.status !== 'recording' && 
        recordingState.status !== 'countdown' && 
        recordingState.status !== 'paused' &&
        recordingState.status !== 'processing') {
      set({ recordingState: { status: 'idle' } });
    }
  },

  // Helper methods
  isRecording: () => {
    const { recordingState } = get();
    return (
      recordingState.status === 'recording' ||
      recordingState.status === 'countdown'
    );
  },

  isPaused: () => {
    const { recordingState } = get();
    return recordingState.status === 'paused';
  },

  isProcessing: () => {
    const { recordingState } = get();
    return recordingState.status === 'processing';
  },
}));

// Helper hook for formatted elapsed time
export function formatElapsedTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Helper hook for formatted file size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
