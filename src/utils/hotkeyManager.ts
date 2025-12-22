/**
 * Hotkey Manager - Handles global shortcut registration with conflict detection
 *
 * This module provides:
 * - Registration/unregistration of global shortcuts
 * - Conflict detection (when another app has the shortcut)
 * - Shortcut validation
 * - Integration with the settings store
 */

import {
  register,
  unregister,
  unregisterAll,
  isRegistered,
} from '@tauri-apps/plugin-global-shortcut';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useSettingsStore } from '../stores/settingsStore';
import type { ShortcutConfig, ShortcutStatus } from '../types';

// Store unlisten functions for hook-based event listeners
const hookListeners: Map<string, UnlistenFn> = new Map();

// Valid modifier keys
const VALID_MODIFIERS = [
  'CommandOrControl',
  'Command',
  'Control',
  'Ctrl',
  'Alt',
  'Shift',
  'Super',
  'Meta',
];

// Valid single keys (subset - add more as needed)
const VALID_KEYS = [
  // Letters
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  // Numbers
  ...'0123456789'.split(''),
  // Function keys
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  // Special keys
  'Space', 'Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PrintScreen', 'ScrollLock', 'Pause',
];

/**
 * Validate shortcut format
 * @param shortcut - The shortcut string to validate (e.g., "Ctrl+Shift+S" or "PrintScreen")
 * @returns true if valid, false otherwise
 */
export function isValidShortcut(shortcut: string): boolean {
  if (!shortcut || typeof shortcut !== 'string') return false;

  const parts = shortcut.split('+').map((p) => p.trim());
  if (parts.length < 1) return false;

  // Check if the last part is a valid key (case-insensitive comparison)
  const key = parts[parts.length - 1];
  const keyUpper = key.toUpperCase();
  const hasValidKey = VALID_KEYS.some(
    (validKey) => validKey.toUpperCase() === keyUpper
  ) || key.length === 1;
  if (!hasValidKey) return false;

  // If there are modifiers, verify they are valid
  if (parts.length > 1) {
    const modifiers = parts.slice(0, -1);
    const allModifiersValid = modifiers.every((mod) =>
      VALID_MODIFIERS.some(
        (valid) => valid.toLowerCase() === mod.toLowerCase()
      )
    );
    if (!allModifiersValid) return false;
  }

  return true;
}

/**
 * Normalize shortcut format for consistency
 * @param shortcut - The shortcut string to normalize
 * @returns Normalized shortcut string
 */
export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split('+').map((p) => p.trim());
  const key = parts[parts.length - 1].toUpperCase();
  const modifiers = parts.slice(0, -1);

  // Normalize modifiers
  const normalizedMods = modifiers.map((mod) => {
    const lower = mod.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
    if (lower === 'commandorcontrol') return 'CommandOrControl';
    if (lower === 'command' || lower === 'meta') return 'Command';
    if (lower === 'alt') return 'Alt';
    if (lower === 'shift') return 'Shift';
    if (lower === 'super') return 'Super';
    return mod;
  });

  return [...normalizedMods, key].join('+');
}

/**
 * Parse a KeyboardEvent into a shortcut string
 * @param event - The keyboard event
 * @returns Shortcut string or null if invalid
 */
export function parseKeyboardEvent(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];

  if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  // Get the key
  let key = event.key;

  // Ignore modifier-only presses
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    return null;
  }

  // Normalize key
  if (key.length === 1) {
    key = key.toUpperCase();
  } else if (key === ' ') {
    key = 'Space';
  }

  // Must have at least one modifier
  if (modifiers.length === 0) {
    return null;
  }

  return [...modifiers, key].join('+');
}

/**
 * Format shortcut for display (human-readable)
 * @param shortcut - The shortcut string
 * @returns Formatted display string
 */
export function formatShortcutForDisplay(shortcut: string): string {
  return shortcut
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Shift/g, 'Shift')
    .replace(/Alt/g, 'Alt');
}

/**
 * Tray menu display names for shortcuts
 */
const TRAY_MENU_NAMES: Record<string, string> = {
  region_capture: 'Region Capture',
  fullscreen_capture: 'Fullscreen',
};

/**
 * Update tray menu item text for a shortcut
 * @param id - The shortcut ID
 * @param shortcut - The shortcut string
 */
export async function updateTrayShortcut(id: string, shortcut: string): Promise<void> {
  const baseName = TRAY_MENU_NAMES[id];
  if (!baseName) return; // Not a tray menu shortcut

  const displayText = `${baseName} (${formatShortcutForDisplay(shortcut)})`;

  try {
    await invoke('update_tray_shortcut', { shortcutId: id, displayText });
  } catch (error) {
    console.error(`Failed to update tray shortcut for ${id}:`, error);
  }
}

