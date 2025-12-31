import { useEffect, useCallback, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Theme } from '@/types';

/**
 * Hook for managing app theme (light/dark/system)
 *
 * - Applies theme class to document root
 * - Listens for OS preference changes when theme is 'system'
 * - Persists to settings store
 * - Syncs theme across all windows via Tauri events
 */
export function useTheme() {
  const theme = useSettingsStore((s) => s.settings.general.theme);
  const updateGeneralSettings = useSettingsStore((s) => s.updateGeneralSettings);
  const isExternalUpdate = useRef(false);

  // Apply theme class to document root
  useEffect(() => {
    const root = document.documentElement;
    
    const applyTheme = (isDark: boolean) => {
      // Disable ALL transitions during theme switch for instant change
      root.style.setProperty('--theme-transition', 'none');
      root.classList.add('no-transitions');

      // Toggle both dark and light classes
      root.classList.toggle('dark', isDark);
      root.classList.toggle('light', !isDark);

      // Re-enable transitions after paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          root.classList.remove('no-transitions');
          root.style.removeProperty('--theme-transition');
        });
      });
    };

    if (theme === 'system') {
      // Check OS preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(prefersDark);
    } else {
      applyTheme(theme === 'dark');
    }
  }, [theme]);

  // Listen for system theme changes when theme is 'system'
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.classList.toggle('dark', e.matches);
      document.documentElement.classList.toggle('light', !e.matches);
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [theme]);

  // Listen for theme changes from other windows
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<{ theme: Theme }>('theme-changed', (event) => {
      // Update local state without emitting again
      isExternalUpdate.current = true;
      updateGeneralSettings({ theme: event.payload.theme });
      isExternalUpdate.current = false;
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [updateGeneralSettings]);

  const setTheme = useCallback((newTheme: Theme) => {
    updateGeneralSettings({ theme: newTheme });
    // Emit event to sync other windows (unless this is from an external update)
    if (!isExternalUpdate.current) {
      emit('theme-changed', { theme: newTheme }).catch(console.error);
    }
  }, [updateGeneralSettings]);

  // Toggle between light and dark (skips system)
  const toggleTheme = useCallback(() => {
    const isDark = theme === 'dark' || 
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(isDark ? 'light' : 'dark');
  }, [theme, setTheme]);

  // Get the resolved theme (light or dark, never 'system')
  const resolvedTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  return { 
    theme,           // The setting value: 'light' | 'dark' | 'system'
    resolvedTheme,   // The actual applied theme: 'light' | 'dark'
    setTheme, 
    toggleTheme 
  };
}
