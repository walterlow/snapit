import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';
import { useSettingsStore } from '../stores/settingsStore';

describe('useTheme', () => {
  beforeEach(() => {
    // Reset the settings store before each test
    useSettingsStore.setState({
      settings: {
        shortcuts: {},
        general: {
          startWithWindows: false,
          minimizeToTray: true,
          showNotifications: true,
          defaultSaveDir: null,
          imageFormat: 'png',
          jpgQuality: 85,
          allowOverride: false,
          theme: 'light',
        },
      },
    });
    
    // Clear document classes
    document.documentElement.classList.remove('dark', 'light', 'no-transitions');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return current theme from store', () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        general: { ...state.settings.general, theme: 'dark' },
      },
    }));

    const { result } = renderHook(() => useTheme());
    
    expect(result.current.theme).toBe('dark');
  });

  it('should apply dark class when theme is dark', () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        general: { ...state.settings.general, theme: 'dark' },
      },
    }));

    renderHook(() => useTheme());
    
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('should apply light class when theme is light', () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        general: { ...state.settings.general, theme: 'light' },
      },
    }));

    renderHook(() => useTheme());
    
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('should resolve theme based on system preference when theme is system', () => {
    // Mock system preference to dark
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        general: { ...state.settings.general, theme: 'system' },
      },
    }));

    const { result } = renderHook(() => useTheme());
    
    expect(result.current.theme).toBe('system');
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('should change theme via setTheme', () => {
    const { result } = renderHook(() => useTheme());
    
    act(() => {
      result.current.setTheme('dark');
    });
    
    expect(result.current.theme).toBe('dark');
  });

  it('should toggle between light and dark', () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        general: { ...state.settings.general, theme: 'light' },
      },
    }));

    const { result } = renderHook(() => useTheme());
    
    expect(result.current.theme).toBe('light');
    
    act(() => {
      result.current.toggleTheme();
    });
    
    expect(result.current.theme).toBe('dark');
    
    act(() => {
      result.current.toggleTheme();
    });
    
    expect(result.current.theme).toBe('light');
  });

  it('should toggle from system to appropriate theme', () => {
    // Mock system preference to dark
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        general: { ...state.settings.general, theme: 'system' },
      },
    }));

    const { result } = renderHook(() => useTheme());
    
    // System is dark, toggle should go to light
    act(() => {
      result.current.toggleTheme();
    });
    
    expect(result.current.theme).toBe('light');
  });
});
