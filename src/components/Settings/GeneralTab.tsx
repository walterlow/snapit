import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ImageFormat } from '@/types';

export const GeneralTab: React.FC = () => {
  const { settings, updateGeneralSettings } = useSettingsStore();
  const { general } = settings;

  const [isAutostartEnabled, setIsAutostartEnabled] = useState(false);
  const [isLoadingAutostart, setIsLoadingAutostart] = useState(true);

  // Load autostart status on mount
  useEffect(() => {
    const loadAutostartStatus = async () => {
      try {
        const enabled = await invoke<boolean>('is_autostart_enabled');
        setIsAutostartEnabled(enabled);
      } catch (error) {
        console.error('Failed to get autostart status:', error);
      } finally {
        setIsLoadingAutostart(false);
      }
    };
    loadAutostartStatus();
  }, []);

  const handleAutostartChange = async (enabled: boolean) => {
    try {
      await invoke('set_autostart', { enabled });
      setIsAutostartEnabled(enabled);
      updateGeneralSettings({ startWithWindows: enabled });
    } catch (error) {
      console.error('Failed to set autostart:', error);
    }
  };

  const handleBrowseSaveDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Default Save Location',
      });
      if (selected && typeof selected === 'string') {
        updateGeneralSettings({ defaultSaveDir: selected });
      }
    } catch (error) {
      console.error('Failed to open directory picker:', error);
    }
  };

  const handleOpenSaveDir = async () => {
    if (general.defaultSaveDir) {
      try {
        await invoke('open_path_in_explorer', { path: general.defaultSaveDir });
      } catch (error) {
        console.error('Failed to open directory:', error);
      }
    }
  };

  const handleSetDefaultDir = async () => {
    try {
      const defaultDir = await invoke<string>('get_default_save_dir');
      updateGeneralSettings({ defaultSaveDir: defaultDir });
    } catch (error) {
      console.error('Failed to get default save dir:', error);
    }
  };

  const handleFormatChange = (format: ImageFormat) => {
    updateGeneralSettings({ imageFormat: format });
  };

  const handleQualityChange = (value: number[]) => {
    updateGeneralSettings({ jpgQuality: value[0] });
  };

  return (
    <div className="space-y-6">
      {/* Startup Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-400 mb-3">
          Startup
        </h3>
        <div className="p-4 rounded-lg bg-[var(--obsidian-elevated)] border border-[var(--border-subtle)]">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-sm text-[var(--text-primary)]">
                Launch when Windows starts
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                SnapIt will start minimized in the system tray
              </p>
            </div>
            <Switch
              checked={isAutostartEnabled}
              onCheckedChange={handleAutostartChange}
              className={isLoadingAutostart ? 'opacity-50' : ''}
            />
          </label>
        </div>
      </section>

      {/* Save Options Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-400 mb-3">
          Save Options
        </h3>
        <div className="p-4 rounded-lg bg-[var(--obsidian-elevated)] border border-[var(--border-subtle)] space-y-4">
          {/* Default Save Location */}
          <div>
            <label className="text-sm text-[var(--text-primary)] mb-2 block">
              Default save location
            </label>
            <div className="flex gap-2">
              <Input
                value={general.defaultSaveDir || ''}
                placeholder="Click Browse to select..."
                readOnly
                className="flex-1 text-sm bg-[var(--obsidian-base)]"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBrowseSaveDir}
                className="shrink-0"
              >
                <FolderOpen className="w-4 h-4 mr-1" />
                Browse
              </Button>
              {general.defaultSaveDir && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleOpenSaveDir}
                  title="Open in Explorer"
                  className="shrink-0"
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
              )}
            </div>
            {!general.defaultSaveDir && (
              <Button
                variant="link"
                size="sm"
                onClick={handleSetDefaultDir}
                className="text-xs text-amber-400 p-0 h-auto mt-1"
              >
                Use default (Pictures/SnapIt)
              </Button>
            )}
          </div>

          {/* Image Format */}
          <div>
            <label className="text-sm text-[var(--text-primary)] mb-2 block">
              Default image format
            </label>
            <Select
              value={general.imageFormat}
              onValueChange={(value) => handleFormatChange(value as ImageFormat)}
            >
              <SelectTrigger className="w-full max-w-[200px] bg-[var(--obsidian-base)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG (lossless)</SelectItem>
                <SelectItem value="jpg">JPG (smaller file)</SelectItem>
                <SelectItem value="webp">WebP (modern)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* JPG Quality (only visible when JPG is selected) */}
          {general.imageFormat === 'jpg' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-[var(--text-primary)]">
                  JPG Quality
                </label>
                <span className="text-sm text-[var(--text-muted)]">
                  {general.jpgQuality}%
                </span>
              </div>
              <Slider
                value={[general.jpgQuality]}
                onValueChange={handleQualityChange}
                min={10}
                max={100}
                step={5}
                className="w-full"
              />
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Higher quality = larger file size
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
