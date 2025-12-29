import { create } from 'zustand';
import { LazyStore } from '@tauri-apps/plugin-store';
import type {
  AppSettings,
  ShortcutConfig,
  GeneralSettings,
  ShortcutStatus,
} from '../types';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  DEFAULT_GENERAL_SETTINGS,
} from '../types';
import {
  SETTINGS_VERSION,
  migrateSettings,
  mergeWithDefaults,
  needsMigration,
} from '../utils/settingsMigrations';
import { createLogger } from '../utils/logger';

const settingsLogger = createLogger('Settings');

const SETTINGS_STORE_PATH = 'settings.json';

// Create a lazy store instance (initialized on first access)
let storeInstance: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!storeInstance) {
    storeInstance = new LazyStore(SETTINGS_STORE_PATH);
  }
  return storeInstance;
}

interface SettingsState {
  // Settings data
  settings: AppSettings;
  isLoading: boolean;
  isInitialized: boolean;

  // UI state
  settingsModalOpen: boolean;
  activeTab: 'shortcuts' | 'general';

  // Actions - Settings management
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;

  // Actions - Shortcuts
  updateShortcut: (id: string, shortcut: string) => void;
  updateShortcutStatus: (id: string, status: ShortcutStatus) => void;
  setShortcutUseHook: (id: string, useHook: boolean) => void;
  resetShortcut: (id: string) => void;
  resetAllShortcuts: () => void;
  getShortcut: (id: string) => ShortcutConfig | undefined;

  // Actions - General settings
  updateGeneralSettings: (settings: Partial<GeneralSettings>) => void;
  resetGeneralSettings: () => void;

  // Actions - UI
  openSettingsModal: (tab?: 'shortcuts' | 'general') => void;
  closeSettingsModal: () => void;
  setActiveTab: (tab: 'shortcuts' | 'general') => void;
}

/**
 * Main store for application settings including shortcuts and general preferences.
 * Persists to Tauri's LazyStore (settings.json) with automatic migration support.
 *
 * @example
 * ```tsx
 * const { settings, loadSettings, updateShortcut } = useSettingsStore();
 *
 * // Load on app start
 * useEffect(() => { loadSettings(); }, []);
 *
 * // Update a shortcut
 * updateShortcut('region_capture', 'Ctrl+Shift+A');
 * ```
 */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoading: false,
  isInitialized: false,
  settingsModalOpen: false,
  activeTab: 'general',

  loadSettings: async () => {
    set({ isLoading: true });
    try {
      const store = await getStore();

      // Load raw settings from storage
      const savedShortcuts = await store.get<Record<string, Partial<ShortcutConfig>>>('shortcuts');
      const savedGeneral = await store.get<Partial<GeneralSettings>>('general');
      const savedVersion = await store.get<number>('_version');

      // Build raw settings object for migration
      const rawSettings = {
        _version: savedVersion ?? 0,
        shortcuts: savedShortcuts ?? undefined,
        general: savedGeneral ?? undefined,
      };

      // Apply migrations if needed
      const migratedSettings = migrateSettings(rawSettings);

      // Merge with defaults to ensure all fields exist
      const settings = mergeWithDefaults(migratedSettings);

      // Save migrated settings if version changed
      if (needsMigration(rawSettings)) {
        settingsLogger.info('Settings migrated, saving new version');
        await store.set('_version', SETTINGS_VERSION);
        await store.set('shortcuts', migratedSettings.shortcuts);
        await store.set('general', migratedSettings.general);
        await store.save();
      }

      set({
        settings,
        isLoading: false,
        isInitialized: true,
      });
    } catch {
      // Use defaults on error
      set({
        settings: { ...DEFAULT_SETTINGS },
        isLoading: false,
        isInitialized: true,
      });
    }
  },

  saveSettings: async () => {
    const { settings } = get();
    try {
      const store = await getStore();

      // Only save the user-configurable parts (not status)
      const shortcutsToSave: Record<string, Partial<ShortcutConfig>> = {};
      for (const [id, config] of Object.entries(settings.shortcuts)) {
        shortcutsToSave[id] = {
          currentShortcut: config.currentShortcut,
          useHook: config.useHook,
        };
      }

      // Save version, shortcuts, and general settings
      await store.set('_version', SETTINGS_VERSION);
      await store.set('shortcuts', shortcutsToSave);
      await store.set('general', settings.general);
      await store.save();
    } catch (error) {
      throw error;
    }
  },

  updateShortcut: (id, shortcut) => {
    set((state) => ({
      settings: {
        ...state.settings,
        shortcuts: {
          ...state.settings.shortcuts,
          [id]: {
            ...state.settings.shortcuts[id],
            currentShortcut: shortcut,
            status: 'pending', // Will be updated after registration attempt
          },
        },
      },
    }));
  },

  updateShortcutStatus: (id, status) => {
    set((state) => ({
      settings: {
        ...state.settings,
        shortcuts: {
          ...state.settings.shortcuts,
          [id]: {
            ...state.settings.shortcuts[id],
            status,
          },
        },
      },
    }));
  },

  setShortcutUseHook: (id, useHook) => {
    set((state) => ({
      settings: {
        ...state.settings,
        shortcuts: {
          ...state.settings.shortcuts,
          [id]: {
            ...state.settings.shortcuts[id],
            useHook,
            status: 'pending', // Will need re-registration
          },
        },
      },
    }));
  },

  resetShortcut: (id) => {
    const defaultConfig = DEFAULT_SHORTCUTS[id];
    if (!defaultConfig) return;

    set((state) => ({
      settings: {
        ...state.settings,
        shortcuts: {
          ...state.settings.shortcuts,
          [id]: {
            ...defaultConfig,
            status: 'pending',
          },
        },
      },
    }));
  },

  resetAllShortcuts: () => {
    const shortcuts: Record<string, ShortcutConfig> = {};
    for (const [id, config] of Object.entries(DEFAULT_SHORTCUTS)) {
      shortcuts[id] = { ...config, status: 'pending' };
    }
    set((state) => ({
      settings: {
        ...state.settings,
        shortcuts,
      },
    }));
  },

  getShortcut: (id) => {
    return get().settings.shortcuts[id];
  },

  updateGeneralSettings: (updates) => {
    set((state) => ({
      settings: {
        ...state.settings,
        general: {
          ...state.settings.general,
          ...updates,
        },
      },
    }));
  },

  resetGeneralSettings: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        general: { ...DEFAULT_GENERAL_SETTINGS },
      },
    }));
  },

  openSettingsModal: (tab = 'general') => {
    set({ settingsModalOpen: true, activeTab: tab });
  },

  closeSettingsModal: () => {
    set({ settingsModalOpen: false });
    // Save settings when closing
    get().saveSettings();
  },

  setActiveTab: (tab) => {
    set({ activeTab: tab });
  },
}));

/**
 * Selector for all shortcuts as an array.
 * Useful for rendering shortcuts list in settings UI.
 *
 * @returns Array of all ShortcutConfig objects
 */
export const useShortcutsList = () => {
  const shortcuts = useSettingsStore((state) => state.settings.shortcuts);
  return Object.values(shortcuts);
};

/**
 * Selector for a specific shortcut by ID.
 *
 * @param id - The shortcut identifier (e.g., 'region_capture', 'fullscreen_capture')
 * @returns The ShortcutConfig for the given ID, or undefined if not found
 */
export const useShortcut = (id: string) => {
  return useSettingsStore((state) => state.settings.shortcuts[id]);
};