/**
 * Update all tray menu shortcuts from current settings
 */
export async function updateAllTrayShortcuts(): Promise<void> {
  const shortcuts = useSettingsStore.getState().settings.shortcuts;

  for (const config of Object.values(shortcuts)) {
    await updateTrayShortcut(config.id, config.currentShortcut);
  }
}

/**
 * Shortcut action handlers mapped by ID
 */
type ShortcutHandler = () => void | Promise<void>;
const shortcutHandlers: Map<string, ShortcutHandler> = new Map();

/**
 * Register a shortcut handler
 * @param id - The shortcut ID
 * @param handler - The function to call when shortcut is triggered
 */
export function setShortcutHandler(id: string, handler: ShortcutHandler): void {
  shortcutHandlers.set(id, handler);
}

/**
 * Get the handler for a shortcut
 * @param id - The shortcut ID
 */
export function getShortcutHandler(id: string): ShortcutHandler | undefined {
  return shortcutHandlers.get(id);
}

/**
 * Try to register a shortcut and detect conflicts
 * @param config - The shortcut configuration
 * @returns The registration status
 */
export async function registerShortcut(
  config: ShortcutConfig
): Promise<ShortcutStatus> {
  const { id, currentShortcut } = config;
  const store = useSettingsStore.getState();
  const updateStatus = store.updateShortcutStatus;
  const allowOverride = store.settings.general.allowOverride;

  // When allowOverride is ON, use hooks directly (can override other apps)
  if (allowOverride) {
    try {
      // First, clean up any tauri plugin registration to prevent duplicates
      try {
        const pluginRegistered = await isRegistered(currentShortcut);
        if (pluginRegistered) {
          await unregister(currentShortcut);
        }
      } catch {
        // Ignore errors during cleanup
      }

      // Remove any existing hook listener for this shortcut
      const existingListener = hookListeners.get(id);
      if (existingListener) {
        existingListener();
        hookListeners.delete(id);
      }

      // Set up listener for events from Rust hook
      const unlisten = await listen(`shortcut-${id}`, () => {
        const handler = shortcutHandlers.get(id);
        if (handler) {
          handler();
        }
      });
      hookListeners.set(id, unlisten);

      // Register the hook with Rust
      await invoke('register_shortcut_with_hook', { id, shortcut: currentShortcut });
      updateStatus(id, 'registered');
      return 'registered';
    } catch {
      updateStatus(id, 'conflict');
      return 'conflict';
    }
  }

  // When allowOverride is OFF, use normal registration (respects other apps)
  try {
    // First, clean up any hook registration to prevent duplicates
    try {
      const existingListener = hookListeners.get(id);
      if (existingListener) {
        existingListener();
        hookListeners.delete(id);
      }
      await invoke('unregister_shortcut_hook', { id });
    } catch {
      // Ignore errors during cleanup
    }

    const alreadyRegistered = await isRegistered(currentShortcut);
    if (alreadyRegistered) {
      await unregister(currentShortcut);
    }

    await register(currentShortcut, (event) => {
      if (event.state === 'Pressed') {
        const handler = shortcutHandlers.get(id);
        if (handler) {
          handler();
        } else {
          emit(`shortcut-${id}`, { shortcut: currentShortcut });
        }
      }
    });

    const registered = await isRegistered(currentShortcut);
    if (registered) {
      updateStatus(id, 'registered');
      return 'registered';
    }

    updateStatus(id, 'conflict');
    return 'conflict';
  } catch {
    updateStatus(id, 'conflict');
    return 'conflict';
  }
}

/**
 * Unregister a shortcut
 * @param config - The shortcut configuration
 */
