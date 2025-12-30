/**
 * DevicePopover - Camera device selector with popover
 * 
 * Shows current camera status, opens popover with device list.
 * Selecting "No camera" disables, selecting a device enables.
 */

import React, { useEffect } from 'react';
import { Video, VideoOff, ChevronDown, RefreshCw } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useWebcamSettingsStore } from '@/stores/webcamSettingsStore';

interface DevicePopoverProps {
  disabled?: boolean;
}

export const DevicePopover: React.FC<DevicePopoverProps> = ({ disabled = false }) => {
  const {
    settings,
    devices,
    isLoadingDevices,
    loadDevices,
    setEnabled,
    setDevice,
  } = useWebcamSettingsStore();

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

  const handleSelectDevice = async (deviceIndex: number | null) => {
    if (deviceIndex === null) {
      // Disable camera
      await setEnabled(false);
    } else {
      // Enable and select device
      await setDevice(deviceIndex);
      if (!settings.enabled) {
        await setEnabled(true);
      }
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
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
      </PopoverTrigger>
      <PopoverContent 
        side="bottom" 
        sideOffset={8} 
        align="start"
        className="glass-popover-content w-64"
      >
        <div className="glass-popover-header">
          <span>Camera</span>
          <button
            onClick={() => loadDevices()}
            disabled={isLoadingDevices}
            className="glass-popover-refresh"
            title="Refresh devices"
          >
            <RefreshCw size={12} className={isLoadingDevices ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="glass-popover-body">
          <div className="glass-popover-list">
            {/* No camera option */}
            <button
              onClick={() => handleSelectDevice(null)}
              className={`glass-popover-option ${
                !settings.enabled ? 'glass-popover-option--selected' : ''
              }`}
            >
              <VideoOff size={14} />
              <span className="glass-popover-option-label">No camera</span>
              {!settings.enabled && (
                <span className="glass-popover-option-check">✓</span>
              )}
            </button>

            {/* Device list */}
            {devices.map((device) => (
              <button
                key={device.index}
                onClick={() => handleSelectDevice(device.index)}
                className={`glass-popover-option ${
                  settings.enabled && settings.deviceIndex === device.index ? 'glass-popover-option--selected' : ''
                }`}
              >
                <Video size={14} />
                <span className="glass-popover-option-label">
                  {device.name.length > 26 
                    ? device.name.substring(0, 26) + '…' 
                    : device.name}
                </span>
                {settings.enabled && settings.deviceIndex === device.index && (
                  <span className="glass-popover-option-check">✓</span>
                )}
              </button>
            ))}

            {devices.length === 0 && !isLoadingDevices && (
              <div className="glass-popover-empty">No cameras found</div>
            )}
            {isLoadingDevices && (
              <div className="glass-popover-empty">Loading devices...</div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default DevicePopover;
