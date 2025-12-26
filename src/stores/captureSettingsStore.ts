import { create } from 'zustand';
import { LazyStore } from '@tauri-apps/plugin-store';
import type {
  CaptureSettings,
  ScreenshotSettings,
  ScreenshotFormat,
  VideoSettings,
  GifSettings,
} from '../types/generated';
import type { CaptureType } from '../types';

const CAPTURE_SETTINGS_STORE_PATH = 'capture-settings.json';

// Create a lazy store instance (initialized on first access)
let storeInstance: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!storeInstance) {
    storeInstance = new LazyStore(CAPTURE_SETTINGS_STORE_PATH);
  }
  return storeInstance;
}

// Default settings
const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = {
  format: 'png' as ScreenshotFormat,
  jpgQuality: 85,
  includeCursor: true,
};

const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  quality: 80,
  fps: 30,
  maxDurationSecs: null,
  includeCursor: true,
  captureSystemAudio: true,
  captureMicrophone: false,
  captureWebcam: false, // Placeholder - always false for now
  countdownSecs: 3,
};

const DEFAULT_GIF_SETTINGS: GifSettings = {
  quality: 80,
  fps: 15,
  maxDurationSecs: 30,
  includeCursor: true,
  countdownSecs: 3,
};

const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  screenshot: DEFAULT_SCREENSHOT_SETTINGS,
  video: DEFAULT_VIDEO_SETTINGS,
  gif: DEFAULT_GIF_SETTINGS,
};

interface CaptureSettingsState {
  // Settings data
  settings: CaptureSettings;
  isLoading: boolean;
  isInitialized: boolean;

  // Current active mode
  activeMode: CaptureType;

  // Actions - Settings management
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;

  // Actions - Mode
  setActiveMode: (mode: CaptureType) => void;

  // Actions - Screenshot settings
  updateScreenshotSettings: (settings: Partial<ScreenshotSettings>) => void;
  resetScreenshotSettings: () => void;

  // Actions - Video settings
  updateVideoSettings: (settings: Partial<VideoSettings>) => void;
  resetVideoSettings: () => void;

  // Actions - GIF settings
  updateGifSettings: (settings: Partial<GifSettings>) => void;
  resetGifSettings: () => void;

  // Actions - Reset all
  resetAllSettings: () => void;
}

export const useCaptureSettingsStore = create<CaptureSettingsState>((set, get) => ({
  settings: { ...DEFAULT_CAPTURE_SETTINGS },
  isLoading: false,
  isInitialized: false,
  activeMode: 'video',

  loadSettings: async () => {
    set({ isLoading: true });
    try {
      const store = await getStore();

      const savedSettings = await store.get<CaptureSettings>('captureSettings');
      const savedActiveMode = await store.get<CaptureType>('activeMode');

      // Merge with defaults (in case new settings were added)
      const settings: CaptureSettings = {
        screenshot: {
          ...DEFAULT_SCREENSHOT_SETTINGS,
          ...savedSettings?.screenshot,
        },
        video: {
          ...DEFAULT_VIDEO_SETTINGS,
          ...savedSettings?.video,
          // Always ensure webcam is false for now (placeholder)
          captureWebcam: false,
        },
        gif: {
          ...DEFAULT_GIF_SETTINGS,
          ...savedSettings?.gif,
        },
      };

      set({
        settings,
        activeMode: savedActiveMode || 'video',
        isLoading: false,
        isInitialized: true,
      });
    } catch {
      // Use defaults on error
      set({
        settings: { ...DEFAULT_CAPTURE_SETTINGS },
        activeMode: 'video',
        isLoading: false,
        isInitialized: true,
      });
    }
  },

  saveSettings: async () => {
    const { settings, activeMode } = get();
    try {
      const store = await getStore();
      await store.set('captureSettings', settings);
      await store.set('activeMode', activeMode);
      await store.save();
    } catch (error) {
      console.error('Failed to save capture settings:', error);
      throw error;
    }
  },

  setActiveMode: (mode) => {
    set({ activeMode: mode });
    // Auto-save when mode changes
    get().saveSettings().catch(console.error);
  },

  updateScreenshotSettings: (updates) => {
    set((state) => ({
      settings: {
        ...state.settings,
        screenshot: {
          ...state.settings.screenshot,
          ...updates,
        },
      },
    }));
    // Auto-save on change
    get().saveSettings().catch(console.error);
  },

  resetScreenshotSettings: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        screenshot: { ...DEFAULT_SCREENSHOT_SETTINGS },
      },
    }));
    get().saveSettings().catch(console.error);
  },

  updateVideoSettings: (updates) => {
    set((state) => ({
      settings: {
        ...state.settings,
        video: {
          ...state.settings.video,
          ...updates,
          // Always ensure webcam is false for now (placeholder)
          captureWebcam: false,
        },
      },
    }));
    // Auto-save on change
    get().saveSettings().catch(console.error);
  },

  resetVideoSettings: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        video: { ...DEFAULT_VIDEO_SETTINGS },
      },
    }));
    get().saveSettings().catch(console.error);
  },

  updateGifSettings: (updates) => {
    // Validate GIF-specific constraints
    const validated = { ...updates };
    if (validated.fps !== undefined) {
      validated.fps = Math.min(validated.fps, 30); // Cap at 30 FPS for GIF
    }
    if (validated.maxDurationSecs !== undefined) {
      validated.maxDurationSecs = Math.min(validated.maxDurationSecs, 60); // Cap at 60s for GIF
    }

    set((state) => ({
      settings: {
        ...state.settings,
        gif: {
          ...state.settings.gif,
          ...validated,
        },
      },
    }));
    // Auto-save on change
    get().saveSettings().catch(console.error);
  },

  resetGifSettings: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        gif: { ...DEFAULT_GIF_SETTINGS },
      },
    }));
    get().saveSettings().catch(console.error);
  },

  resetAllSettings: () => {
    set({
      settings: { ...DEFAULT_CAPTURE_SETTINGS },
      activeMode: 'video',
    });
    get().saveSettings().catch(console.error);
  },
}));

// Selector for current mode's settings
export const useCurrentModeSettings = () => {
  const activeMode = useCaptureSettingsStore((state) => state.activeMode);
  const settings = useCaptureSettingsStore((state) => state.settings);

  switch (activeMode) {
    case 'screenshot':
      return { mode: activeMode, settings: settings.screenshot };
    case 'video':
      return { mode: activeMode, settings: settings.video };
    case 'gif':
      return { mode: activeMode, settings: settings.gif };
    default:
      return { mode: activeMode, settings: settings.video };
  }
};

// Selector for screenshot settings
export const useScreenshotSettings = () => {
  return useCaptureSettingsStore((state) => state.settings.screenshot);
};

// Selector for video settings
export const useVideoSettings = () => {
  return useCaptureSettingsStore((state) => state.settings.video);
};

// Selector for GIF settings
export const useGifSettings = () => {
  return useCaptureSettingsStore((state) => state.settings.gif);
};
