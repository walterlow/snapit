/**
 * MicrophonePopover - Microphone device selector with popover
 * 
 * Shows current microphone status, opens popover with device list.
 */

import React, { useEffect } from 'react';
import { Mic, MicOff, ChevronDown, RefreshCw } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAudioInputStore } from '@/stores/audioInputStore';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';

interface MicrophonePopoverProps {
  disabled?: boolean;
}

export const MicrophonePopover: React.FC<MicrophonePopoverProps> = ({ disabled = false }) => {
  const { devices, loadDevices, isLoadingDevices } = useAudioInputStore();
  const { settings, updateVideoSettings } = useCaptureSettingsStore();

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

  const handleSelectDevice = (deviceIndex: number | null) => {
    updateVideoSettings({ microphoneDeviceIndex: deviceIndex });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
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
      </PopoverTrigger>
      <PopoverContent 
        side="bottom" 
        sideOffset={8} 
        align="start"
        className="glass-popover-content w-64"
      >
        <div className="glass-popover-header">
          <span>Microphone</span>
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
            {/* No microphone option */}
            <button
              onClick={() => handleSelectDevice(null)}
              className={`glass-popover-option ${
                !isEnabled ? 'glass-popover-option--selected' : ''
              }`}
            >
              <MicOff size={14} />
              <span className="glass-popover-option-label">Mute Microphone</span>
              {!isEnabled && (
                <span className="glass-popover-option-check">✓</span>
              )}
            </button>

            {/* Device list */}
            {devices.map((device) => (
              <button
                key={device.index}
                onClick={() => handleSelectDevice(device.index)}
                className={`glass-popover-option ${
                  selectedDeviceIndex === device.index ? 'glass-popover-option--selected' : ''
                }`}
              >
                <Mic size={14} />
                <span className="glass-popover-option-label">
                  {device.name}
                  {device.isDefault && <span className="glass-popover-badge">★</span>}
                </span>
                {selectedDeviceIndex === device.index && (
                  <span className="glass-popover-option-check">✓</span>
                )}
              </button>
            ))}

            {devices.length === 0 && !isLoadingDevices && (
              <div className="glass-popover-empty">No microphones found</div>
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

export default MicrophonePopover;
