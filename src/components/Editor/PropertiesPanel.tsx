import React from 'react';
import {
  Layers,
  Sparkles,
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
import { useEditorStore } from '../../stores/editorStore';
import { useEditorHistory } from '../../hooks/useEditorHistory';
import { type Tool } from '../../types';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ColorPicker } from '@/components/ui/color-picker';
import { BackgroundSettings, TextToolSettings } from './properties';

// Color presets for quick selection
const COLOR_PRESETS = [
  '#EF4444', '#F97316', '#F97066', '#22C55E',
  '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF', '#1A1A1A',
];

// Stroke width presets
const STROKE_PRESETS = [1, 2, 3, 4, 6, 8];

// Quick style presets per tool type
const STROKE_PRESETS_DATA = [
  { id: 'bug', name: 'Bug', stroke: '#EF4444', strokeWidth: 3 },
  { id: 'tutorial', name: 'Tutorial', stroke: '#3B82F6', strokeWidth: 2 },
  { id: 'warning', name: 'Warning', stroke: '#F97316', strokeWidth: 3 },
  { id: 'subtle', name: 'Subtle', stroke: '#6B7280', strokeWidth: 1 },
];

const HIGHLIGHT_PRESETS_DATA = [
  { id: 'yellow', name: 'Yellow', fill: 'rgba(255, 235, 59, 0.4)' },
  { id: 'green', name: 'Green', fill: 'rgba(76, 175, 80, 0.4)' },
  { id: 'pink', name: 'Pink', fill: 'rgba(233, 30, 99, 0.4)' },
  { id: 'blue', name: 'Blue', fill: 'rgba(33, 150, 243, 0.4)' },
];

