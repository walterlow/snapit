/**
 * SettingsPopover - Settings gear icon with native Tauri menu
 *
 * Contains video settings (FPS, Quality), countdown, cursor capture toggle.
 * Native menus avoid popover clipping issues in transparent windows.
 */

import React, { useRef, useCallback } from 'react';
import { Settings } from 'lucide-react';
import { Menu, MenuItem, PredefinedMenuItem, CheckMenuItem, Submenu } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
import { settingsLogger } from '@/utils/logger';
import type { CaptureType } from '@/types';

interface SettingsPopoverProps {
  mode: CaptureType;
  disabled?: boolean;
  onOpenSettings?: () => void;
}

export const SettingsPopover: React.FC<SettingsPopoverProps> = ({
  mode,
  disabled = false,
  onOpenSettings,
}) => {
  const {
    settings,
    updateVideoSettings,
    updateGifSettings,
    updateScreenshotSettings,
  } = useCaptureSettingsStore();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Get current cursor setting based on mode
  const getCursorEnabled = useCallback(() => {
    switch (mode) {
      case 'screenshot': return settings.screenshot.includeCursor;
      case 'video': return settings.video.includeCursor;
      case 'gif': return settings.gif.includeCursor;
      default: return false;
    }
  }, [mode, settings]);

  // Update cursor setting for current mode
  const setCursorEnabled = useCallback((enabled: boolean) => {
    switch (mode) {
      case 'screenshot':
        updateScreenshotSettings({ includeCursor: enabled });
        break;
      case 'video':
        updateVideoSettings({ includeCursor: enabled });
        break;
      case 'gif':
        updateGifSettings({ includeCursor: enabled });
        break;
    }
  }, [mode, updateVideoSettings, updateGifSettings, updateScreenshotSettings]);

  // Get countdown setting
  const getCountdown = useCallback(() => {
    switch (mode) {
      case 'video': return settings.video.countdownSecs;
      case 'gif': return settings.gif.countdownSecs;
      default: return 0;
    }
  }, [mode, settings]);

  const setCountdown = useCallback((secs: number) => {
    switch (mode) {
      case 'video':
        updateVideoSettings({ countdownSecs: secs });
        break;
      case 'gif':
        updateGifSettings({ countdownSecs: secs });
        break;
    }
  }, [mode, updateVideoSettings, updateGifSettings]);

  // Open native menu
  const openMenu = useCallback(async () => {
    if (disabled) return;

    try {
      const menuItems: (MenuItem | PredefinedMenuItem | CheckMenuItem | Submenu)[] = [];

      // Header
      menuItems.push(await MenuItem.new({
        id: 'header',
        text: 'Settings',
        enabled: false
      }));
      menuItems.push(await PredefinedMenuItem.new({ item: 'Separator' }));

      // Video/GIF specific settings
      if (mode === 'video' || mode === 'gif') {
        // FPS submenu
        const currentFps = mode === 'video' ? settings.video.fps : settings.gif.fps;
        const fpsOptions = mode === 'video' ? [15, 24, 30, 60] : [10, 15, 20, 30];
        const fpsItems = await Promise.all(
          fpsOptions.map(fps =>
            CheckMenuItem.new({
              id: `fps-${fps}`,
              text: `${fps} fps`,
              checked: currentFps === fps,
              action: () => {
                if (mode === 'video') {
                  updateVideoSettings({ fps });
                } else {
                  updateGifSettings({ fps });
                }
              },
            })
          )
        );
        menuItems.push(await Submenu.new({
          id: 'fps-submenu',
          text: `Frame Rate: ${currentFps} fps`,
          items: fpsItems,
        }));

        // Quality submenu
        if (mode === 'video') {
          const qualityOptions = [40, 60, 80, 100];
          const qualityItems = await Promise.all(
            qualityOptions.map(q =>
              CheckMenuItem.new({
                id: `quality-${q}`,
                text: `${q}%`,
                checked: settings.video.quality === q,
                action: () => updateVideoSettings({ quality: q }),
              })
            )
          );
          menuItems.push(await Submenu.new({
            id: 'quality-submenu',
            text: `Quality: ${settings.video.quality}%`,
            items: qualityItems,
          }));
        } else {
          const presetLabels: Record<string, string> = { fast: 'Fast', balanced: 'Balanced', high: 'High' };
          const presetItems = await Promise.all(
            (['fast', 'balanced', 'high'] as const).map(preset =>
              CheckMenuItem.new({
                id: `preset-${preset}`,
                text: presetLabels[preset],
                checked: settings.gif.qualityPreset === preset,
                action: () => updateGifSettings({ qualityPreset: preset }),
              })
            )
          );
          menuItems.push(await Submenu.new({
            id: 'preset-submenu',
            text: `Quality: ${presetLabels[settings.gif.qualityPreset]}`,
            items: presetItems,
          }));
        }

        // Countdown submenu
        const countdownOptions = [0, 3, 5];
        const countdownLabels: Record<number, string> = { 0: 'Off', 3: '3 sec', 5: '5 sec' };
        const currentCountdown = getCountdown();
        const countdownItems = await Promise.all(
          countdownOptions.map(secs =>
            CheckMenuItem.new({
              id: `countdown-${secs}`,
              text: countdownLabels[secs],
              checked: currentCountdown === secs,
              action: () => setCountdown(secs),
            })
          )
        );
        menuItems.push(await Submenu.new({
          id: 'countdown-submenu',
          text: `Countdown: ${countdownLabels[currentCountdown]}`,
          items: countdownItems,
        }));

        menuItems.push(await PredefinedMenuItem.new({ item: 'Separator' }));
      }

      // Quick Capture toggle (video only) - saves directly, skips editor
      if (mode === 'video') {
        menuItems.push(await CheckMenuItem.new({
          id: 'quick-capture',
          text: 'Quick Capture (Skip Editor)',
          checked: settings.video.quickCapture,
          action: () => updateVideoSettings({ quickCapture: !settings.video.quickCapture }),
        }));
      }

      // Cursor capture toggle
      menuItems.push(await CheckMenuItem.new({
        id: 'cursor',
        text: 'Capture Cursor',
        checked: getCursorEnabled(),
        action: () => setCursorEnabled(!getCursorEnabled()),
      }));

      // Hide desktop icons toggle (video only)
      if (mode === 'video') {
        menuItems.push(await CheckMenuItem.new({
          id: 'hide-icons',
          text: 'Hide Desktop Icons',
          checked: settings.video.hideDesktopIcons,
          action: () => updateVideoSettings({ hideDesktopIcons: !settings.video.hideDesktopIcons }),
        }));
      }

      // Link to full settings
      if (onOpenSettings) {
        menuItems.push(await PredefinedMenuItem.new({ item: 'Separator' }));
        menuItems.push(await MenuItem.new({
          id: 'open-settings',
          text: 'Open Full Settings...',
          action: onOpenSettings,
        }));
      }

      const menu = await Menu.new({ items: menuItems });

      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        await menu.popup(new LogicalPosition(rect.right - 200, rect.bottom + 4));
      } else {
        await menu.popup();
      }
    } catch (error) {
      settingsLogger.error('Failed to open settings menu:', error);
    }
  }, [
    disabled,
    mode,
    settings,
    getCursorEnabled,
    setCursorEnabled,
    getCountdown,
    setCountdown,
    updateVideoSettings,
    updateGifSettings,
    onOpenSettings,
  ]);

  return (
    <button
      ref={buttonRef}
      onClick={openMenu}
      className="glass-settings-btn"
      disabled={disabled}
      title="Settings"
    >
      <Settings size={16} strokeWidth={1.5} />
    </button>
  );
};

export default SettingsPopover;
