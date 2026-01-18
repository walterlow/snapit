/**
 * DevicePopover - Camera device selector using native Tauri menu
 *
 * Shows current camera status, opens native menu with device list.
 * Native menus avoid popover clipping issues in transparent windows.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Video, VideoOff, ChevronDown } from 'lucide-react';
import { Menu, MenuItem, PredefinedMenuItem, CheckMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { useWebcamSettingsStore } from '@/stores/webcamSettingsStore';
import { webcamLogger } from '@/utils/logger';

interface DevicePopoverProps {
  disabled?: boolean;
}

export const DevicePopover: React.FC<DevicePopoverProps> = ({ disabled = false }) => {
  const {
    settings,
    devices,
    loadDevices,
    setEnabled,
    setDevice,
  } = useWebcamSettingsStore();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Debug: log when settings.enabled changes
  useEffect(() => {
    webcamLogger.info('DevicePopover: settings.enabled changed to', settings.enabled);
  }, [settings.enabled]);

  // Load devices on mount
  useEffect(() => {
    if (devices.length === 0) {
      loadDevices();
    }
  }, [devices.length, loadDevices]);

  const currentDevice = devices.find((d) => d.index === settings.deviceIndex);
  const displayName = settings.enabled
    ? currentDevice?.name || 'Camera'
    : 'No camera';

  // Truncate display name for button
  const truncatedName = displayName.length > 12
    ? displayName.substring(0, 12) + '…'
    : displayName;

  const handleSelectDevice = useCallback(async (deviceIndex: number | null) => {
    if (deviceIndex === null) {
      await setEnabled(false);
    } else {
      await setDevice(deviceIndex);
      if (!settings.enabled) {
        await setEnabled(true);
      }
    }
  }, [settings.enabled, setEnabled, setDevice]);

  // Open native menu
  const openMenu = useCallback(async () => {
    if (disabled) return;

    // Refresh devices in background (don't block menu)
    loadDevices();

    try {
      const items = await Promise.all([
        // Header
        MenuItem.new({
          id: 'header',
          text: 'Camera',
          enabled: false
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // No camera option
        CheckMenuItem.new({
          id: 'no-camera',
          text: 'No camera',
          checked: !settings.enabled,
          action: () => handleSelectDevice(null),
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // Device list
        ...devices.map((device) =>
          CheckMenuItem.new({
            id: `device-${device.index}`,
            text: device.name.length > 40 ? device.name.substring(0, 40) + '…' : device.name,
            checked: settings.enabled && settings.deviceIndex === device.index,
            action: () => handleSelectDevice(device.index),
          })
        ),
        // Refresh option
        PredefinedMenuItem.new({ item: 'Separator' }),
        MenuItem.new({
          id: 'refresh',
          text: 'Refresh Devices',
          action: loadDevices,
        }),
      ]);

      const menu = await Menu.new({ items });

      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
      } else {
        await menu.popup();
      }
    } catch (error) {
      webcamLogger.error('Failed to open camera menu:', error);
    }
  }, [disabled, devices, settings.enabled, settings.deviceIndex, loadDevices, handleSelectDevice]);

  return (
    <button
      ref={buttonRef}
      onClick={openMenu}
      className={`glass-device-btn ${settings.enabled ? 'glass-device-btn--active' : ''}`}
      disabled={disabled}
    >
      {settings.enabled ? (
        <Video size={14} strokeWidth={1.5} />
      ) : (
        <VideoOff size={14} strokeWidth={1.5} />
      )}
      <span className="glass-device-label">{truncatedName}</span>
      <ChevronDown size={12} className="glass-device-chevron" />
    </button>
  );
};