export async function unregisterShortcut(config: ShortcutConfig): Promise<void> {
  const { id, currentShortcut } = config;

  // Clean up BOTH registration mechanisms to ensure complete cleanup
  // regardless of which method was actually used

  // Clean up hook-based registration
  try {
    const listener = hookListeners.get(id);
    if (listener) {
      listener();
      hookListeners.delete(id);
    }
    await invoke('unregister_shortcut_hook', { id });
  } catch {
    // Ignore errors during cleanup
  }

  // Clean up tauri plugin registration
  try {
    const registered = await isRegistered(currentShortcut);
    if (registered) {
      await unregister(currentShortcut);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Register all shortcuts from the settings store
 */
export async function registerAllShortcuts(): Promise<void> {
  const shortcuts = useSettingsStore.getState().settings.shortcuts;

  for (const config of Object.values(shortcuts)) {
    await registerShortcut(config);
  }

  // Sync tray menu with current shortcuts
  await updateAllTrayShortcuts();
}

/**
 * Unregister all shortcuts
 */
export async function unregisterAllShortcuts(): Promise<void> {
  try {
    await unregisterAll();
  } catch (error) {
    console.error('Failed to unregister all shortcuts:', error);
  }

  // Also unregister any hook-based shortcuts
  const shortcuts = useSettingsStore.getState().settings.shortcuts;
  for (const config of Object.values(shortcuts)) {
    if (config.useHook) {
      try {
        await invoke('unregister_shortcut_hook', { id: config.id });
      } catch (error) {
        // Ignore errors during cleanup
      }
    }
  }
}

/**
 * Update and re-register a shortcut
 * @param id - The shortcut ID
 * @param newShortcut - The new shortcut string
 * @returns The registration status
 */
export async function updateShortcut(
  id: string,
  newShortcut: string
): Promise<ShortcutStatus> {
  const store = useSettingsStore.getState();
  const config = store.settings.shortcuts[id];

  if (!config) {
    console.error(`Shortcut ${id} not found`);
    return 'error';
  }

  // Validate the new shortcut
  if (!isValidShortcut(newShortcut)) {
    console.error(`Invalid shortcut format: ${newShortcut}`);
    return 'error';
  }

  // Check for internal conflicts (already used by another shortcut)
  const shortcuts = store.settings.shortcuts;
  for (const [otherId, otherConfig] of Object.entries(shortcuts)) {
    if (otherId !== id && otherConfig.currentShortcut === newShortcut) {
      console.error(`Shortcut ${newShortcut} is already used by ${otherId}`);
      return 'conflict';
    }
  }

  // Unregister old shortcut
  await unregisterShortcut(config);

  // Update the store
  store.updateShortcut(id, newShortcut);

  // Register the new shortcut
  const updatedConfig = store.settings.shortcuts[id];
  const status = await registerShortcut(updatedConfig);

  // Update tray menu to reflect the new shortcut
  await updateTrayShortcut(id, newShortcut);

  return status;
}

/**
 * Check if a shortcut string conflicts with existing shortcuts
 * @param shortcut - The shortcut to check
 * @param excludeId - Optional ID to exclude from the check
 * @returns true if there's a conflict
 */
export function hasInternalConflict(
  shortcut: string,
  excludeId?: string
): boolean {
  const shortcuts = useSettingsStore.getState().settings.shortcuts;

  for (const [id, config] of Object.entries(shortcuts)) {
    if (id !== excludeId && config.currentShortcut === shortcut) {
      return true;
    }
  }

  return false;
}

/**
 * Get display-friendly shortcut info
 * @param id - The shortcut ID
 */
export function getShortcutInfo(id: string): {
  shortcut: string;
  display: string;
  status: ShortcutStatus;
} | null {
  const config = useSettingsStore.getState().settings.shortcuts[id];
  if (!config) return null;

  return {
    shortcut: config.currentShortcut,
    display: formatShortcutForDisplay(config.currentShortcut),
    status: config.status,
  };
}

/**
 * Check if a shortcut conflicts with another app (without committing)
 * Returns: 'available' | 'conflict' | 'internal_conflict' | 'error'
 */
export async function checkShortcutConflict(
  shortcut: string,
  excludeId?: string
): Promise<'available' | 'conflict' | 'internal_conflict' | 'error'> {
  // First check internal conflicts (within SnapIt)
  if (hasInternalConflict(shortcut, excludeId)) {
    return 'internal_conflict';
  }

  // Try to register temporarily to detect external conflicts
  try {
    // Check if already registered by us
    const alreadyRegistered = await isRegistered(shortcut);
    
    if (alreadyRegistered) {
      // Already registered by SnapIt - available
      return 'available';
    }

    // Try to register
    await register(shortcut, () => {});
    
    // Check if registration succeeded
    const nowRegistered = await isRegistered(shortcut);
    
    // Unregister immediately (we're just testing)
    try {
      await unregister(shortcut);
    } catch {
      // Ignore unregister errors
    }
    
    if (nowRegistered) {
      return 'available';
    } else {
      return 'conflict';
    }
  } catch (error) {
    console.error('Error checking shortcut conflict:', error);
    // Registration threw an error - likely a conflict
    return 'conflict';
  }
}
