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
import { hotkeyLogger } from './logger';

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
  new_capture: 'New Capture',
  fullscreen_capture: 'Fullscreen',
  all_monitors_capture: 'All Monitors',
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
    hotkeyLogger.error(`Failed to update tray shortcut for ${id}:`, error);
  }
}

/**
 * Update all tray menu shortcuts from current settings
 * Uses parallel updates for faster execution
 */
export async function updateAllTrayShortcuts(): Promise<void> {
  const shortcuts = useSettingsStore.getState().settings.shortcuts;

  // Update all tray shortcuts in parallel
  await Promise.allSettled(
    Object.values(shortcuts).map(config => 
      updateTrayShortcut(config.id, config.currentShortcut)
    )
  );
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
 * Uses parallel registration for faster startup
 */
export async function registerAllShortcuts(): Promise<void> {
  const shortcuts = useSettingsStore.getState().settings.shortcuts;

  // Register all shortcuts in parallel for faster startup
  await Promise.allSettled(
    Object.values(shortcuts).map(config => registerShortcut(config))
  );

  // Sync tray menu with current shortcuts (also in parallel)
  await updateAllTrayShortcuts();
}

/**
 * Unregister all shortcuts (both hook and plugin modes)
 */
export async function unregisterAllShortcuts(): Promise<void> {
  // Unregister all tauri plugin shortcuts
  try {
    await unregisterAll();
  } catch (error) {
    hotkeyLogger.error('Failed to unregister all plugin shortcuts:', error);
  }

  // Also unregister ALL hook-based shortcuts and clear listeners
  const shortcuts = useSettingsStore.getState().settings.shortcuts;
  for (const config of Object.values(shortcuts)) {
    // Clean up hook listener
    const listener = hookListeners.get(config.id);
    if (listener) {
      listener();
      hookListeners.delete(config.id);
    }

    // Unregister from Rust hook
    try {
      await invoke('unregister_shortcut_hook', { id: config.id });
    } catch {
      // Ignore errors during cleanup
    }
  }

  // Also try to unregister all hooks at once (belt and suspenders)
  try {
    await invoke('unregister_all_hooks');
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Switch between override mode and normal mode with clean handoff
 * This ensures no ghost registrations are left behind
 * @param allowOverride - Whether to enable override mode
 */
export async function setAllowOverride(allowOverride: boolean): Promise<void> {
  hotkeyLogger.info(`Switching override mode to: ${allowOverride}`);

  // First, unregister ALL shortcuts from BOTH mechanisms
  await unregisterAllShortcuts();

  // Small delay to ensure all unregistrations are processed
  await new Promise(resolve => setTimeout(resolve, 50));

  // Update the setting in the store
  const store = useSettingsStore.getState();
  store.updateGeneralSettings({ allowOverride });

  // Re-register all shortcuts using the new mode
  await registerAllShortcuts();

  hotkeyLogger.info(`Override mode switch complete`);
}

/**
 * Update and re-register a shortcut with rollback on failure
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
    hotkeyLogger.error(`Shortcut ${id} not found`);
    return 'error';
  }

  // Store original shortcut for rollback
  const originalShortcut = config.currentShortcut;

  // Validate the new shortcut using robust validation
  const validation = validateShortcutString(newShortcut);
  if (!validation.valid) {
    hotkeyLogger.error(`Invalid shortcut: ${validation.error}`);
    return 'error';
  }

  // Also check basic format
  if (!isValidShortcut(newShortcut)) {
    hotkeyLogger.error(`Invalid shortcut format: ${newShortcut}`);
    return 'error';
  }

  // Check for internal conflicts (already used by another shortcut)
  const shortcuts = store.settings.shortcuts;
  for (const [otherId, otherConfig] of Object.entries(shortcuts)) {
    if (otherId !== id && otherConfig.currentShortcut === newShortcut) {
      hotkeyLogger.error(`Shortcut ${newShortcut} is already used by ${otherId}`);
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

  // If registration failed, rollback to original shortcut
  if (status === 'error' || status === 'conflict') {
    hotkeyLogger.warn(`Registration failed for ${newShortcut}, rolling back to ${originalShortcut}`);

    // Restore original in store
    store.updateShortcut(id, originalShortcut);

    // Try to re-register original
    const rollbackConfig = store.settings.shortcuts[id];
    const rollbackStatus = await registerShortcut(rollbackConfig);

    // Update tray with original
    await updateTrayShortcut(id, originalShortcut);

    // Return the original failure status (user should know it failed)
    return rollbackStatus === 'registered' ? status : 'error';
  }

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
 * Validate shortcut string for robustness
 * Ensures the shortcut has at least one non-modifier key
 * @param shortcut - The shortcut string to validate
 * @returns Object with valid status and optional error message
 */
export function validateShortcutString(shortcut: string): { valid: boolean; error?: string } {
  if (!shortcut || typeof shortcut !== 'string') {
    return { valid: false, error: 'Shortcut cannot be empty' };
  }

  const parts = shortcut.split('+').map((p) => p.trim().toLowerCase());
  if (parts.length === 0) {
    return { valid: false, error: 'Invalid shortcut format' };
  }

  const modifierKeys = ['ctrl', 'control', 'alt', 'shift', 'meta', 'command', 'cmd', 'super', 'win', 'commandorcontrol'];

  // Check if there's at least one non-modifier key
  const hasNonModifier = parts.some((part) => !modifierKeys.includes(part));

  if (!hasNonModifier) {
    return { valid: false, error: 'Shortcut must contain at least one non-modifier key' };
  }

  return { valid: true };
}

/**
 * Suspend a shortcut temporarily (for editing without triggering)
 * @param id - The shortcut ID to suspend
 */
export async function suspendShortcut(id: string): Promise<void> {
  const store = useSettingsStore.getState();
  const allowOverride = store.settings.general.allowOverride;

  // If using hooks (override mode), suspend via Rust
  if (allowOverride) {
    try {
      await invoke('suspend_shortcut', { id });
    } catch (error) {
      hotkeyLogger.error(`Failed to suspend shortcut ${id}:`, error);
    }
  }

  // Also unregister from tauri plugin if registered there
  const config = store.settings.shortcuts[id];
  if (config) {
    try {
      const registered = await isRegistered(config.currentShortcut);
      if (registered) {
        await unregister(config.currentShortcut);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Resume a suspended shortcut (re-register after editing)
 * @param id - The shortcut ID to resume
 */
export async function resumeShortcut(id: string): Promise<void> {
  const store = useSettingsStore.getState();
  const config = store.settings.shortcuts[id];

  if (!config) {
    hotkeyLogger.error(`Cannot resume shortcut ${id}: not found`);
    return;
  }

  // Re-register the shortcut
  await registerShortcut(config);
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
    hotkeyLogger.error('Error checking shortcut conflict:', error);
    // Registration threw an error - likely a conflict
    return 'conflict';
  }
}
