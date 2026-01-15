import React, { useState, useEffect, useCallback } from 'react';
import { resolveResource } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Slider } from '@/components/ui/slider';
import { ColorPicker } from '@/components/ui/color-picker';
import { Check, Upload, X, Loader2 } from 'lucide-react';
import type { BackgroundConfig, VideoBackgroundType } from '@/types';
import {
  WALLPAPER_THEMES,
  WALLPAPERS_BY_THEME,
  GRADIENT_PRESETS,
  COLOR_PRESETS,
  type WallpaperTheme,
} from '@/constants/wallpapers';

interface BackgroundSettingsProps {
  background: BackgroundConfig;
  onUpdate: (updates: Partial<BackgroundConfig>) => void;
}

interface LoadedWallpaper {
  id: string;
  url: string;
}

export function BackgroundSettings({ background, onUpdate }: BackgroundSettingsProps) {
  const [wallpaperTheme, setWallpaperTheme] = useState<WallpaperTheme>('macOS');
  const [loadedWallpapers, setLoadedWallpapers] = useState<LoadedWallpaper[]>([]);
  const [isLoadingWallpapers, setIsLoadingWallpapers] = useState(false);

  // Load wallpaper thumbnails from Tauri resources
  useEffect(() => {
    async function loadWallpapers() {
      setIsLoadingWallpapers(true);
      try {
        const wallpaperIds = WALLPAPERS_BY_THEME[wallpaperTheme];
        const loaded: LoadedWallpaper[] = [];

        for (const id of wallpaperIds) {
          try {
            // Try thumbnail first, fallback to full image
            const parts = id.split('/');
            const theme = parts[0];
            const name = parts[1];
            let url: string;
            let resolvedPath: string;
            try {
              resolvedPath = await resolveResource(`assets/backgrounds/${theme}/thumbs/${name}.jpg`);
              url = convertFileSrc(resolvedPath);
            } catch {
              // Fallback to full image if thumbnail not found
              resolvedPath = await resolveResource(`assets/backgrounds/${id}.jpg`);
              url = convertFileSrc(resolvedPath);
            }
            loaded.push({ id, url });
          } catch {
            // Silently skip wallpapers that fail to load
          }
        }

        setLoadedWallpapers(loaded);
      } catch (err) {
        console.error('Failed to load wallpapers:', err);
      } finally {
        setIsLoadingWallpapers(false);
      }
    }

    loadWallpapers();
  }, [wallpaperTheme]);

  const handleTypeChange = useCallback((type: VideoBackgroundType) => {
    // Auto-add padding when switching to wallpaper/image
    const needsPadding = (type === 'wallpaper' || type === 'image') && background.padding === 0;
    const needsRounding = needsPadding && background.rounding === 0;

    onUpdate({
      bgType: type,
      ...(needsPadding && { padding: 40 }),
      ...(needsRounding && { rounding: 12 }),
    });
  }, [background.padding, background.rounding, onUpdate]);

  const handleWallpaperSelect = useCallback((wallpaperId: string) => {
    // Store just the wallpaper ID - Rust will resolve the full path during export
    // Format: "macOS/sequoia-dark" (without .jpg extension)
    onUpdate({
      bgType: 'wallpaper',
      wallpaper: wallpaperId,
    });
  }, [onUpdate]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // For now, use a data URL - in production, save to app data directory
      const reader = new FileReader();
      reader.onload = (ev) => {
        onUpdate({
          bgType: 'image',
          imagePath: ev.target?.result as string,
        });
      };
      reader.readAsDataURL(file);
    }
  }, [onUpdate]);

  const handleGradientPreset = useCallback((preset: typeof GRADIENT_PRESETS[0]) => {
    onUpdate({
      bgType: 'gradient',
      gradientStart: preset.start,
      gradientEnd: preset.end,
      gradientAngle: preset.angle,
    });
  }, [onUpdate]);

  return (
    <div className="space-y-4">
      {/* Background Type Tabs */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Background Type</span>
        <div className="grid grid-cols-4 gap-1.5">
          {(['wallpaper', 'image', 'solid', 'gradient'] as VideoBackgroundType[]).map((type) => (
            <button
              key={type}
              onClick={() => handleTypeChange(type)}
              className={`px-2 py-2 text-xs rounded-md transition-colors ${
                background.bgType === type
                  ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                  : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                {/* Type preview indicator */}
                {type === 'gradient' && (
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{
                      background: `linear-gradient(${background.gradientAngle}deg, ${background.gradientStart}, ${background.gradientEnd})`,
                    }}
                  />
                )}
                {type === 'solid' && (
                  <div
                    className="w-3 h-3 rounded-sm border border-[var(--glass-border)]"
                    style={{ backgroundColor: background.solidColor }}
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
      {background.bgType === 'wallpaper' && (
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
                const isSelected = background.wallpaper?.includes(wp.id);
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
      {background.bgType === 'image' && (
        <div className="space-y-3">
          {background.imagePath ? (
            <div className="relative rounded-lg overflow-hidden border border-[var(--glass-border)]">
              <img
                src={background.imagePath}
                alt="Custom background"
                className="w-full h-32 object-cover"
              />
              <button
                onClick={() => onUpdate({ imagePath: null })}
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
      {background.bgType === 'solid' && (
        <div className="space-y-3">
          <ColorPicker
            value={background.solidColor}
            onChange={(color) => onUpdate({ solidColor: color })}
            presets={COLOR_PRESETS}
          />
        </div>
      )}

      {/* Gradient Tab Content */}
      {background.bgType === 'gradient' && (
        <div className="space-y-3">
          {/* Gradient preview */}
          <div
            className="h-8 rounded-lg border border-[var(--glass-border)]"
            style={{
              background: `linear-gradient(${background.gradientAngle}deg, ${background.gradientStart}, ${background.gradientEnd})`,
            }}
          />

          {/* Start color */}
          <div>
            <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">Start Color</span>
            <ColorPicker
              value={background.gradientStart}
              onChange={(color) => onUpdate({ gradientStart: color })}
              showInput={false}
            />
          </div>

          {/* End color */}
          <div>
            <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">End Color</span>
            <ColorPicker
              value={background.gradientEnd}
              onChange={(color) => onUpdate({ gradientEnd: color })}
              showInput={false}
            />
          </div>

          {/* Angle slider */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--ink-subtle)]">Angle</span>
            <Slider
              value={[background.gradientAngle]}
              onValueChange={(values) => onUpdate({ gradientAngle: values[0] })}
              min={0}
              max={360}
              step={5}
              className="flex-1"
            />
            <span className="text-[11px] text-[var(--ink-faint)] w-8 text-right">
              {background.gradientAngle}°
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
                    background.gradientStart === preset.start &&
                    background.gradientEnd === preset.end
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
          <span className="text-xs text-[var(--ink-dark)] font-mono">{background.padding}px</span>
        </div>
        <Slider
          value={[background.padding]}
          onValueChange={(values) => onUpdate({ padding: values[0] })}
          min={0}
          max={200}
          step={4}
        />
      </div>

      {/* Corner Radius */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Corner Radius</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{background.rounding}px</span>
        </div>
        <Slider
          value={[background.rounding]}
          onValueChange={(values) => onUpdate({ rounding: values[0] })}
          min={0}
          max={100}
          step={2}
        />
        <div className="flex gap-1 mt-2">
          <button
            onClick={() => onUpdate({ roundingType: 'squircle' })}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              background.roundingType === 'squircle'
                ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
            }`}
          >
            Squircle
          </button>
          <button
            onClick={() => onUpdate({ roundingType: 'rounded' })}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              background.roundingType === 'rounded'
                ? 'bg-[var(--coral-100)] text-[var(--coral-500)] border border-[var(--coral-300)]'
                : 'bg-[var(--polar-mist)] text-[var(--ink-muted)] border border-[var(--glass-border)] hover:bg-[var(--polar-frost)]'
            }`}
          >
            Rounded
          </button>
        </div>
      </div>

      {/* Border */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Border</span>
          <button
            onClick={() =>
              onUpdate({
                border: { ...background.border, enabled: !background.border.enabled },
              })
            }
            className={`relative w-10 h-5 rounded-full transition-colors ${
              background.border.enabled ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                background.border.enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {background.border.enabled && (
          <div className="space-y-3 pl-3 border-l border-[var(--glass-border)]">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">Width</span>
                <span className="text-[11px] text-[var(--ink-faint)]">
                  {background.border.width}px
                </span>
              </div>
              <Slider
                value={[background.border.width]}
                onValueChange={(values) =>
                  onUpdate({
                    border: { ...background.border, width: values[0] },
                  })
                }
                min={1}
                max={20}
                step={1}
              />
            </div>
            <div>
              <span className="text-[11px] text-[var(--ink-subtle)] block mb-1.5">Color</span>
              <ColorPicker
                value={background.border.color}
                onChange={(color) =>
                  onUpdate({
                    border: { ...background.border, color },
                  })
                }
                showInput={false}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">Opacity</span>
                <span className="text-[11px] text-[var(--ink-faint)]">
                  {Math.round(background.border.opacity)}%
                </span>
              </div>
              <Slider
                value={[background.border.opacity]}
                onValueChange={(values) =>
                  onUpdate({
                    border: { ...background.border, opacity: values[0] },
                  })
                }
                min={0}
                max={100}
                step={1}
              />
            </div>
          </div>
        )}
      </div>

      {/* Shadow */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Shadow</span>
          <button
            onClick={() =>
              onUpdate({
                shadow: { ...background.shadow, enabled: !background.shadow.enabled },
              })
            }
            className={`relative w-10 h-5 rounded-full transition-colors ${
              background.shadow.enabled ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                background.shadow.enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {background.shadow.enabled && (
          <div className="space-y-3 pl-3 border-l border-[var(--glass-border)]">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">Size</span>
                <span className="text-[11px] text-[var(--ink-faint)]">
                  {Math.round(background.shadow.size)}%
                </span>
              </div>
              <Slider
                value={[background.shadow.size]}
                onValueChange={(values) =>
                  onUpdate({
                    shadow: { ...background.shadow, size: values[0] },
                  })
                }
                min={0}
                max={100}
                step={1}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">Opacity</span>
                <span className="text-[11px] text-[var(--ink-faint)]">
                  {Math.round(background.shadow.opacity)}%
                </span>
              </div>
              <Slider
                value={[background.shadow.opacity]}
                onValueChange={(values) =>
                  onUpdate({
                    shadow: { ...background.shadow, opacity: values[0] },
                  })
                }
                min={0}
                max={100}
                step={1}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">Blur</span>
                <span className="text-[11px] text-[var(--ink-faint)]">
                  {Math.round(background.shadow.blur)}%
                </span>
              </div>
              <Slider
                value={[background.shadow.blur]}
                onValueChange={(values) =>
                  onUpdate({
                    shadow: { ...background.shadow, blur: values[0] },
                  })
                }
                min={0}
                max={100}
                step={1}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
