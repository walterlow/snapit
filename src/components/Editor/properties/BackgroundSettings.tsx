import React from 'react';
import {
  Palette,
  Image as ImageIcon,
  Sun,
  Layers,
  RectangleHorizontal,
  Check,
  Upload,
  X,
  Square,
  Circle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { GRADIENT_PRESETS, DEFAULT_WALLPAPERS, WALLPAPER_THUMBNAILS, type GradientStop, type CompositorSettings } from '../../../types';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ColorPicker } from '@/components/ui/color-picker';

// Color presets for quick selection
const COLOR_PRESETS = [
  '#EF4444', '#F97316', '#F97066', '#22C55E',
  '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF', '#1A1A1A',
];

interface BackgroundSettingsProps {
  settings: CompositorSettings;
  onSettingsChange: (settings: Partial<CompositorSettings>) => void;
}

export const BackgroundSettings: React.FC<BackgroundSettingsProps> = ({
  settings,
  onSettingsChange,
}) => {
  // Local state for live preview during slider drag
  const [localPadding, setLocalPadding] = React.useState(settings.padding);
  const [localBorderRadius, setLocalBorderRadius] = React.useState(settings.borderRadius);
  const [localShadowIntensity, setLocalShadowIntensity] = React.useState(settings.shadowIntensity);
  const [localShadowSize, setLocalShadowSize] = React.useState(settings.shadowSize ?? 14.4);
  const [localShadowOpacity, setLocalShadowOpacity] = React.useState(settings.shadowOpacity ?? 68.1);
  const [localShadowBlur, setLocalShadowBlur] = React.useState(settings.shadowBlur ?? 3.8);
  const [localGradientAngle, setLocalGradientAngle] = React.useState(settings.gradientAngle);
  const [localBorderWidth, setLocalBorderWidth] = React.useState(settings.borderWidth ?? 2);
  const [localBorderOpacity, setLocalBorderOpacity] = React.useState(settings.borderOpacity ?? 80);
  const [showAdvancedShadow, setShowAdvancedShadow] = React.useState(false);

  // Sync local state when store changes
  React.useEffect(() => {
    setLocalPadding(settings.padding);
    setLocalBorderRadius(settings.borderRadius);
    setLocalShadowIntensity(settings.shadowIntensity);
    setLocalShadowSize(settings.shadowSize ?? 14.4);
    setLocalShadowOpacity(settings.shadowOpacity ?? 68.1);
    setLocalShadowBlur(settings.shadowBlur ?? 3.8);
    setLocalGradientAngle(settings.gradientAngle);
    setLocalBorderWidth(settings.borderWidth ?? 2);
    setLocalBorderOpacity(settings.borderOpacity ?? 80);
  }, [settings.padding, settings.borderRadius, settings.shadowIntensity, settings.shadowSize, settings.shadowOpacity, settings.shadowBlur, settings.gradientAngle, settings.borderWidth, settings.borderOpacity]);

  const handleGradientPreset = (stops: GradientStop[]) => {
    onSettingsChange({ gradientStops: stops, backgroundType: 'gradient' });
  };

  const getGradientStyle = (stops: GradientStop[], angle: number = 135) => {
    const gradientStops = stops
      .map((s) => `${s.color} ${s.position}%`)
      .join(', ');
    return `linear-gradient(${angle}deg, ${gradientStops})`;
  };

  return (
    <div className="space-y-5">
      {/* Background Type */}
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Type</Label>
        <div className="flex gap-2">
          <button
            onClick={() => onSettingsChange({ backgroundType: 'solid' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              settings.backgroundType === 'solid'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            Solid
          </button>
          <button
            onClick={() => onSettingsChange({ backgroundType: 'gradient' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              settings.backgroundType === 'gradient'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            Gradient
          </button>
          <button
            onClick={() => onSettingsChange({ backgroundType: 'image' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              settings.backgroundType === 'image'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            Image
          </button>
        </div>
      </div>

      {/* Solid Color Picker */}
      {settings.backgroundType === 'solid' && (
        <div className="space-y-3">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Color</Label>
          <ColorPicker
            value={settings.backgroundColor}
            onChange={(color) => onSettingsChange({ backgroundColor: color })}
            presets={COLOR_PRESETS}
          />
        </div>
      )}

      {/* Gradient Presets */}
      {settings.backgroundType === 'gradient' && (
        <div className="space-y-3">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Gradient Presets</Label>
          <div className="grid grid-cols-4 gap-2">
            {GRADIENT_PRESETS.map((preset, idx) => (
              <button
                key={idx}
                onClick={() => handleGradientPreset(preset.stops)}
                className="w-full aspect-square rounded-lg border-2 transition-all hover:scale-105 shadow-sm"
                style={{
                  background: getGradientStyle(preset.stops),
                  borderColor:
                    JSON.stringify(settings.gradientStops) === JSON.stringify(preset.stops)
                      ? 'var(--ink-black)'
                      : 'transparent',
                }}
                title={preset.name}
              />
            ))}
          </div>
          {/* Gradient Angle */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-[var(--ink-muted)]">Angle</Label>
              <span className="text-xs text-[var(--ink-dark)] font-mono">{localGradientAngle}°</span>
            </div>
            <Slider
              value={[localGradientAngle]}
              onValueChange={([value]) => {
                setLocalGradientAngle(value);
                onSettingsChange({ gradientAngle: value });
              }}
              min={0}
              max={360}
              step={5}
              className="w-full"
            />
          </div>
        </div>
      )}

      {/* Image Upload */}
      {settings.backgroundType === 'image' && (
        <div className="space-y-4">
          {/* Default Wallpapers Gallery */}
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Wallpapers</Label>
            <div className="grid grid-cols-4 gap-2">
              {DEFAULT_WALLPAPERS.map((wallpaper, idx) => (
                <button
                  key={idx}
                  onClick={() => onSettingsChange({ backgroundImage: wallpaper })}
                  className={`aspect-[16/10] rounded-lg overflow-hidden border-2 transition-transform hover:scale-105 relative shadow-sm ${
                    settings.backgroundImage === wallpaper
                      ? 'border-[var(--ink-black)]'
                      : 'border-transparent hover:border-[var(--polar-frost)]'
                  }`}
                >
                  <img
                    src={WALLPAPER_THUMBNAILS[idx]}
                    alt={`Wallpaper ${idx + 1}`}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                  {settings.backgroundImage === wallpaper && (
                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-[var(--coral-400)] flex items-center justify-center shadow-sm">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Upload */}
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Or Upload Custom</Label>
            <label className="flex flex-col items-center justify-center h-16 rounded-lg border-2 border-dashed border-[var(--polar-frost)] bg-[var(--card)] cursor-pointer hover:border-[var(--coral-300)] hover:bg-[var(--coral-50)] transition-colors">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-[var(--ink-muted)]" />
                <span className="text-xs text-[var(--ink-muted)]">Click to upload</span>
              </div>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      onSettingsChange({ backgroundImage: ev.target?.result as string });
                    };
                    reader.readAsDataURL(file);
                  }
                }}
              />
            </label>
          </div>

          {/* Clear button */}
          {settings.backgroundImage && (
            <button
              onClick={() => onSettingsChange({ backgroundImage: null })}
              className="w-full py-2 px-3 rounded-lg text-xs font-medium text-[var(--ink-muted)] bg-[var(--card)] hover:bg-[var(--polar-ice)] border border-[var(--polar-frost)] transition-colors flex items-center justify-center gap-2"
            >
              <X className="w-3 h-3" />
              Clear Background Image
            </button>
          )}
        </div>
      )}

      {/* Padding */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Padding</Label>
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
          step={1}
          className="w-full"
        />
      </div>

      {/* Border Radius */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium flex items-center gap-1.5">
            <RectangleHorizontal className="w-3.5 h-3.5" />
            Corner Radius
          </Label>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{localBorderRadius}px</span>
        </div>
        <Slider
          value={[localBorderRadius]}
          onValueChange={([value]) => {
            setLocalBorderRadius(value);
            onSettingsChange({ borderRadius: value });
          }}
          min={0}
          max={48}
          step={1}
          className="w-full"
        />
      </div>

      {/* Corner Style */}
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Corner Style</Label>
        <div className="flex gap-2">
          <button
            onClick={() => onSettingsChange({ borderRadiusType: 'squircle' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              (settings.borderRadiusType ?? 'squircle') === 'squircle'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <Square className="w-3.5 h-3.5" style={{ borderRadius: '30%' }} />
            Squircle
          </button>
          <button
            onClick={() => onSettingsChange({ borderRadiusType: 'rounded' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              settings.borderRadiusType === 'rounded'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <Circle className="w-3.5 h-3.5" />
            Rounded
          </button>
        </div>
      </div>

      {/* Shadow */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" />
            Shadow
          </Label>
          <Switch
            checked={settings.shadowEnabled}
            onCheckedChange={(checked) => onSettingsChange({ shadowEnabled: checked })}
          />
        </div>
        {settings.shadowEnabled && (
          <div className="space-y-3">
            {/* Quick intensity slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[var(--ink-muted)]">Intensity</Label>
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
                className="w-full"
              />
            </div>

            {/* Advanced shadow toggle */}
            <button
              onClick={() => setShowAdvancedShadow(!showAdvancedShadow)}
              className="w-full flex items-center justify-between py-2 px-3 rounded-lg text-xs font-medium text-[var(--ink-muted)] bg-[var(--card)] hover:bg-[var(--polar-ice)] border border-[var(--polar-frost)] transition-colors"
            >
              <span>Advanced Settings</span>
              {showAdvancedShadow ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showAdvancedShadow && (
              <div className="space-y-3 p-3 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)]">
                {/* Shadow Size */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-[var(--ink-muted)]">Size</Label>
                    <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(localShadowSize)}</span>
                  </div>
                  <Slider
                    value={[localShadowSize]}
                    onValueChange={([value]) => {
                      setLocalShadowSize(value);
                      onSettingsChange({ shadowSize: value });
                    }}
                    min={0}
                    max={100}
                    step={1}
                    className="w-full"
                  />
                </div>

                {/* Shadow Opacity */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-[var(--ink-muted)]">Opacity</Label>
                    <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(localShadowOpacity)}%</span>
                  </div>
                  <Slider
                    value={[localShadowOpacity]}
                    onValueChange={([value]) => {
                      setLocalShadowOpacity(value);
                      onSettingsChange({ shadowOpacity: value });
                    }}
                    min={0}
                    max={100}
                    step={1}
                    className="w-full"
                  />
                </div>

                {/* Shadow Blur */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-[var(--ink-muted)]">Blur</Label>
                    <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(localShadowBlur)}</span>
                  </div>
                  <Slider
                    value={[localShadowBlur]}
                    onValueChange={([value]) => {
                      setLocalShadowBlur(value);
                      onSettingsChange({ shadowBlur: value });
                    }}
                    min={0}
                    max={100}
                    step={1}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Border */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium flex items-center gap-1.5">
            <RectangleHorizontal className="w-3.5 h-3.5" />
            Border
          </Label>
          <Switch
            checked={settings.borderEnabled ?? false}
            onCheckedChange={(checked) => onSettingsChange({ borderEnabled: checked })}
          />
        </div>
        {(settings.borderEnabled ?? false) && (
          <div className="space-y-3">
            {/* Border Width */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[var(--ink-muted)]">Width</Label>
                <span className="text-xs text-[var(--ink-dark)] font-mono">{localBorderWidth}px</span>
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
                className="w-full"
              />
            </div>

            {/* Border Color */}
            <div className="space-y-2">
              <Label className="text-xs text-[var(--ink-muted)]">Color</Label>
              <ColorPicker
                value={settings.borderColor ?? '#ffffff'}
                onChange={(color) => onSettingsChange({ borderColor: color })}
                presets={COLOR_PRESETS}
              />
            </div>

            {/* Border Opacity */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[var(--ink-muted)]">Opacity</Label>
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
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BackgroundSettings;
