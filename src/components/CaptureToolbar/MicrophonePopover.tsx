/**
 * MicrophonePopover - Microphone device selector using native Tauri menu
 *
 * Shows current microphone status, opens native menu with device list.
 * Native menus avoid popover clipping issues in transparent windows.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, ChevronDown } from 'lucide-react';
import { Menu, MenuItem, PredefinedMenuItem, CheckMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { useAudioInputStore } from '@/stores/audioInputStore';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
import { audioLogger } from '@/utils/logger';

interface MicrophonePopoverProps {
  disabled?: boolean;
}

export const MicrophonePopover: React.FC<MicrophonePopoverProps> = ({ disabled = false }) => {
  const { devices, loadDevices } = useAudioInputStore();
  const { settings, updateVideoSettings } = useCaptureSettingsStore();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selectedDeviceIndex = settings.video.microphoneDeviceIndex;
  const isEnabled = selectedDeviceIndex !== null;

  // Load devices on mount
  useEffect(() => {
    if (devices.length === 0) {
      loadDevices();
    }
  }, [devices.length, loadDevices]);

  const currentDevice = devices.find((d) => d.index === selectedDeviceIndex);
  const displayName = isEnabled
    ? currentDevice?.name || 'Microphone'
    : 'Mic Muted';

  // Truncate display name for button
  const truncatedName = displayName.length > 12
    ? displayName.substring(0, 12) + '…'
    : displayName;

  const handleSelectDevice = useCallback((deviceIndex: number | null) => {
    updateVideoSettings({ microphoneDeviceIndex: deviceIndex });
  }, [updateVideoSettings]);

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
          text: 'Microphone',
          enabled: false
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // Mute option
        CheckMenuItem.new({
          id: 'mute',
          text: 'Mute Microphone',
          checked: !isEnabled,
          action: () => handleSelectDevice(null),
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // Device list
        ...devices.map((device) =>
          CheckMenuItem.new({
            id: `device-${device.index}`,
            text: device.isDefault
              ? `${device.name} ★`
              : device.name,
            checked: selectedDeviceIndex === device.index,
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
      audioLogger.error('Failed to open microphone menu:', error);
    }
  }, [disabled, devices, isEnabled, selectedDeviceIndex, loadDevices, handleSelectDevice]);

  return (
    <button
      ref={buttonRef}
      onClick={openMenu}
      className={`glass-device-btn ${isEnabled ? 'glass-device-btn--active' : ''}`}
      disabled={disabled}
    >
      {isEnabled ? (
        <Mic size={14} strokeWidth={1.5} />
      ) : (
        <MicOff size={14} strokeWidth={1.5} />
      )}
      <span className="glass-device-label">{truncatedName}</span>
      <ChevronDown size={12} className="glass-device-chevron" />
    </button>
  );
};

export default MicrophonePopover;
