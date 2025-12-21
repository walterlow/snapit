import React from 'react';
import {
  Palette,
  Image as ImageIcon,
  Sun,
  Layers,
  RectangleHorizontal,
  Sparkles,
  Check,
  Upload,
  X,
  MousePointer2,
  Minus,
  Type,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore';
import { GRADIENT_PRESETS, DEFAULT_WALLPAPERS, WALLPAPER_THUMBNAILS, type GradientStop, type CanvasShape } from '../../types';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// Color presets for quick selection
const COLOR_PRESETS = [
  '#EF4444', '#F97316', '#FBBF24', '#22C55E', 
  '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF', '#000000',
];

// Stroke width presets
const STROKE_PRESETS = [1, 2, 3, 4, 6, 8];

export const PropertiesPanel: React.FC = () => {
  const { 
    shapes,
    selectedIds, 
    updateShape,
    compositorSettings, 
    setCompositorSettings 
  } = useEditorStore();

  // Get selected shapes
  const selectedShapes = shapes.filter(s => selectedIds.includes(s.id));
  const hasSelection = selectedShapes.length > 0;
  const singleSelection = selectedShapes.length === 1 ? selectedShapes[0] : null;

  // Local state for live preview during slider drag
  const [localPadding, setLocalPadding] = React.useState(compositorSettings.padding);
  const [localBorderRadius, setLocalBorderRadius] = React.useState(compositorSettings.borderRadius);
  const [localShadowIntensity, setLocalShadowIntensity] = React.useState(compositorSettings.shadowIntensity);
  const [localGradientAngle, setLocalGradientAngle] = React.useState(compositorSettings.gradientAngle);

  // Sync local state when store changes
  React.useEffect(() => {
    setLocalPadding(compositorSettings.padding);
    setLocalBorderRadius(compositorSettings.borderRadius);
    setLocalShadowIntensity(compositorSettings.shadowIntensity);
    setLocalGradientAngle(compositorSettings.gradientAngle);
  }, [compositorSettings.padding, compositorSettings.borderRadius, compositorSettings.shadowIntensity, compositorSettings.gradientAngle]);

  const handleGradientPreset = (stops: GradientStop[]) => {
    setCompositorSettings({ gradientStops: stops, backgroundType: 'gradient' });
  };

  const getGradientStyle = (stops: GradientStop[], angle: number = 135) => {
    const gradientStops = stops
      .map((s) => `${s.color} ${s.position}%`)
      .join(', ');
    return `linear-gradient(${angle}deg, ${gradientStops})`;
  };

  // Update all selected shapes with a property
  const updateSelectedShapes = (updates: Partial<CanvasShape>) => {
    selectedIds.forEach(id => updateShape(id, updates));
  };

  // Get common value across selected shapes (for showing in UI)
  const getCommonValue = <K extends keyof CanvasShape>(key: K): CanvasShape[K] | undefined => {
    if (selectedShapes.length === 0) return undefined;
    const firstValue = selectedShapes[0][key];
    const allSame = selectedShapes.every(s => s[key] === firstValue);
    return allSame ? firstValue : undefined;
  };

  // Render shape properties
  const renderShapeProperties = () => {
    const shapeType = singleSelection?.type || (selectedShapes.length > 0 ? 'multiple' : null);
    const commonStroke = getCommonValue('stroke');
    const commonFill = getCommonValue('fill');
    const commonStrokeWidth = getCommonValue('strokeWidth');

    return (
      <div className="space-y-5">
        {/* Selection Info */}
        <div className="flex items-center gap-2 text-zinc-300">
          <MousePointer2 className="w-4 h-4 text-amber-400" />
          <span className="text-sm">
            {selectedShapes.length === 1 
              ? `${singleSelection?.type?.charAt(0).toUpperCase()}${singleSelection?.type?.slice(1)}` 
              : `${selectedShapes.length} objects selected`}
          </span>
        </div>

        {/* Stroke Color */}
        {(shapeType === 'arrow' || shapeType === 'rect' || shapeType === 'circle' || shapeType === 'multiple') && (
          <div className="space-y-3">
            <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Stroke Color</Label>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  onClick={() => updateSelectedShapes({ stroke: color })}
                  className={`w-7 h-7 rounded-lg border-2 transition-all hover:scale-110 ${
                    commonStroke === color ? 'border-amber-400' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={commonStroke || '#ef4444'}
                onChange={(e) => updateSelectedShapes({ stroke: e.target.value })}
                className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent"
              />
              <input
                type="text"
                value={commonStroke || ''}
                onChange={(e) => updateSelectedShapes({ stroke: e.target.value })}
                placeholder="Mixed"
                className="flex-1 h-8 px-2 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 font-mono"
              />
            </div>
          </div>
        )}

        {/* Fill Color */}
        {(shapeType === 'rect' || shapeType === 'circle' || shapeType === 'text' || shapeType === 'step' || shapeType === 'multiple') && (
          <div className="space-y-3">
            <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Fill Color</Label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => updateSelectedShapes({ fill: 'transparent' })}
                className={`w-7 h-7 rounded-lg border-2 transition-all hover:scale-110 flex items-center justify-center ${
                  commonFill === 'transparent' ? 'border-amber-400' : 'border-zinc-600'
                }`}
                style={{ background: 'repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px' }}
              >
                <X className="w-3 h-3 text-zinc-400" />
              </button>
              {COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  onClick={() => updateSelectedShapes({ fill: color })}
                  className={`w-7 h-7 rounded-lg border-2 transition-all hover:scale-110 ${
                    commonFill === color ? 'border-amber-400' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Stroke Width */}
        {(shapeType === 'arrow' || shapeType === 'rect' || shapeType === 'circle' || shapeType === 'multiple') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium flex items-center gap-1.5">
                <Minus className="w-3.5 h-3.5" />
                Stroke Width
              </Label>
              <span className="text-xs text-zinc-300 font-mono">{commonStrokeWidth ?? '-'}px</span>
            </div>
            <div className="flex gap-2">
              {STROKE_PRESETS.map((width) => (
                <button
                  key={width}
                  onClick={() => updateSelectedShapes({ strokeWidth: width })}
                  className={`flex-1 h-8 rounded-lg flex items-center justify-center transition-all ${
                    commonStrokeWidth === width
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                      : 'bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700'
                  }`}
                >
                  <div 
                    className="rounded-full bg-current"
                    style={{ width: Math.min(width * 2, 12), height: Math.min(width * 2, 12) }}
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Text-specific properties */}
        {shapeType === 'text' && singleSelection && (
          <div className="space-y-3">
            <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium flex items-center gap-1.5">
              <Type className="w-3.5 h-3.5" />
              Font Size
            </Label>
            <div className="flex gap-2">
              {[12, 14, 16, 20, 24, 32].map((size) => (
                <button
                  key={size}
                  onClick={() => updateShape(singleSelection.id, { fontSize: size })}
                  className={`flex-1 h-8 rounded-lg text-xs font-medium transition-all ${
                    singleSelection.fontSize === size
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                      : 'bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render background compositor settings
  const renderBackgroundSettings = () => (
    <div className="space-y-5">
      {/* Background Type */}
      <div className="space-y-3">
        <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Type</Label>
        <div className="flex gap-2">
          <button
            onClick={() => setCompositorSettings({ backgroundType: 'solid' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              compositorSettings.backgroundType === 'solid'
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:text-zinc-100 hover:bg-zinc-700'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            Solid
          </button>
          <button
            onClick={() => setCompositorSettings({ backgroundType: 'gradient' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              compositorSettings.backgroundType === 'gradient'
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:text-zinc-100 hover:bg-zinc-700'
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            Gradient
          </button>
          <button
            onClick={() => setCompositorSettings({ backgroundType: 'image' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              compositorSettings.backgroundType === 'image'
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:text-zinc-100 hover:bg-zinc-700'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            Image
          </button>
        </div>
      </div>

      {/* Solid Color Picker */}
      {compositorSettings.backgroundType === 'solid' && (
        <div className="space-y-3">
          <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Color</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={compositorSettings.backgroundColor}
              onChange={(e) => setCompositorSettings({ backgroundColor: e.target.value })}
              className="w-10 h-10 rounded-lg cursor-pointer border-0 bg-transparent"
            />
            <input
              type="text"
              value={compositorSettings.backgroundColor}
              onChange={(e) => setCompositorSettings({ backgroundColor: e.target.value })}
              className="flex-1 h-9 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 font-mono"
            />
          </div>
        </div>
      )}

      {/* Gradient Presets */}
      {compositorSettings.backgroundType === 'gradient' && (
        <div className="space-y-3">
          <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Gradient Presets</Label>
          <div className="grid grid-cols-4 gap-2">
            {GRADIENT_PRESETS.map((preset, idx) => (
              <button
                key={idx}
                onClick={() => handleGradientPreset(preset.stops)}
                className="w-full aspect-square rounded-lg border-2 transition-all hover:scale-105"
                style={{
                  background: getGradientStyle(preset.stops),
                  borderColor:
                    JSON.stringify(compositorSettings.gradientStops) === JSON.stringify(preset.stops)
                      ? '#fbbf24'
                      : 'transparent',
                }}
                title={preset.name}
              />
            ))}
          </div>
          {/* Gradient Angle */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-zinc-400">Angle</Label>
              <span className="text-xs text-zinc-300 font-mono">{localGradientAngle}°</span>
            </div>
            <Slider
              value={[localGradientAngle]}
              onValueChange={([value]) => {
                setLocalGradientAngle(value);
                setCompositorSettings({ gradientAngle: value });
              }}
              onValueCommit={([value]) => setCompositorSettings({ gradientAngle: value })}
              min={0}
              max={360}
              step={15}
              className="w-full"
            />
          </div>
        </div>
      )}

      {/* Image Upload */}
      {compositorSettings.backgroundType === 'image' && (
        <div className="space-y-4">
          {/* Default Wallpapers Gallery */}
          <div className="space-y-3">
            <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Wallpapers</Label>
            <div className="grid grid-cols-4 gap-2">
              {DEFAULT_WALLPAPERS.map((wallpaper, idx) => (
                <button
                  key={idx}
                  onClick={() => setCompositorSettings({ backgroundImage: wallpaper })}
                  className={`aspect-[16/10] rounded-lg overflow-hidden border-2 transition-transform hover:scale-105 relative ${
                    compositorSettings.backgroundImage === wallpaper 
                      ? 'border-amber-400' 
                      : 'border-transparent hover:border-zinc-600'
                  }`}
                >
                  <img
                    src={WALLPAPER_THUMBNAILS[idx]}
                    alt={`Wallpaper ${idx + 1}`}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                  {compositorSettings.backgroundImage === wallpaper && (
                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-amber-400 flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-zinc-900" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Upload */}
          <div className="space-y-3">
            <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Or Upload Custom</Label>
            <label className="flex flex-col items-center justify-center h-16 rounded-lg border-2 border-dashed border-zinc-700 bg-zinc-800/50 cursor-pointer hover:border-amber-400/50 hover:bg-zinc-800 transition-colors">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-zinc-400" />
                <span className="text-xs text-zinc-400">Click to upload</span>
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
                      setCompositorSettings({ backgroundImage: ev.target?.result as string });
                    };
                    reader.readAsDataURL(file);
                  }
                }}
              />
            </label>
          </div>

          {/* Clear button */}
          {compositorSettings.backgroundImage && (
            <button
              onClick={() => setCompositorSettings({ backgroundImage: null })}
              className="w-full py-2 px-3 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 transition-colors flex items-center justify-center gap-2"
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
          <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium">Padding</Label>
          <span className="text-xs text-zinc-300 font-mono">{localPadding}%</span>
        </div>
        <Slider
          value={[localPadding]}
          onValueChange={([value]) => {
            setLocalPadding(value);
            setCompositorSettings({ padding: value });
          }}
          onValueCommit={([value]) => setCompositorSettings({ padding: value })}
          min={0}
          max={30}
          step={1}
          className="w-full"
        />
      </div>

      {/* Border Radius */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium flex items-center gap-1.5">
            <RectangleHorizontal className="w-3.5 h-3.5" />
            Corner Radius
          </Label>
          <span className="text-xs text-zinc-300 font-mono">{localBorderRadius}px</span>
        </div>
        <Slider
          value={[localBorderRadius]}
          onValueChange={([value]) => {
            setLocalBorderRadius(value);
            setCompositorSettings({ borderRadius: value });
          }}
          onValueCommit={([value]) => setCompositorSettings({ borderRadius: value })}
          min={0}
          max={48}
          step={2}
          className="w-full"
        />
      </div>

      {/* Shadow */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-zinc-400 uppercase tracking-wide font-medium flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" />
            Shadow
          </Label>
          <Switch
            checked={compositorSettings.shadowEnabled}
            onCheckedChange={(checked) => setCompositorSettings({ shadowEnabled: checked })}
          />
        </div>
        {compositorSettings.shadowEnabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-zinc-400">Intensity</Label>
              <span className="text-xs text-zinc-300 font-mono">{Math.round(localShadowIntensity * 100)}%</span>
            </div>
            <Slider
              value={[localShadowIntensity * 100]}
              onValueChange={([value]) => {
                setLocalShadowIntensity(value / 100);
                setCompositorSettings({ shadowIntensity: value / 100 });
              }}
              onValueCommit={([value]) => setCompositorSettings({ shadowIntensity: value / 100 })}
              min={0}
              max={100}
              step={5}
              className="w-full"
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="w-72 bg-zinc-900 border-l border-zinc-700/50 flex flex-col flex-shrink-0 h-full shadow-2xl shadow-black/50">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-zinc-700/50 flex-shrink-0 bg-zinc-900">
        <div className="flex items-center gap-2">
          {hasSelection ? (
            <>
              <MousePointer2 className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-zinc-100">Selection</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-zinc-100">Background</span>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4 overflow-y-auto flex-1">
        {hasSelection ? renderShapeProperties() : renderBackgroundSettings()}
      </div>
    </div>
  );
};
