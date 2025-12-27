/**
 * InlineSettings - Two-column layout for toolbar settings.
 *
 * Column 1: FPS + Quality (technical settings)
 * Column 2: Cursor + Audio + Countdown + Max (capture behavior)
 *
 * Uses base-ui Select with glass styling for dropdowns.
 */

import React, { useCallback, useEffect } from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { ChevronDown, Camera } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
import { useWebcamSettingsStore } from '@/stores/webcamSettingsStore';
import type { CaptureType, VideoFormat } from '@/types';
import type { WebcamSize, WebcamShape, WebcamPosition } from '@/types/generated';

interface SettingsColProps {
  mode: CaptureType;
}

// Glass-styled Select component for settings
interface GlassSelectProps {
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

const GlassSelect: React.FC<GlassSelectProps> = ({ value, options, onChange, disabled }) => {
  const handleValueChange = useCallback((val: string | null) => {
    if (val !== null) {
      onChange(val);
    }
  }, [onChange]);

  const currentLabel = options.find(o => String(o.value) === String(value))?.label || String(value);

  return (
    <BaseSelect.Root
      value={String(value)}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <BaseSelect.Trigger className="glass-settings-select-trigger">
        <BaseSelect.Value>{currentLabel}</BaseSelect.Value>
        <BaseSelect.Icon className="glass-settings-select-icon">
          <ChevronDown size={10} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} align="start" alignItemWithTrigger={false} className="z-[9999]">
          <BaseSelect.Popup className="glass-settings-select-popup">
            <BaseSelect.List>
              {options.map((opt) => (
                <BaseSelect.Item
                  key={opt.value}
                  value={String(opt.value)}
                  className="glass-settings-select-item"
                >
                  <BaseSelect.ItemText>{opt.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
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
