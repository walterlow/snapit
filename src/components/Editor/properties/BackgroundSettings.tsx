import React, { useState, useEffect, useCallback } from 'react';
import { resolveResource } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Check, Upload, X, Loader2 } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { ColorPicker } from '@/components/ui/color-picker';
import type { CompositorSettings, BackgroundType } from '../../../types';
import {
  WALLPAPER_THEMES,
  WALLPAPERS_BY_THEME,
  GRADIENT_PRESETS,
  COLOR_PRESETS,
  type WallpaperTheme,
} from '@/constants/wallpapers';

interface BackgroundSettingsProps {
  settings: CompositorSettings;
  onSettingsChange: (settings: Partial<CompositorSettings>) => void;
}

interface LoadedWallpaper {
  id: string;
  url: string;
}

export const BackgroundSettings: React.FC<BackgroundSettingsProps> = ({
  settings,
  onSettingsChange,
}) => {
  const [wallpaperTheme, setWallpaperTheme] = useState<WallpaperTheme>('macOS');
  const [loadedWallpapers, setLoadedWallpapers] = useState<LoadedWallpaper[]>([]);
  const [isLoadingWallpapers, setIsLoadingWallpapers] = useState(false);

  // Local state for live preview during slider drag
  const [localPadding, setLocalPadding] = useState(settings.padding);
  const [localBorderRadius, setLocalBorderRadius] = useState(settings.borderRadius);
  const [localShadowIntensity, setLocalShadowIntensity] = useState(settings.shadowIntensity);
  const [localGradientAngle, setLocalGradientAngle] = useState(settings.gradientAngle);
  const [localBorderWidth, setLocalBorderWidth] = useState(settings.borderWidth ?? 2);
  const [localBorderOpacity, setLocalBorderOpacity] = useState(settings.borderOpacity ?? 0);

  // Sync local state when store changes
  useEffect(() => {
    setLocalPadding(settings.padding);
    setLocalBorderRadius(settings.borderRadius);
    setLocalShadowIntensity(settings.shadowIntensity);
    setLocalGradientAngle(settings.gradientAngle);
    setLocalBorderWidth(settings.borderWidth ?? 2);
    setLocalBorderOpacity(settings.borderOpacity ?? 0);
  }, [settings.padding, settings.borderRadius, settings.shadowIntensity, settings.gradientAngle, settings.borderWidth, settings.borderOpacity]);

  // Load wallpaper thumbnails from Tauri resources
  useEffect(() => {
    async function loadWallpapers() {
      setIsLoadingWallpapers(true);
      try {
        const wallpaperIds = WALLPAPERS_BY_THEME[wallpaperTheme];
        const loaded: LoadedWallpaper[] = [];

        for (const id of wallpaperIds) {
          try {
            const parts = id.split('/');
            const theme = parts[0];
            const name = parts[1];
            let url: string;
            let resolvedPath: string;
            try {
              resolvedPath = await resolveResource(`assets/backgrounds/${theme}/thumbs/${name}.jpg`);
              url = convertFileSrc(resolvedPath);
            } catch {
              resolvedPath = await resolveResource(`assets/backgrounds/${id}.jpg`);
              url = convertFileSrc(resolvedPath);
            }
            loaded.push({ id, url });
          } catch {
            // Silently skip wallpapers that fail to load
          }
        }

        setLoadedWallpapers(loaded);
      } catch {
        // Failed to load wallpapers
      } finally {
        setIsLoadingWallpapers(false);
      }
    }

    loadWallpapers();
  }, [wallpaperTheme]);

  const handleTypeChange = useCallback((type: BackgroundType) => {
    // Auto-add padding when switching to wallpaper/image
    const needsPadding = (type === 'wallpaper' || type === 'image') && settings.padding === 0;
    const needsRounding = needsPadding && settings.borderRadius === 0;

    onSettingsChange({
      backgroundType: type,
      ...(needsPadding && { padding: 40 }),
      ...(needsRounding && { borderRadius: 12 }),
    });
  }, [settings.padding, settings.borderRadius, onSettingsChange]);

  const handleWallpaperSelect = useCallback(async (wallpaperId: string) => {
    try {
      // Load full-resolution wallpaper (not thumbnail)
      const parts = wallpaperId.split('/');
      const theme = parts[0];
      const name = parts[1];
      const resolvedPath = await resolveResource(`assets/backgrounds/${theme}/${name}.jpg`);
      const url = convertFileSrc(resolvedPath);

      onSettingsChange({
        backgroundType: 'wallpaper',
        wallpaper: wallpaperId,
        backgroundImage: url,
      });
    } catch {
      // Fallback: just set the ID, rendering will show placeholder
      onSettingsChange({
        backgroundType: 'wallpaper',
        wallpaper: wallpaperId,
      });
    }
  }, [onSettingsChange]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        onSettingsChange({
          backgroundType: 'image',
          backgroundImage: ev.target?.result as string,
        });
      };
      reader.readAsDataURL(file);
    }
  }, [onSettingsChange]);

  const handleGradientPreset = useCallback((preset: typeof GRADIENT_PRESETS[0]) => {
    onSettingsChange({
      backgroundType: 'gradient',
      gradientStart: preset.start,
      gradientEnd: preset.end,
      gradientAngle: preset.angle,
    });
  }, [onSettingsChange]);

  return (
    <div className="space-y-4">
      {/* Background Type Tabs */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Background Type</span>
        <div className="grid grid-cols-4 gap-1.5">
          {(['wallpaper', 'image', 'solid', 'gradient'] as BackgroundType[]).map((type) => (
            <button
              key={type}
              onClick={() => handleTypeChange(type)}
              className={`px-2 py-2 text-xs rounded-md transition-colors ${
                settings.backgroundType === type
                  ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                  : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                {type === 'gradient' && (
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{
                      background: `linear-gradient(${settings.gradientAngle}deg, ${settings.gradientStart}, ${settings.gradientEnd})`,
                    }}
                  />
                )}
                {type === 'solid' && (
                  <div
                    className="w-3 h-3 rounded-sm border border-[var(--glass-border)]"
                    style={{ backgroundColor: settings.backgroundColor }}
                  />
                )}
                {type === 'wallpaper' && (
                  <div className="w-3 h-3 rounded-sm bg-gradient-to-br from-blue-400 to-purple-500" />
                )}
                {type === 'image' && (
                  <div className="w-3 h-3 rounded-sm bg-[var(--ink-faint)] flex items-center justify-center">
                    <Upload className="w-2 h-2" />
                  </div>
                )}
                <span className="capitalize">{type}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-dashed border-[var(--glass-border)]" />

      {/* Wallpaper Tab Content */}
      {settings.backgroundType === 'wallpaper' && (
        <div className="space-y-3">
          {/* Theme Tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
            {(Object.keys(WALLPAPER_THEMES) as WallpaperTheme[]).map((theme) => (
              <button
                key={theme}
                onClick={() => setWallpaperTheme(theme)}
                className={`flex-shrink-0 px-3 py-1.5 text-xs rounded-md transition-colors ${
                  wallpaperTheme === theme
                    ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                    : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
                }`}
              >
                {WALLPAPER_THEMES[theme]}
              </button>
            ))}
          </div>

          {/* Wallpaper Grid */}
          {isLoadingWallpapers ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--ink-muted)]" />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {loadedWallpapers.map((wp) => {
                const isSelected = settings.wallpaper === wp.id;
                return (
                  <button
                    key={wp.id}
                    onClick={() => handleWallpaperSelect(wp.id)}
                    className={`aspect-video rounded-lg overflow-hidden border-2 transition-all hover:scale-[1.02] relative ${
                      isSelected
                        ? 'border-[var(--coral-400)] ring-2 ring-[var(--coral-200)]'
                        : 'border-transparent hover:border-[var(--glass-border)]'
                    }`}
                  >
                    <img
                      src={wp.url}
                      alt={wp.id}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                      style={{ contentVisibility: 'auto' }}
                    />
                    {isSelected && (
                      <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-[var(--coral-400)] flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Image Tab Content */}
      {settings.backgroundType === 'image' && (
        <div className="space-y-3">
          {settings.backgroundImage ? (
            <div className="relative rounded-lg overflow-hidden border border-[var(--glass-border)]">
              <img
                src={settings.backgroundImage}
                alt="Custom background"
                className="w-full h-32 object-cover"
              />
              <button
                onClick={() => onSettingsChange({ backgroundImage: null })}
                className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
              >
                <X className="w-3.5 h-3.5 text-white" />
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center h-24 rounded-lg border-2 border-dashed border-[var(--glass-border)] bg-[var(--polar-mist)] cursor-pointer hover:border-[var(--coral-300)] hover:bg-[var(--coral-50)] transition-colors">
              <Upload className="w-5 h-5 text-[var(--ink-muted)] mb-1" />
              <span className="text-xs text-[var(--ink-muted)]">Click to upload</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />
            </label>
          )}
        </div>
      )}

      {/* Solid Color Tab Content */}
      {settings.backgroundType === 'solid' && (
        <div className="space-y-3">
          <ColorPicker
            value={settings.backgroundColor}
            onChange={(color) => onSettingsChange({ backgroundColor: color })}
            presets={COLOR_PRESETS}
          />
        </div>
      )}

      {/* Gradient Tab Content */}
      {settings.backgroundType === 'gradient' && (
        <div className="space-y-3">
          {/* Gradient preview */}
          <div
            className="h-8 rounded-lg border border-[var(--glass-border)]"
            style={{
              background: `linear-gradient(${settings.gradientAngle}deg, ${settings.gradientStart}, ${settings.gradientEnd})`,
            }}
          />

          {/* Start color */}
          <div>
            <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">Start Color</span>
            <ColorPicker
              value={settings.gradientStart}
              onChange={(color) => onSettingsChange({ gradientStart: color })}
              showInput={false}
            />
          </div>

          {/* End color */}
          <div>
            <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">End Color</span>
            <ColorPicker
              value={settings.gradientEnd}
              onChange={(color) => onSettingsChange({ gradientEnd: color })}
              showInput={false}
            />
          </div>

          {/* Angle slider */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--ink-subtle)]">Angle</span>
            <Slider
              value={[localGradientAngle]}
              onValueChange={([value]) => {
                setLocalGradientAngle(value);
                onSettingsChange({ gradientAngle: value });
              }}
              min={0}
              max={360}
              step={5}
              className="flex-1"
            />
            <span className="text-[11px] text-[var(--ink-faint)] w-8 text-right">
              {localGradientAngle}°
            </span>
          </div>

          {/* Gradient presets */}
          <div>
            <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">Presets</span>
            <div className="grid grid-cols-4 gap-1.5">
              {GRADIENT_PRESETS.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => handleGradientPreset(preset)}
                  className={`aspect-square rounded-md border-2 transition-all hover:scale-105 ${
                    settings.gradientStart === preset.start &&
                    settings.gradientEnd === preset.end
                      ? 'border-[var(--ink-dark)]'
                      : 'border-transparent'
                  }`}
                  style={{
                    background: `linear-gradient(${preset.angle}deg, ${preset.start}, ${preset.end})`,
                  }}
                  title={preset.name}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Padding */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Padding</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{localPadding}px</span>
        </div>
        <Slider
          value={[localPadding]}
          onValueChange={([value]) => {
            setLocalPadding(value);
            onSettingsChange({ padding: value });
          }}
          min={0}
          max={200}
          step={4}
        />
      </div>

      {/* Corner Radius */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Corner Radius</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{localBorderRadius}px</span>
        </div>
        <Slider
          value={[localBorderRadius]}
          onValueChange={([value]) => {
            setLocalBorderRadius(value);
            onSettingsChange({ borderRadius: value });
          }}
          min={0}
          max={100}
          step={2}
        />
        <div className="flex gap-1 mt-2">
          <button
            onClick={() => onSettingsChange({ borderRadiusType: 'squircle' })}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              settings.borderRadiusType === 'squircle'
                ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
            }`}
          >
            Squircle
          </button>
          <button
            onClick={() => onSettingsChange({ borderRadiusType: 'rounded' })}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              settings.borderRadiusType === 'rounded'
                ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
            }`}
          >
            Rounded
          </button>
        </div>
      </div>

      {/* Shadow */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Shadow</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(localShadowIntensity * 100)}%</span>
        </div>
        <Slider
          value={[localShadowIntensity * 100]}
          onValueChange={([value]) => {
            setLocalShadowIntensity(value / 100);
            onSettingsChange({ shadowIntensity: value / 100 });
          }}
          min={0}
          max={100}
          step={2}
        />
      </div>

      {/* Border */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Border</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(localBorderOpacity)}%</span>
        </div>
        <Slider
          value={[localBorderOpacity]}
          onValueChange={([value]) => {
            setLocalBorderOpacity(value);
            onSettingsChange({ borderOpacity: value });
          }}
          min={0}
          max={100}
          step={1}
        />
        {localBorderOpacity > 0 && (
          <div className="space-y-3 mt-3 pl-3 border-l border-[var(--glass-border)]">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">Width</span>
                <span className="text-[11px] text-[var(--ink-faint)]">{localBorderWidth}px</span>
              </div>
              <Slider
                value={[localBorderWidth]}
                onValueChange={([value]) => {
                  setLocalBorderWidth(value);
                  onSettingsChange({ borderWidth: value });
                }}
                min={1}
                max={20}
                step={1}
              />
            </div>
            <div>
              <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">Color</span>
              <ColorPicker
                value={settings.borderColor ?? '#ffffff'}
                onChange={(color) => onSettingsChange({ borderColor: color })}
                showInput={false}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BackgroundSettings;