// Tool display info
const TOOL_INFO: Record<Tool, { icon: React.ElementType; label: string }> = {
  select: { icon: MousePointer2, label: 'Select' },
  crop: { icon: Crop, label: 'Crop' },
  arrow: { icon: MoveUpRight, label: 'Arrow' },
  line: { icon: Minus, label: 'Line' },
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

  const { recordAction } = useEditorHistory();

  // Get selected shapes
  const selectedShapes = shapes.filter(s => selectedIds.includes(s.id));
  const hasSelection = selectedShapes.length > 0;
  const singleSelection = selectedShapes.length === 1 ? selectedShapes[0] : null;

  // Default fallback color when both stroke and fill would be transparent
  const FALLBACK_COLOR = '#1A1A1A';

  // Handle stroke color change - updates global state and selected shapes
  const handleStrokeColorChange = (color: string) => {
    // If setting stroke to transparent and fill is also transparent, set fill to solid
    if (color === 'transparent' && fillColor === 'transparent') {
      onFillColorChange(FALLBACK_COLOR);
      // Also update selected shapes' fill
      if (hasSelection) {
        recordAction(() => {
          selectedShapes.forEach(shape => {
            if (shape.type === 'rect' || shape.type === 'circle') {
              updateShape(shape.id, { fill: FALLBACK_COLOR });
            }
          });
        });
      }
    }

    onStrokeColorChange(color);

    // Update selected shapes
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'arrow' || shape.type === 'line' || shape.type === 'rect' || shape.type === 'circle' || shape.type === 'pen' || shape.type === 'text') {
            updateShape(shape.id, { stroke: color });
          } else if (shape.type === 'step') {
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
    // If setting fill to transparent and stroke is also transparent, set stroke to solid
    if (color === 'transparent' && strokeColor === 'transparent') {
      onStrokeColorChange(FALLBACK_COLOR);
      // Also update selected shapes' stroke
      if (hasSelection) {
        recordAction(() => {
          selectedShapes.forEach(shape => {
            if (shape.type === 'rect' || shape.type === 'circle') {
              updateShape(shape.id, { stroke: FALLBACK_COLOR });
            }
          });
        });
      }
    }

    onFillColorChange(color);

    // Update selected shapes (rect, circle, and text)
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'rect' || shape.type === 'circle' || shape.type === 'text') {
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
          if (shape.type === 'arrow' || shape.type === 'line' || shape.type === 'rect' || shape.type === 'circle' || shape.type === 'pen') {
            updateShape(shape.id, { strokeWidth: width });
          }
        });
      });
    }
  };

  // Handle blur type change - updates global state and selected blur shapes
  const handleBlurTypeChange = (type: 'pixelate' | 'gaussian') => {
    setBlurType(type);

    // Update selected blur shapes
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'blur') {
            updateShape(shape.id, { blurType: type });
          }
        });
      });
    }
  };

  // Handle blur amount change - updates global state and selected blur shapes
  const handleBlurAmountChange = (amount: number) => {
    setBlurAmount(amount);

    // Update selected blur shapes
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'blur') {
            updateShape(shape.id, { blurAmount: amount, pixelSize: amount });
          }
        });
      });
    }
  };

  // Apply a stroke-based preset (arrow, line, pen)
  const applyStrokePreset = (preset: typeof STROKE_PRESETS_DATA[0]) => {
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'arrow') {
            // Arrow needs both stroke (line) and fill (arrowhead)
            updateShape(shape.id, { stroke: preset.stroke, fill: preset.stroke, strokeWidth: preset.strokeWidth });
          } else if (shape.type === 'line' || shape.type === 'pen') {
            updateShape(shape.id, { stroke: preset.stroke, strokeWidth: preset.strokeWidth });
          }
        });
      });
    }
    onStrokeColorChange(preset.stroke);
    onFillColorChange(preset.stroke); // For new arrows, set fill to match
    onStrokeWidthChange(preset.strokeWidth);
  };

  // Apply a fill-based preset (rect, circle) - applies both stroke and fill
  const applyShapePreset = (preset: typeof STROKE_PRESETS_DATA[0]) => {
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'rect' || shape.type === 'circle') {
            updateShape(shape.id, { stroke: preset.stroke, strokeWidth: preset.strokeWidth });
          }
        });
      });
    }
    onStrokeColorChange(preset.stroke);
    onStrokeWidthChange(preset.strokeWidth);
  };

  // Apply a highlight preset
  const applyHighlightPreset = (preset: typeof HIGHLIGHT_PRESETS_DATA[0]) => {
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'highlight') {
            updateShape(shape.id, { fill: preset.fill });
          }
        });
      });
    }
    // Extract color from rgba for stroke color default
    const match = preset.fill.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const hex = `#${parseInt(match[1]).toString(16).padStart(2, '0')}${parseInt(match[2]).toString(16).padStart(2, '0')}${parseInt(match[3]).toString(16).padStart(2, '0')}`;
      onStrokeColorChange(hex);
    }
  };

  // Apply a steps/badge preset
  const applyStepsPreset = (preset: typeof STROKE_PRESETS_DATA[0]) => {
    if (hasSelection) {
      recordAction(() => {
        selectedShapes.forEach(shape => {
          if (shape.type === 'step') {
            updateShape(shape.id, { fill: preset.stroke });
          }
        });
      });
    }
    onStrokeColorChange(preset.stroke);
  };

  // Map shape type to corresponding tool
  const shapeTypeToTool = (shapeType: string): Tool => {
    const mapping: Record<string, Tool> = {
      arrow: 'arrow',
      line: 'line',
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
    const strokeTools: Tool[] = ['arrow', 'line', 'rect', 'circle', 'pen'];
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

        {/* Quick Styles - Arrow, Line, Pen (stroke-only tools) */}
        {(effectiveTool === 'arrow' || effectiveTool === 'line' || effectiveTool === 'pen') && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Quick Styles</Label>
            <div className="flex gap-2">
              {STROKE_PRESETS_DATA.map((preset) => {
                const isActive = strokeColor === preset.stroke && strokeWidth === preset.strokeWidth;
                const IconComponent = effectiveTool === 'arrow' ? MoveUpRight : effectiveTool === 'line' ? Minus : Pencil;
                return (
                  <button
                    key={preset.id}
                    onClick={() => applyStrokePreset(preset)}
                    className={`flex-1 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all border ${
                      isActive
                        ? 'bg-[var(--coral-50)] border-[var(--coral-200)]'
                        : 'bg-[var(--card)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
                    }`}
                    title={`${preset.name}: ${preset.strokeWidth}px`}
                  >
                    <IconComponent
                      size={20}
                      style={{ color: preset.stroke, strokeWidth: preset.strokeWidth * 0.8 }}
                    />
                    <span className={`text-[10px] font-medium ${isActive ? 'text-[var(--coral-500)]' : 'text-[var(--ink-muted)]'}`}>
                      {preset.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick Styles - Rect, Circle (stroke + fill tools) */}
        {(effectiveTool === 'rect' || effectiveTool === 'circle') && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Quick Styles</Label>
            <div className="flex gap-2">
              {STROKE_PRESETS_DATA.map((preset) => {
                const isActive = strokeColor === preset.stroke && strokeWidth === preset.strokeWidth;
                const IconComponent = effectiveTool === 'rect' ? Square : Circle;
                return (
                  <button
                    key={preset.id}
                    onClick={() => applyShapePreset(preset)}
                    className={`flex-1 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all border ${
                      isActive
                        ? 'bg-[var(--coral-50)] border-[var(--coral-200)]'
                        : 'bg-[var(--card)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
                    }`}
                    title={`${preset.name}: ${preset.strokeWidth}px`}
                  >
                    <IconComponent
                      size={20}
                      style={{ color: preset.stroke, strokeWidth: preset.strokeWidth * 0.8 }}
                    />
                    <span className={`text-[10px] font-medium ${isActive ? 'text-[var(--coral-500)]' : 'text-[var(--ink-muted)]'}`}>
                      {preset.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick Styles - Highlight */}
        {effectiveTool === 'highlight' && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Quick Styles</Label>
            <div className="flex gap-2">
              {HIGHLIGHT_PRESETS_DATA.map((preset) => {
                // Check if this preset's fill matches
                const selectedHighlight = singleSelection?.type === 'highlight' ? singleSelection : null;
                const isActive = selectedHighlight?.fill === preset.fill;
                return (
                  <button
                    key={preset.id}
                    onClick={() => applyHighlightPreset(preset)}
                    className={`flex-1 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all border ${
                      isActive
                        ? 'bg-[var(--coral-50)] border-[var(--coral-200)]'
                        : 'bg-[var(--card)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
                    }`}
                    title={preset.name}
                  >
                    <div
                      className="w-8 h-4 rounded"
                      style={{ backgroundColor: preset.fill }}
                    />
                    <span className={`text-[10px] font-medium ${isActive ? 'text-[var(--coral-500)]' : 'text-[var(--ink-muted)]'}`}>
                      {preset.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick Styles - Steps/Badge */}
        {effectiveTool === 'steps' && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Quick Styles</Label>
            <div className="flex gap-2">
              {STROKE_PRESETS_DATA.map((preset) => {
                const isActive = strokeColor === preset.stroke;
                return (
                  <button
                    key={preset.id}
                    onClick={() => applyStepsPreset(preset)}
                    className={`flex-1 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all border ${
                      isActive
                        ? 'bg-[var(--coral-50)] border-[var(--coral-200)]'
                        : 'bg-[var(--card)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
                    }`}
                    title={preset.name}
                  >
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                      style={{ backgroundColor: preset.stroke }}
                    >
                      1
                    </div>
                    <span className={`text-[10px] font-medium ${isActive ? 'text-[var(--coral-500)]' : 'text-[var(--ink-muted)]'}`}>
                      {preset.name}
                    </span>
                  </button>
                );
              })}
            </div>
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
              showTransparent
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

        {/* Text Color for text tool - uses fillColor */}
        {effectiveTool === 'text' && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Text Color</Label>
            <ColorPicker
              value={fillColor}
              onChange={handleFillColorChange}
              presets={COLOR_PRESETS}
            />
          </div>
        )}

        {/* Badge Color for steps tool - uses strokeColor */}
        {effectiveTool === 'steps' && (
          <div className="space-y-3">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Badge Color</Label>
            <ColorPicker
              value={strokeColor}
              onChange={handleStrokeColorChange}
              presets={COLOR_PRESETS}
            />
          </div>
        )}

        {/* Text Tool Settings */}
        {effectiveTool === 'text' && (
          <TextToolSettings
            textShape={singleSelection?.type === 'text' ? singleSelection : null}
            strokeColor={strokeColor}
            strokeWidth={strokeWidth}
            onStrokeColorChange={onStrokeColorChange}
            onStrokeWidthChange={onStrokeWidthChange}
          />
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
                          : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
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
                        : 'bg-[var(--card)] text-[var(--ink-muted)] border border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
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
                  onClick={() => handleBlurTypeChange('pixelate')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
                    blurType === 'pixelate'
                      ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                      : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
                  }`}
                >
                  <Grid3X3 className="w-3.5 h-3.5" />
                  Pixelate
                </button>
                <button
                  onClick={() => handleBlurTypeChange('gaussian')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium transition-all border ${
                    blurType === 'gaussian'
                      ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                      : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  Gaussian
                </button>
              </div>
            </div>
            <Separator className="bg-[var(--polar-frost)]" />
            <div className="space-y-3">
              <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Intensity</Label>
              <div className="flex gap-2">
                {[
                  { label: 'Weak', value: 8 },
                  { label: 'Medium', value: 15 },
                  { label: 'Strong', value: 25 },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    onClick={() => handleBlurAmountChange(value)}
                    className={`flex-1 h-8 rounded-lg text-xs font-medium transition-all ${
                      blurAmount === value
                        ? 'bg-[var(--coral-50)] border border-[var(--coral-300)] text-[var(--coral-500)]'
                        : 'bg-[var(--card)] border border-[var(--polar-frost)] hover:bg-[var(--polar-ice)] text-[var(--ink-muted)]'
                    }`}
                  >
                    {label}
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
            {compositorSettings.enabled && (
              <BackgroundSettings
                settings={compositorSettings}
                onSettingsChange={setCompositorSettings}
              />
            )}
          </div>
        )}
      </div>
    );
  };

  // Get the header info based on effective tool
  const toolInfo = TOOL_INFO[effectiveTool];
  const HeaderIcon = toolInfo.icon;

  return (
    <div className="compositor-sidebar w-92 flex flex-col flex-shrink-0 h-full">
      {/* Header */}
      <div className="properties-panel-header">
        <div className="flex items-center gap-2">
          <HeaderIcon className="w-4 h-4 text-[var(--coral-400)]" />
          <span className="text-sm font-medium text-[var(--ink-black)]">{toolInfo.label}</span>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 overflow-y-auto flex-1 relative z-10">
        {renderToolProperties()}
      </div>
    </div>
  );
};
