import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, DEFAULT_GENERAL_SETTINGS } from '../types';

// Mock the Tauri store
const mockStore: Record<string, unknown> = {};
vi.mock('@tauri-apps/plugin-store', () => {
  return {
    LazyStore: class MockLazyStore {
      get(key: string) {
        return Promise.resolve(mockStore[key]);
      }
      set(key: string, value: unknown) {
        mockStore[key] = value;
        return Promise.resolve();
      }
      save() {
        return Promise.resolve();
      }
    },
  };
});

describe('settingsStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      isLoading: false,
      isInitialized: false,
      settingsModalOpen: false,
      activeTab: 'general',
    });
  });

  describe('initial state', () => {
    it('should have default settings', () => {
      const { settings } = useSettingsStore.getState();
      expect(settings.general).toEqual(DEFAULT_GENERAL_SETTINGS);
      expect(Object.keys(settings.shortcuts)).toEqual(Object.keys(DEFAULT_SHORTCUTS));
    });

    it('should not be initialized on creation', () => {
      expect(useSettingsStore.getState().isInitialized).toBe(false);
    });
  });

  describe('shortcut management', () => {
    it('should update a shortcut', () => {
      const { updateShortcut, settings } = useSettingsStore.getState();
      const shortcutId = Object.keys(settings.shortcuts)[0];

      updateShortcut(shortcutId, 'Ctrl+Alt+T');

      const updated = useSettingsStore.getState().settings.shortcuts[shortcutId];
      expect(updated.currentShortcut).toBe('Ctrl+Alt+T');
      expect(updated.status).toBe('pending');
    });

    it('should update shortcut status', () => {
      const { updateShortcutStatus, settings } = useSettingsStore.getState();
      const shortcutId = Object.keys(settings.shortcuts)[0];

      updateShortcutStatus(shortcutId, 'registered');

      const updated = useSettingsStore.getState().settings.shortcuts[shortcutId];
      expect(updated.status).toBe('registered');
    });

    it('should toggle useHook for a shortcut', () => {
      const { setShortcutUseHook, settings } = useSettingsStore.getState();
      const shortcutId = Object.keys(settings.shortcuts)[0];
      const originalUseHook = settings.shortcuts[shortcutId].useHook;

      setShortcutUseHook(shortcutId, !originalUseHook);

      const updated = useSettingsStore.getState().settings.shortcuts[shortcutId];
      expect(updated.useHook).toBe(!originalUseHook);
      expect(updated.status).toBe('pending');
    });

    it('should reset a single shortcut to default', () => {
      const { updateShortcut, resetShortcut, settings } = useSettingsStore.getState();
      const shortcutId = Object.keys(settings.shortcuts)[0];
      const defaultShortcut = DEFAULT_SHORTCUTS[shortcutId].currentShortcut;

      updateShortcut(shortcutId, 'CustomShortcut');
      resetShortcut(shortcutId);

      const reset = useSettingsStore.getState().settings.shortcuts[shortcutId];
      expect(reset.currentShortcut).toBe(defaultShortcut);
      expect(reset.status).toBe('pending');
    });

    it('should reset all shortcuts to defaults', () => {
      const { updateShortcut, resetAllShortcuts, settings } = useSettingsStore.getState();

      // Modify multiple shortcuts
      Object.keys(settings.shortcuts).forEach((id, i) => {
        updateShortcut(id, `Custom${i}`);
      });

      resetAllShortcuts();

      const resetSettings = useSettingsStore.getState().settings.shortcuts;
      Object.entries(resetSettings).forEach(([id, config]) => {
        expect(config.currentShortcut).toBe(DEFAULT_SHORTCUTS[id].currentShortcut);
        expect(config.status).toBe('pending');
      });
    });

    it('should get a specific shortcut', () => {
      const { getShortcut, settings } = useSettingsStore.getState();
      const shortcutId = Object.keys(settings.shortcuts)[0];

      const shortcut = getShortcut(shortcutId);
      expect(shortcut).toBeDefined();
      expect(shortcut?.id).toBe(shortcutId);
    });

    it('should return undefined for non-existent shortcut', () => {
      const { getShortcut } = useSettingsStore.getState();
      const shortcut = getShortcut('nonexistent');
      expect(shortcut).toBeUndefined();
    });
  });

  describe('general settings management', () => {
    it('should update general settings', () => {
      const { updateGeneralSettings } = useSettingsStore.getState();

      updateGeneralSettings({
        showInSystemTray: true,
        defaultSaveDir: '/custom/path',
      });

      const { general } = useSettingsStore.getState().settings;
      expect(general.showInSystemTray).toBe(true);
      expect(general.defaultSaveDir).toBe('/custom/path');
    });

    it('should preserve other settings when updating', () => {
      const { updateGeneralSettings, settings } = useSettingsStore.getState();
      const originalLaunchAtLogin = settings.general.launchAtLogin;

      updateGeneralSettings({ showInSystemTray: true });

      const { general } = useSettingsStore.getState().settings;
      expect(general.launchAtLogin).toBe(originalLaunchAtLogin);
    });

    it('should reset general settings to defaults', () => {
      const { updateGeneralSettings, resetGeneralSettings } = useSettingsStore.getState();

      updateGeneralSettings({
        showInSystemTray: true,
        defaultSaveDir: '/custom/path',
      });

      resetGeneralSettings();

      const { general } = useSettingsStore.getState().settings;
      expect(general).toEqual(DEFAULT_GENERAL_SETTINGS);
    });
  });

  describe('modal UI state', () => {
    it('should open settings modal with default tab', () => {
      const { openSettingsModal } = useSettingsStore.getState();

      openSettingsModal();

      const state = useSettingsStore.getState();
      expect(state.settingsModalOpen).toBe(true);
      expect(state.activeTab).toBe('general');
    });

    it('should open settings modal with specific tab', () => {
      const { openSettingsModal } = useSettingsStore.getState();

      openSettingsModal('shortcuts');

      const state = useSettingsStore.getState();
      expect(state.settingsModalOpen).toBe(true);
      expect(state.activeTab).toBe('shortcuts');
    });

    it('should close settings modal', () => {
      const { openSettingsModal, closeSettingsModal } = useSettingsStore.getState();

      openSettingsModal();
      closeSettingsModal();

      expect(useSettingsStore.getState().settingsModalOpen).toBe(false);
    });

    it('should switch active tab', () => {
      const { setActiveTab } = useSettingsStore.getState();

      setActiveTab('shortcuts');
      expect(useSettingsStore.getState().activeTab).toBe('shortcuts');

      setActiveTab('general');
      expect(useSettingsStore.getState().activeTab).toBe('general');
    });
  });
});
