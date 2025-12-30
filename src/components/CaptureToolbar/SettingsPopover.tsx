/**
 * SettingsPopover - Settings gear icon with dropdown popover
 * 
 * Contains video settings (FPS, Quality), countdown, cursor capture toggle.
 */

import React from 'react';
import { Settings, MousePointer2, Timer, Gauge, Film, ExternalLink, Monitor } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';
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

  // Get current cursor setting based on mode
  const getCursorEnabled = () => {
    switch (mode) {
      case 'screenshot': return settings.screenshot.includeCursor;
      case 'video': return settings.video.includeCursor;
      case 'gif': return settings.gif.includeCursor;
      default: return false;
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

  // Get countdown setting
  const getCountdown = () => {
    switch (mode) {
      case 'video': return settings.video.countdownSecs;
      case 'gif': return settings.gif.countdownSecs;
      default: return 0;
    }
  };

  const setCountdown = (secs: number) => {
    switch (mode) {
      case 'video':
        updateVideoSettings({ countdownSecs: secs });
        break;
      case 'gif':
        updateGifSettings({ countdownSecs: secs });
        break;
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="glass-settings-btn"
          disabled={disabled}
          title="Settings"
        >
          <Settings size={16} strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent 
        side="bottom" 
        sideOffset={8} 
        align="end"
        className="glass-popover-content w-72"
      >
        <div className="glass-popover-header">Settings</div>
        <div className="glass-popover-body">
          {/* Video/GIF specific settings */}
          {(mode === 'video' || mode === 'gif') && (
            <>
              {/* FPS */}
              <div className="glass-popover-row">
                <div className="flex items-center gap-2">
                  <Film size={14} className="text-white/50" />
                  <span className="glass-popover-row-label">Frame Rate</span>
                </div>
                <Select
                  value={String(mode === 'video' ? settings.video.fps : settings.gif.fps)}
                  onValueChange={(v) => {
                    const fps = parseInt(v);
                    if (mode === 'video') {
                      updateVideoSettings({ fps });
                    } else {
                      updateGifSettings({ fps });
                    }
                  }}
                >
                  <SelectTrigger className="glass-settings-select-trigger w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass-settings-select-popup">
                    {mode === 'video' ? (
                      <>
                        <SelectItem value="15" className="glass-settings-select-item">15 fps</SelectItem>
                        <SelectItem value="24" className="glass-settings-select-item">24 fps</SelectItem>
                        <SelectItem value="30" className="glass-settings-select-item">30 fps</SelectItem>
                        <SelectItem value="60" className="glass-settings-select-item">60 fps</SelectItem>
                      </>
                    ) : (
                      <>
                        <SelectItem value="10" className="glass-settings-select-item">10 fps</SelectItem>
                        <SelectItem value="15" className="glass-settings-select-item">15 fps</SelectItem>
                        <SelectItem value="20" className="glass-settings-select-item">20 fps</SelectItem>
                        <SelectItem value="30" className="glass-settings-select-item">30 fps</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {/* Quality */}
              <div className="glass-popover-row">
                <div className="flex items-center gap-2">
                  <Gauge size={14} className="text-white/50" />
                  <span className="glass-popover-row-label">Quality</span>
                </div>
                {mode === 'video' ? (
                  <Select
                    value={String(settings.video.quality)}
                    onValueChange={(v) => updateVideoSettings({ quality: parseInt(v) })}
                  >
                    <SelectTrigger className="glass-settings-select-trigger w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="glass-settings-select-popup">
                      <SelectItem value="40" className="glass-settings-select-item">40%</SelectItem>
                      <SelectItem value="60" className="glass-settings-select-item">60%</SelectItem>
                      <SelectItem value="80" className="glass-settings-select-item">80%</SelectItem>
                      <SelectItem value="100" className="glass-settings-select-item">100%</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={settings.gif.qualityPreset}
                    onValueChange={(v) => updateGifSettings({ qualityPreset: v as 'fast' | 'balanced' | 'high' })}
                  >
                    <SelectTrigger className="glass-settings-select-trigger w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="glass-settings-select-popup">
                      <SelectItem value="fast" className="glass-settings-select-item">Fast</SelectItem>
                      <SelectItem value="balanced" className="glass-settings-select-item">Balanced</SelectItem>
                      <SelectItem value="high" className="glass-settings-select-item">High</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Countdown */}
              <div className="glass-popover-row">
                <div className="flex items-center gap-2">
                  <Timer size={14} className="text-white/50" />
                  <span className="glass-popover-row-label">Countdown</span>
                </div>
                <Select
                  value={String(getCountdown())}
                  onValueChange={(v) => setCountdown(parseInt(v))}
                >
                  <SelectTrigger className="glass-settings-select-trigger w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass-settings-select-popup">
                    <SelectItem value="0" className="glass-settings-select-item">Off</SelectItem>
                    <SelectItem value="3" className="glass-settings-select-item">3 sec</SelectItem>
                    <SelectItem value="5" className="glass-settings-select-item">5 sec</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="glass-popover-divider" />
            </>
          )}

          {/* Cursor capture toggle */}
          <div className="glass-popover-row">
            <div className="flex items-center gap-2">
              <MousePointer2 size={14} className="text-white/50" />
              <span className="glass-popover-row-label">Capture cursor</span>
            </div>
            <Switch
              checked={getCursorEnabled()}
              onCheckedChange={setCursorEnabled}
            />
          </div>

          {/* Hide desktop icons toggle (video only) */}
          {mode === 'video' && (
            <div className="glass-popover-row">
              <div className="flex items-center gap-2">
                <Monitor size={14} className="text-white/50" />
                <span className="glass-popover-row-label">Hide desktop icons</span>
              </div>
              <Switch
                checked={settings.video.hideDesktopIcons}
                onCheckedChange={(checked) => updateVideoSettings({ hideDesktopIcons: checked })}
              />
            </div>
          )}

          {/* Link to full settings */}
          {onOpenSettings && (
            <>
              <div className="glass-popover-divider" />
              <button
                onClick={onOpenSettings}
                className="glass-popover-link"
              >
                <ExternalLink size={14} />
                <span>Open full settings</span>
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default SettingsPopover;
