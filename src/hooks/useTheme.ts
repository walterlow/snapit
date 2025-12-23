import { useEffect, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Theme } from '@/types';

/**
 * Hook for managing app theme (light/dark/system)
 * 
 * - Applies theme class to document root
 * - Listens for OS preference changes when theme is 'system'
 * - Persists to settings store
 */
export function useTheme() {
  const theme = useSettingsStore((s) => s.settings.general.theme);
  const updateGeneralSettings = useSettingsStore((s) => s.updateGeneralSettings);

  // Apply theme class to document root
  useEffect(() => {
    const root = document.documentElement;
    
    const applyTheme = (isDark: boolean) => {
      root.classList.toggle('dark', isDark);
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
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    updateGeneralSettings({ theme: newTheme });
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
