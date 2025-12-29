/**
 * InlineSettings - Two-column layout for toolbar settings.
 *
 * Column 1: FPS + Quality (technical settings)
 * Column 2: Cursor + Audio + Countdown + Max (capture behavior)
 *
 * Uses shadcn Select with glass styling for dropdowns.
 */

import React, { useEffect } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Camera, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
import { useWebcamSettingsStore } from '@/stores/webcamSettingsStore';
import { useAudioInputStore } from '@/stores/audioInputStore';
import type { CaptureType, VideoFormat } from '@/types';
import type { WebcamSize, WebcamShape, WebcamPosition } from '@/types/generated';

interface SettingsColProps {
  mode: CaptureType;
}

// Glass-styled Select component for settings using shadcn Select
interface GlassSelectProps {
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

const GlassSelect: React.FC<GlassSelectProps> = ({ value, options, onChange, disabled }) => {
  return (
    <Select
      value={String(value)}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger className="glass-settings-select-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        sideOffset={6}
        align="start"
        className="z-[9999] glass-settings-select-popup"
      >
        {options.map((opt) => (
          <SelectItem
            key={opt.value}
            value={String(opt.value)}
            className="glass-settings-select-item"
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

// Microphone device selector with tooltips, refresh, and default badge
interface MicSelectProps {
  value: number | null;
  devices: { index: number; name: string; isDefault: boolean }[];
  onChange: (deviceIndex: number | null) => void;
  onRefresh: () => void;
  isLoading?: boolean;
}

const MicSelect: React.FC<MicSelectProps> = ({ value, devices, onChange, onRefresh, isLoading }) => {
  const MAX_LABEL_LENGTH = 16;

  const getDisplayLabel = (name: string, isDefault: boolean) => {
    const suffix = isDefault ? ' ★' : '';
    const maxLen = MAX_LABEL_LENGTH - suffix.length;
    const truncated = name.length > maxLen ? name.substring(0, maxLen) + '…' : name;
    return truncated + suffix;
  };

  return (
    <div className="flex items-center gap-1">
      <Select
        value={value === null ? 'none' : String(value)}
        onValueChange={(v) => onChange(v === 'none' ? null : parseInt(v))}
      >
        <SelectTrigger className="glass-settings-select-trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          sideOffset={6}
          align="start"
          className="z-[9999] glass-settings-select-popup"
        >
          <SelectItem value="none" className="glass-settings-select-item">
            None
          </SelectItem>
          {devices.map((device) => (
            <SelectItem
              key={device.index}
              value={String(device.index)}
              className="glass-settings-select-item"
              title={device.name.length > MAX_LABEL_LENGTH ? device.name : undefined}
            >
              {getDisplayLabel(device.name, device.isDefault)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Refresh button */}
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="glass-icon-button"
              aria-label="Refresh audio devices"
            >
              <RefreshCw size={10} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content side="top" sideOffset={4} className="glass-tooltip">
              Refresh devices
              <Tooltip.Arrow className="fill-[var(--glass-bg-solid)]" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </div>
  );
};

/**
 * Column 1: FPS + Quality (for video/gif) or Format + Quality (for screenshot)
 */
export const SettingsCol1: React.FC<SettingsColProps> = ({ mode }) => {
  const { settings, updateScreenshotSettings, updateVideoSettings, updateGifSettings } =
    useCaptureSettingsStore();

  switch (mode) {
    case 'screenshot':
      return (
        <>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Format</span>
            <GlassSelect
              value={settings.screenshot.format}
              options={[
                { value: 'png', label: 'PNG' },
                { value: 'jpg', label: 'JPG' },
                { value: 'webp', label: 'WebP' },
              ]}
              onChange={(v) => updateScreenshotSettings({ format: v as 'png' | 'jpg' | 'webp' })}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Quality</span>
            <GlassSelect
              value={settings.screenshot.jpgQuality}
              options={[
                { value: 60, label: '60%' },
                { value: 70, label: '70%' },
                { value: 80, label: '80%' },
                { value: 90, label: '90%' },
                { value: 100, label: '100%' },
              ]}
              onChange={(v) => updateScreenshotSettings({ jpgQuality: parseInt(v) })}
              disabled={settings.screenshot.format === 'png'}
            />
          </div>
        </>
      );

    case 'video':
      return (
        <>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Format</span>
            <GlassSelect
              value={settings.video.format}
              options={[
                { value: 'mp4', label: 'MP4' },
              ]}
              onChange={(v) => updateVideoSettings({ format: v as VideoFormat })}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">FPS</span>
            <GlassSelect
              value={settings.video.fps}
              options={[
                { value: 15, label: '15' },
                { value: 24, label: '24' },
                { value: 30, label: '30' },
                { value: 60, label: '60' },
              ]}
              onChange={(v) => updateVideoSettings({ fps: parseInt(v) })}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Quality</span>
            <GlassSelect
              value={settings.video.quality}
              options={[
                { value: 40, label: '40%' },
                { value: 60, label: '60%' },
                { value: 80, label: '80%' },
                { value: 100, label: '100%' },
              ]}
              onChange={(v) => updateVideoSettings({ quality: parseInt(v) })}
            />
          </div>
        </>
      );

    case 'gif':
      return (
        <>
          <div className="glass-inline-group">
            <span className="glass-inline-label">FPS</span>
            <GlassSelect
              value={settings.gif.fps}
              options={[
                { value: 10, label: '10' },
                { value: 15, label: '15' },
                { value: 20, label: '20' },
                { value: 30, label: '30' },
              ]}
              onChange={(v) => updateGifSettings({ fps: parseInt(v) })}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Quality</span>
            <GlassSelect
              value={settings.gif.qualityPreset}
              options={[
                { value: 'fast', label: 'Fast' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'high', label: 'High' },
              ]}
              onChange={(v) => updateGifSettings({ qualityPreset: v as 'fast' | 'balanced' | 'high' })}
            />
          </div>
        </>
      );

    default:
      return null;
  }
};

/**
 * Column 2: Cursor + Audio + Countdown + Max duration
 */
export const SettingsCol2: React.FC<SettingsColProps> = ({ mode }) => {
  const { settings, updateScreenshotSettings, updateVideoSettings, updateGifSettings } =
    useCaptureSettingsStore();
  const { devices: audioDevices, loadDevices: loadAudioDevices, isLoadingDevices } = useAudioInputStore();

  // Load audio devices when in video mode
  useEffect(() => {
    if (mode === 'video' && audioDevices.length === 0) {
      loadAudioDevices();
    }
  }, [mode, audioDevices.length, loadAudioDevices]);

  // Get current cursor setting based on mode
  const getCursorEnabled = () => {
    switch (mode) {
      case 'screenshot':
        return settings.screenshot.includeCursor;
      case 'video':
        return settings.video.includeCursor;
      case 'gif':
        return settings.gif.includeCursor;
      default:
        return false;
    }
  };

  // Update cursor setting for current mode
  const setCursorEnabled = (enabled: boolean) => {
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
  };

  switch (mode) {
    case 'screenshot':
      return (
        <div className="glass-inline-group">
          <span className="glass-inline-label">Cursor</span>
          <Switch checked={getCursorEnabled()} onCheckedChange={setCursorEnabled} />
        </div>
      );

    case 'video':
      return (
        <>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Cursor</span>
            <Switch checked={getCursorEnabled()} onCheckedChange={setCursorEnabled} />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Audio</span>
            <Switch
              checked={settings.video.captureSystemAudio}
              onCheckedChange={(c) => updateVideoSettings({ captureSystemAudio: c })}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Mic</span>
            <MicSelect
              value={settings.video.microphoneDeviceIndex ?? null}
              devices={audioDevices}
              onChange={(deviceIndex) => updateVideoSettings({ microphoneDeviceIndex: deviceIndex })}
              onRefresh={loadAudioDevices}
              isLoading={isLoadingDevices}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Countdown</span>
            <GlassSelect
              value={settings.video.countdownSecs}
              options={[
                { value: 0, label: 'Off' },
                { value: 3, label: '3s' },
                { value: 5, label: '5s' },
              ]}
              onChange={(v) => updateVideoSettings({ countdownSecs: parseInt(v) })}
            />
          </div>
        </>
      );

    case 'gif':
      return (
        <>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Cursor</span>
            <Switch checked={getCursorEnabled()} onCheckedChange={setCursorEnabled} />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Countdown</span>
            <GlassSelect
              value={settings.gif.countdownSecs}
              options={[
                { value: 0, label: 'Off' },
                { value: 3, label: '3s' },
                { value: 5, label: '5s' },
              ]}
              onChange={(v) => updateGifSettings({ countdownSecs: parseInt(v) })}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Duration</span>
            <GlassSelect
              value={settings.gif.maxDurationSecs}
              options={[
                { value: 10, label: '10s' },
                { value: 30, label: '30s' },
                { value: 60, label: '60s' },
                { value: 0, label: '∞' },
              ]}
              onChange={(v) => updateGifSettings({ maxDurationSecs: parseInt(v) })}
            />
          </div>
        </>
      );

    default:
      return null;
  }
};

/**
 * Column 3: Webcam settings (for video/gif only)
 */
export const SettingsCol3: React.FC<SettingsColProps> = ({ mode }) => {
  const {
    settings: webcamSettings,
    devices,
    loadDevices,
    setEnabled,
    setDevice,
    setPosition,
    setSize,
    setShape,
  } = useWebcamSettingsStore();

  // Load devices when webcam is enabled
  useEffect(() => {
    if (webcamSettings.enabled && devices.length === 0) {
      loadDevices();
    }
  }, [webcamSettings.enabled, devices.length, loadDevices]);

  // Only show for video and gif modes
  if (mode !== 'video' && mode !== 'gif') {
    return null;
  }

  return (
    <>
      <div className="glass-inline-group">
        <Camera size={12} className="opacity-60" />
        <span className="glass-inline-label">Webcam</span>
        <Switch
          checked={webcamSettings.enabled}
          onCheckedChange={(checked) => setEnabled(checked)}
        />
      </div>
      {webcamSettings.enabled && (
        <>
          {devices.length > 1 && (
            <div className="glass-inline-group">
              <span className="glass-inline-label">Device</span>
              <GlassSelect
                value={webcamSettings.deviceIndex}
                options={devices.map((d) => ({
                  value: d.index,
                  label: d.name.length > 15 ? d.name.substring(0, 15) + '…' : d.name,
                }))}
                onChange={(v) => setDevice(parseInt(v))}
              />
            </div>
          )}
          <div className="glass-inline-group">
            <span className="glass-inline-label">Anchor</span>
            <GlassSelect
              value={webcamSettings.position.type}
              options={[
                { value: 'custom', label: 'None' },
                { value: 'bottomRight', label: 'BR' },
                { value: 'bottomLeft', label: 'BL' },
                { value: 'topRight', label: 'TR' },
                { value: 'topLeft', label: 'TL' },
              ]}
              onChange={(v) => {
                if (v === 'custom') {
                  // For "None", keep current position as custom
                  setPosition({ type: 'custom', x: 0, y: 0 });
                } else {
                  setPosition({ type: v } as WebcamPosition);
                }
              }}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Size</span>
            <GlassSelect
              value={webcamSettings.size}
              options={[
                { value: 'small', label: 'S' },
                { value: 'medium', label: 'M' },
                { value: 'large', label: 'L' },
              ]}
              onChange={(v) => setSize(v as WebcamSize)}
            />
          </div>
          <div className="glass-inline-group">
            <span className="glass-inline-label">Shape</span>
            <GlassSelect
              value={webcamSettings.shape}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'rectangle', label: 'Square' },
              ]}
              onChange={(v) => setShape(v as WebcamShape)}
            />
          </div>
        </>
      )}
    </>
  );
};

// Legacy exports for backwards compatibility
export const SettingsRow1 = SettingsCol1;
export const SettingsRow2 = SettingsCol2;

export const InlineSettings: React.FC<SettingsColProps> = ({ mode }) => {
  const showWebcam = mode === 'video' || mode === 'gif';

  return (
    <div className="flex items-center gap-3">
      <SettingsCol1 mode={mode} />
      <div className="glass-divider h-5" />
      <SettingsCol2 mode={mode} />
      {showWebcam && (
        <>
          <div className="glass-divider h-5" />
          <SettingsCol3 mode={mode} />
        </>
      )}
    </div>
  );
};

export default InlineSettings;
