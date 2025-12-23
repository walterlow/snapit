import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, ExternalLink, RefreshCw } from 'lucide-react';
import { useUpdater } from '@/hooks/useUpdater';
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
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const { version, available, checkForUpdates, downloadAndInstall, downloading } = useUpdater(false);

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

  // Set default save directory if not configured
  useEffect(() => {
    const initDefaultSaveDir = async () => {
      if (!general.defaultSaveDir) {
        try {
          const defaultDir = await invoke<string>('get_default_save_dir');
          updateGeneralSettings({ defaultSaveDir: defaultDir });
        } catch (error) {
          console.error('Failed to set default save dir:', error);
        }
      }
    };
    initDefaultSaveDir();
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

  const handleFormatChange = (format: ImageFormat) => {
    updateGeneralSettings({ imageFormat: format });
  };

  const handleQualityChange = (value: number[]) => {
    updateGeneralSettings({ jpgQuality: value[0] });
  };

  const handleCheckForUpdates = async () => {
    setIsCheckingUpdates(true);
    await checkForUpdates(true);
    setIsCheckingUpdates(false);
  };

  return (
    <div className="space-y-6">
      {/* Startup Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Startup
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-sm text-[var(--ink-black)]">
                Launch when Windows starts
              </p>
              <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                SnapIt will start minimized in the system tray
              </p>
            </div>
            <Switch
              checked={isAutostartEnabled}
              onCheckedChange={handleAutostartChange}
              className={isLoadingAutostart ? 'opacity-50' : ''}
            />
          </label>

          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-sm text-[var(--ink-black)]">
                Close to system tray
              </p>
              <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                Minimize to tray instead of quitting when closing the window
              </p>
            </div>
            <Switch
              checked={general.minimizeToTray}
              onCheckedChange={(checked) => {
                updateGeneralSettings({ minimizeToTray: checked });
                invoke('set_close_to_tray', { enabled: checked });
              }}
            />
          </label>
        </div>
      </section>

      {/* Save Options Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Save Options
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          {/* Default Save Location */}
          <div>
            <label className="text-sm text-[var(--ink-black)] mb-2 block">
              Default save location
            </label>
            <div className="flex gap-2">
              <Input
                value={general.defaultSaveDir || ''}
                placeholder="Click Browse to select..."
                readOnly
                className="flex-1 text-sm bg-white"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBrowseSaveDir}
                className="shrink-0 bg-white border-[var(--polar-frost)] text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
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
                  className="shrink-0 text-[var(--ink-muted)] hover:text-[var(--ink-black)] hover:bg-[var(--polar-mist)]"
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Image Format */}
          <div>
            <label className="text-sm text-[var(--ink-black)] mb-2 block">
              Default image format
            </label>
            <Select
              value={general.imageFormat}
              onValueChange={(value) => handleFormatChange(value as ImageFormat)}
            >
              <SelectTrigger className="w-full max-w-[200px] bg-white border-[var(--polar-frost)] text-[var(--ink-black)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG - Lossless</SelectItem>
                <SelectItem value="jpg">JPG - Compressed</SelectItem>
                <SelectItem value="webp">WebP - Modern</SelectItem>
                <SelectItem value="gif">GIF - Legacy</SelectItem>
                <SelectItem value="bmp">BMP - Uncompressed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* JPG Quality (only visible when JPG is selected) */}
          {general.imageFormat === 'jpg' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-[var(--ink-black)]">
                  JPG Quality
                </label>
                <span className="text-sm text-[var(--ink-muted)]">
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
              <p className="text-xs text-[var(--ink-muted)] mt-1">
                Higher quality = larger file size
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Updates Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Updates
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--ink-black)]">
                Current version: v0.1.0
              </p>
              {available && version && (
                <p className="text-xs text-[var(--coral-500)] mt-0.5">
                  Update available: v{version}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {available ? (
                <Button
                  variant="default"
                  size="sm"
                  onClick={downloadAndInstall}
                  disabled={downloading}
                  className="bg-[var(--coral-500)] hover:bg-[var(--coral-600)] text-white"
                >
                  {downloading ? 'Installing...' : 'Install Update'}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckForUpdates}
                  disabled={isCheckingUpdates}
                  className="bg-white border-[var(--polar-frost)] text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
                >
                  <RefreshCw className={`w-4 h-4 mr-1 ${isCheckingUpdates ? 'animate-spin' : ''}`} />
                  {isCheckingUpdates ? 'Checking...' : 'Check for Updates'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
