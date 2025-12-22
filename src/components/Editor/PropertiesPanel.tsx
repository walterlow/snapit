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
  MoveUpRight,
  Square,
  Circle,
  Highlighter,
  Grid3X3,
  Hash,
  Pencil,
  Crop,
} from 'lucide-react';
import { useEditorStore, recordAction } from '../../stores/editorStore';
import { GRADIENT_PRESETS, DEFAULT_WALLPAPERS, WALLPAPER_THUMBNAILS, type GradientStop, type Tool } from '../../types';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ColorPicker } from '@/components/ui/color-picker';

// Color presets for quick selection
const COLOR_PRESETS = [
  '#EF4444', '#F97316', '#F97066', '#22C55E',
  '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF', '#1A1A1A',
];

// Stroke width presets
const STROKE_PRESETS = [1, 2, 3, 4, 6, 8];

// Tool display info
const TOOL_INFO: Record<Tool, { icon: React.ElementType; label: string }> = {
  select: { icon: MousePointer2, label: 'Select' },
  crop: { icon: Crop, label: 'Crop' },
  arrow: { icon: MoveUpRight, label: 'Arrow' },
  rect: { icon: Square, label: 'Rectangle' },
  circle: { icon: Circle, label: 'Ellipse' },
  text: { icon: Type, label: 'Text' },
  highlight: { icon: Highlighter, label: 'Highlight' },
  blur: { icon: Grid3X3, label: 'Blur' },
  steps: { icon: Hash, label: 'Steps' },
  pen: { icon: Pencil, label: 'Pen' },
  background: { icon: Sparkles, label: 'Background' },
};

