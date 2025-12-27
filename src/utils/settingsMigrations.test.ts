import { describe, it, expect } from 'vitest';
import {
  migrateSettings,
  mergeWithDefaults,
  needsMigration,
  SETTINGS_VERSION,
} from './settingsMigrations';
import { DEFAULT_SHORTCUTS, DEFAULT_GENERAL_SETTINGS } from '../types';

describe('settingsMigrations', () => {
  describe('migrateSettings', () => {
    it('should return default version for null settings', () => {
      const result = migrateSettings(null);
      expect(result._version).toBe(SETTINGS_VERSION);
    });

    it('should add version to unversioned settings', () => {
      const unversioned = {
        shortcuts: {},
        general: {},
      };

      const result = migrateSettings(unversioned);
      expect(result._version).toBe(SETTINGS_VERSION);
    });

    it('should preserve existing settings during migration', () => {
      const oldSettings = {
        _version: 0,
        shortcuts: {
          region_capture: {
            currentShortcut: 'Custom+Key',
            useHook: true,
          },
        },
        general: {
          defaultSaveDir: '/my/custom/path',
        },
      };

      const result = migrateSettings(oldSettings);
      expect(result.shortcuts?.region_capture?.currentShortcut).toBe('Custom+Key');
      expect(result.general?.defaultSaveDir).toBe('/my/custom/path');
    });

    it('should handle settings at current version', () => {
      const currentSettings = {
        _version: SETTINGS_VERSION,
        shortcuts: {},
        general: {},
      };

      const result = migrateSettings(currentSettings);
      expect(result._version).toBe(SETTINGS_VERSION);
    });
  });

  describe('mergeWithDefaults', () => {
    it('should fill in missing shortcuts from defaults', () => {
      const partial = {
        _version: SETTINGS_VERSION,
        shortcuts: {
          new_capture: {
            currentShortcut: 'Custom+Key',
          },
        },
      };

      const result = mergeWithDefaults(partial);

      // Custom shortcut preserved
      expect(result.shortcuts.new_capture.currentShortcut).toBe('Custom+Key');

      // Other shortcuts filled with defaults
      Object.keys(DEFAULT_SHORTCUTS).forEach((id) => {
        expect(result.shortcuts[id]).toBeDefined();
      });
    });

    it('should fill in missing general settings from defaults', () => {
      const partial = {
        _version: SETTINGS_VERSION,
        general: {
          defaultSaveDir: '/custom/path',
        },
      };

      const result = mergeWithDefaults(partial);

      // Custom setting preserved
      expect(result.general.defaultSaveDir).toBe('/custom/path');

      // Other settings filled with defaults
      expect(result.general.launchAtLogin).toBe(DEFAULT_GENERAL_SETTINGS.launchAtLogin);
      expect(result.general.showInSystemTray).toBe(DEFAULT_GENERAL_SETTINGS.showInSystemTray);
    });

    it('should always reset shortcut status to pending', () => {
      const withStatus = {
        _version: SETTINGS_VERSION,
        shortcuts: {
          new_capture: {
            currentShortcut: 'Ctrl+Shift+S',
            useHook: false,
            status: 'registered' as const,
          },
        },
      };

      const result = mergeWithDefaults(withStatus);
      expect(result.shortcuts.new_capture.status).toBe('pending');
    });

    it('should handle empty settings', () => {
      const empty = { _version: SETTINGS_VERSION };

      const result = mergeWithDefaults(empty);

      // All defaults applied
      expect(result.shortcuts).toEqual(
        Object.fromEntries(
          Object.entries(DEFAULT_SHORTCUTS).map(([id, config]) => [
            id,
            { ...config, status: 'pending' },
          ])
        )
      );
      expect(result.general).toEqual(DEFAULT_GENERAL_SETTINGS);
    });

    it('should ignore unknown shortcuts', () => {
      const withUnknown = {
        _version: SETTINGS_VERSION,
        shortcuts: {
          unknown_shortcut: {
            currentShortcut: 'Ctrl+X',
            useHook: false,
          },
        },
      };

      const result = mergeWithDefaults(withUnknown);

      // Unknown shortcut not included
      expect(result.shortcuts.unknown_shortcut).toBeUndefined();
    });
  });

  describe('needsMigration', () => {
    it('should return false for null settings', () => {
      expect(needsMigration(null)).toBe(false);
    });

    it('should return true for unversioned settings', () => {
      expect(needsMigration({ shortcuts: {} })).toBe(true);
    });

    it('should return true for old version', () => {
      expect(needsMigration({ _version: 0 })).toBe(true);
    });

    it('should return false for current version', () => {
      expect(needsMigration({ _version: SETTINGS_VERSION })).toBe(false);
    });

    it('should return false for future version', () => {
      expect(needsMigration({ _version: SETTINGS_VERSION + 1 })).toBe(false);
    });
  });

  describe('migration scenarios', () => {
    it('should handle full migration from v0 to current', () => {
      const v0Settings = {
        shortcuts: {
          new_capture: {
            currentShortcut: 'Ctrl+Shift+R',
            useHook: true,
          },
        },
        general: {
          launchAtLogin: true,
          showInSystemTray: true,
          defaultSaveDir: '/my/path',
        },
      };

      // Migrate
      const migrated = migrateSettings(v0Settings);
      expect(migrated._version).toBe(SETTINGS_VERSION);

      // Merge with defaults
      const final = mergeWithDefaults(migrated);

      // User settings preserved
      expect(final.shortcuts.new_capture.currentShortcut).toBe('Ctrl+Shift+R');
      expect(final.shortcuts.new_capture.useHook).toBe(true);
      expect(final.general.launchAtLogin).toBe(true);
      expect(final.general.defaultSaveDir).toBe('/my/path');

      // Missing shortcuts filled in
      Object.keys(DEFAULT_SHORTCUTS).forEach((id) => {
        expect(final.shortcuts[id]).toBeDefined();
      });
    });
  });
});