interface PropertiesPanelProps {
  selectedTool: Tool;
  strokeColor: string;
  onStrokeColorChange: (color: string) => void;
  fillColor: string;
  onFillColorChange: (color: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedTool,
  strokeColor,
  onStrokeColorChange,
  fillColor,
  onFillColorChange,
  strokeWidth,
  onStrokeWidthChange,
}) => {
  const {
    shapes,
    selectedIds,
    compositorSettings,
    setCompositorSettings,
    blurType,
    setBlurType,
    blurAmount,
    setBlurAmount,
    updateShape,
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

  // Render background compositor settings
  const renderBackgroundSettings = () => (
    <div className="space-y-5">
      {/* Background Type */}
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Type</Label>
        <div className="flex gap-2">
          <button
            onClick={() => setCompositorSettings({ backgroundType: 'solid' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              compositorSettings.backgroundType === 'solid'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-white text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            Solid
          </button>
          <button
            onClick={() => setCompositorSettings({ backgroundType: 'gradient' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              compositorSettings.backgroundType === 'gradient'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-white text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            Gradient
          </button>
          <button
            onClick={() => setCompositorSettings({ backgroundType: 'image' })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
              compositorSettings.backgroundType === 'image'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-white text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
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
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Color</Label>
          <ColorPicker
            value={compositorSettings.backgroundColor}
            onChange={(color) => setCompositorSettings({ backgroundColor: color })}
            presets={COLOR_PRESETS}
          />
        </div>
      )}

      {/* Gradient Presets */}
      {compositorSettings.backgroundType === 'gradient' && (
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
                    JSON.stringify(compositorSettings.gradientStops) === JSON.stringify(preset.stops)
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
                setCompositorSettings({ gradientAngle: value });
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
      {compositorSettings.backgroundType === 'image' && (
        <div className="space-y-4">
          {/* Default Wallpapers Gallery */}
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Wallpapers</Label>
            <div className="grid grid-cols-4 gap-2">
              {DEFAULT_WALLPAPERS.map((wallpaper, idx) => (
                <button
                  key={idx}
                  onClick={() => setCompositorSettings({ backgroundImage: wallpaper })}
                  className={`aspect-[16/10] rounded-lg overflow-hidden border-2 transition-transform hover:scale-105 relative shadow-sm ${
                    compositorSettings.backgroundImage === wallpaper
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
                  {compositorSettings.backgroundImage === wallpaper && (
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
            <label className="flex flex-col items-center justify-center h-16 rounded-lg border-2 border-dashed border-[var(--polar-frost)] bg-white cursor-pointer hover:border-[var(--coral-300)] hover:bg-[var(--coral-50)] transition-colors">
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
              className="w-full py-2 px-3 rounded-lg text-xs font-medium text-[var(--ink-muted)] bg-white hover:bg-[var(--polar-ice)] border border-[var(--polar-frost)] transition-colors flex items-center justify-center gap-2"
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
            setCompositorSettings({ padding: value });
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
            setCompositorSettings({ borderRadius: value });
          }}
          min={0}
          max={48}
          step={1}
          className="w-full"
        />
      </div>

      {/* Shadow */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium flex items-center gap-1.5">
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
              <Label className="text-xs text-[var(--ink-muted)]">Intensity</Label>
              <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(localShadowIntensity * 100)}%</span>
            </div>
            <Slider
              value={[localShadowIntensity * 100]}
              onValueChange={([value]) => {
                setLocalShadowIntensity(value / 100);
                setCompositorSettings({ shadowIntensity: value / 100 });
              }}
              min={0}
              max={100}
              step={2}
              className="w-full"
            />
          </div>
        )}
      </div>
    </div>
  );

  // Handle stroke color change - updates global state and selected shapes
  const handleStrokeColorChange = (color: string) => {
    onStrokeColorChange(color);

    // Update selected shapes
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'arrow' || shape.type === 'rect' || shape.type === 'circle' || shape.type === 'pen') {
            updateShape(shape.id, { stroke: color });
          } else if (shape.type === 'text' || shape.type === 'step') {
            updateShape(shape.id, { fill: color });
          } else if (shape.type === 'highlight') {
            // Convert hex to rgba for highlight
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            updateShape(shape.id, { fill: `rgba(${r}, ${g}, ${b}, 0.4)` });
          }
        });
      });
    }
  };

  // Handle fill color change - updates global state and selected shapes
  const handleFillColorChange = (color: string) => {
    onFillColorChange(color);

    // Update selected shapes (rect and circle)
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'rect' || shape.type === 'circle') {
            updateShape(shape.id, { fill: color });
          }
        });
      });
    }
  };

  // Handle stroke width change - updates global state and selected shapes
  const handleStrokeWidthChange = (width: number) => {
    onStrokeWidthChange(width);

    // Update selected shapes
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'arrow' || shape.type === 'rect' || shape.type === 'circle' || shape.type === 'pen') {
            updateShape(shape.id, { strokeWidth: width });
          }
        });
      });
    }
  };

  // Map shape type to corresponding tool
  const shapeTypeToTool = (shapeType: string): Tool => {
    const mapping: Record<string, Tool> = {
      arrow: 'arrow',
      rect: 'rect',
      circle: 'circle',
      text: 'text',
      highlight: 'highlight',
      blur: 'blur',
      step: 'steps',
      pen: 'pen',
    };
    return mapping[shapeType] || 'select';
  };

  // Determine effective tool based on selection or current tool
  const effectiveTool: Tool = hasSelection && singleSelection
    ? shapeTypeToTool(singleSelection.type)
    : selectedTool;

  // Render tool-specific properties
  const renderToolProperties = () => {
    // Tools that use stroke color
    const strokeTools: Tool[] = ['arrow', 'rect', 'circle', 'pen'];
    // Tools that use fill color (text color)
    const fillTools: Tool[] = ['text', 'steps'];
    // Tools that use highlight color
    const highlightTools: Tool[] = ['highlight'];

    return (
      <div className="space-y-5">
        {/* Select Tool - show tip */}
        {effectiveTool === 'select' && (
          <div className="text-xs text-[var(--ink-muted)] leading-relaxed">
            Click on shapes to select them. Drag to move, use handles to resize.
          </div>
        )}

        {/* Crop Tool - show tip */}
        {effectiveTool === 'crop' && (
          <div className="text-xs text-[var(--ink-muted)] leading-relaxed">
            Drag corners or edges to crop. Drag outside the image to expand the canvas.
          </div>
        )}

        {/* Stroke Color for drawing tools */}
        {strokeTools.includes(effectiveTool) && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Stroke Color</Label>
            <ColorPicker
              value={strokeColor}
              onChange={handleStrokeColorChange}
              presets={COLOR_PRESETS}
            />
          </div>
        )}

        {/* Fill Color for rect and circle */}
        {(effectiveTool === 'rect' || effectiveTool === 'circle') && (
          <>
            <Separator className="bg-[var(--polar-frost)]" />
            <div className="space-y-3">
              <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Fill Color</Label>
              <ColorPicker
                value={fillColor}
                onChange={handleFillColorChange}
                presets={COLOR_PRESETS}
                showTransparent
              />
            </div>
          </>
        )}

        {/* Fill/Text Color for text and steps tools */}
        {fillTools.includes(effectiveTool) && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">
              {effectiveTool === 'text' ? 'Text Color' : 'Badge Color'}
            </Label>
            <ColorPicker
              value={strokeColor}
              onChange={handleStrokeColorChange}
              presets={COLOR_PRESETS}
            />
          </div>
        )}

        {/* Step Size for steps tool */}
        {effectiveTool === 'steps' && (() => {
          const stepShapes = shapes.filter(s => s.type === 'step');
          const radii = stepShapes.map(s => s.radius ?? 15);
          const hasSteps = radii.length > 0;
          const minRadius = hasSteps ? Math.min(...radii) : 15;
          const maxRadius = hasSteps ? Math.max(...radii) : 15;
          const avgRadius = hasSteps ? Math.round(radii.reduce((a, b) => a + b, 0) / radii.length) : 15;
          const allSame = hasSteps && radii.every(r => r === radii[0]);

          return (
            <>
              <Separator className="bg-[var(--polar-frost)]" />
              <div className="space-y-3">
                <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Size</Label>
                <div className="flex gap-2">
                  {[
                    { label: 'Smallest', targetRadius: minRadius },
                    { label: 'Average', targetRadius: avgRadius },
                    { label: 'Largest', targetRadius: maxRadius },
                  ].map(({ label, targetRadius }) => (
                    <button
                      key={label}
                      disabled={!hasSteps || allSame}
                      onClick={() => {
                        recordAction(() => {
                          stepShapes.forEach(shape => {
                            updateShape(shape.id, { radius: targetRadius });
                          });
                        });
                      }}
                      className={`flex-1 h-9 rounded-lg text-xs font-medium transition-all border ${
                        !hasSteps || allSame
                          ? 'bg-[var(--polar-ice)] text-[var(--ink-muted)] border-[var(--polar-frost)] opacity-50 cursor-not-allowed'
                          : 'bg-white text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          );
        })()}

        {/* Highlight Color */}
        {highlightTools.includes(effectiveTool) && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Highlight Color</Label>
            <ColorPicker
              value={strokeColor}
              onChange={handleStrokeColorChange}
              presets={['#FFEB3B', '#FFC107', '#FF9800', '#4CAF50', '#00BCD4', '#E91E63']}
              showInput={false}
            />
          </div>
        )}

        {/* Stroke Width */}
        {[...strokeTools, 'pen'].includes(effectiveTool) && (
          <>
            <Separator className="bg-[var(--polar-frost)]" />
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium flex items-center gap-1.5">
                  <Minus className="w-3.5 h-3.5" />
                  Stroke Width
                </Label>
                <span className="text-xs text-[var(--ink-dark)] font-mono">{strokeWidth}px</span>
              </div>
              <div className="flex gap-2">
                {STROKE_PRESETS.map((width) => (
                  <button
                    key={width}
                    onClick={() => handleStrokeWidthChange(width)}
                    className={`flex-1 h-8 rounded-lg flex items-center justify-center transition-all ${
                      strokeWidth === width
                        ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border border-[var(--coral-200)]'
                        : 'bg-white text-[var(--ink-muted)] border border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
                    }`}
                  >
                    <div
                      className="rounded-full"
                      style={{
                        width: Math.min(width * 2, 12),
                        height: Math.min(width * 2, 12),
                        backgroundColor: strokeWidth === width ? 'var(--coral-400)' : 'var(--ink-muted)'
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Blur Tool Settings */}
        {effectiveTool === 'blur' && (
          <>
            <div className="space-y-3">
              <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Blur Type</Label>
              <div className="flex gap-2">
                <button
                  onClick={() => setBlurType('pixelate')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
                    blurType === 'pixelate'
                      ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                      : 'bg-white text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
                  }`}
                >
                  <Grid3X3 className="w-3.5 h-3.5" />
                  Pixelate
                </button>
                <button
                  onClick={() => setBlurType('gaussian')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
                    blurType === 'gaussian'
                      ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                      : 'bg-white text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  Gaussian
                </button>
              </div>
            </div>
            <Separator className="bg-[var(--polar-frost)]" />
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">
                  {blurType === 'pixelate' ? 'Pixel Size' : 'Blur Amount'}
                </Label>
                <span className="text-xs text-[var(--ink-dark)] font-mono">{blurAmount}px</span>
              </div>
              <div className="flex gap-2">
                {[5, 10, 15, 20, 30].map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setBlurAmount(amount)}
                    className={`flex-1 h-8 rounded-lg text-xs font-mono transition-all ${
                      blurAmount === amount
                        ? 'bg-[var(--coral-50)] border border-[var(--coral-300)] text-[var(--coral-500)]'
                        : 'bg-white border border-[var(--polar-frost)] hover:bg-[var(--polar-ice)] text-[var(--ink-muted)]'
                    }`}
                  >
                    {amount}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Background Tool Settings */}
        {effectiveTool === 'background' && (
          <div className="space-y-5">
            {/* Enable/Disable Toggle */}
            <div className="flex items-center justify-between">
              <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Enable Background</Label>
              <Switch
                checked={compositorSettings.enabled}
                onCheckedChange={(checked) => setCompositorSettings({ enabled: checked })}
              />
            </div>

            {/* Show settings only when enabled */}
            {compositorSettings.enabled && renderBackgroundSettings()}
          </div>
        )}
      </div>
    );
  };

  // Get the header info based on effective tool
  const toolInfo = TOOL_INFO[effectiveTool];
  const HeaderIcon = toolInfo.icon;

  return (
    <div className="w-72 bg-white border-l border-[var(--polar-frost)] flex flex-col flex-shrink-0 h-full shadow-lg">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-[var(--polar-frost)] flex-shrink-0 bg-[var(--polar-ice)]">
        <div className="flex items-center gap-2">
          <HeaderIcon className="w-4 h-4 text-[var(--coral-400)]" />
          <span className="text-sm font-medium text-[var(--ink-black)]">{toolInfo.label}</span>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 overflow-y-auto flex-1">
        {renderToolProperties()}
      </div>
    </div>
  );
};
