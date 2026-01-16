/**
 * TextSegmentConfig - Configuration panel for text segments.
 * Uses Cap's simplified model: content, center positioning, size, basic font properties.
 */
import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Italic } from 'lucide-react';
import { Slider } from '../../components/ui/slider';
import type { TextSegment } from '../../types';

export interface TextSegmentConfigProps {
  segment: TextSegment;
  onUpdate: (updates: Partial<TextSegment>) => void;
  onDelete: () => void;
  onDone: () => void;
}

// Default font families (fallback if system fonts fail to load)
const DEFAULT_FONT_FAMILIES = [
  'sans-serif',
  'serif',
  'monospace',
];

// Weight labels for display
const WEIGHT_LABELS: Record<number, string> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

export function TextSegmentConfig({ segment, onUpdate, onDelete, onDone }: TextSegmentConfigProps) {
  // System fonts state - start with defaults + current font
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  // Available font weights for the selected font
  const [availableWeights, setAvailableWeights] = useState<number[]>([400, 700]);

  // Ensure current font is always in the list, even before system fonts load
  const fontFamilies = useMemo(() => {
    const fonts = systemFonts.length > 0 ? systemFonts : DEFAULT_FONT_FAMILIES;
    // Add current font if not in list
    if (segment.fontFamily && !fonts.includes(segment.fontFamily)) {
      return [segment.fontFamily, ...fonts];
    }
    return fonts;
  }, [systemFonts, segment.fontFamily]);

  // Fetch system fonts on mount
  useEffect(() => {
    invoke<string[]>('get_system_fonts')
      .then((fonts) => {
        if (fonts && fonts.length > 0) {
          setSystemFonts(fonts);
        }
      })
      .catch((err) => {
        console.warn('Failed to load system fonts:', err);
      });
  }, []);

  // Fetch available weights when font family changes
  useEffect(() => {
    if (!segment.fontFamily || segment.fontFamily === 'sans-serif') {
      // Generic fonts - show common weights
      setAvailableWeights([400, 700]);
      return;
    }

    invoke<number[]>('get_font_weights', { family: segment.fontFamily })
      .then((weights) => {
        if (weights && weights.length > 0) {
          setAvailableWeights(weights);
          // If current weight isn't available, switch to closest available
          if (!weights.includes(segment.fontWeight)) {
            const closest = weights.reduce((prev, curr) =>
              Math.abs(curr - segment.fontWeight) < Math.abs(prev - segment.fontWeight) ? curr : prev
            );
            onUpdate({ fontWeight: closest });
          }
        }
      })
      .catch((err) => {
        console.warn('Failed to load font weights:', err);
        setAvailableWeights([400, 700]); // Fallback
      });
  }, [segment.fontFamily]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onDone}
            className="h-7 px-2.5 bg-[var(--coral-100)] hover:bg-[var(--coral-200)] text-[var(--coral-400)] text-xs font-medium rounded-md transition-colors"
          >
            Done
          </button>
          <span className="text-xs text-[var(--ink-subtle)]">Text segment</span>
        </div>
        <button
          onClick={onDelete}
          className="h-7 px-2.5 bg-[var(--error-light)] hover:bg-[rgba(239,68,68,0.2)] text-[var(--error)] text-xs rounded-md transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Text Content */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Text</span>
        <textarea
          value={segment.content}
          onChange={(e) => onUpdate({ content: e.target.value })}
          placeholder="Enter text..."
          className="w-full h-20 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2 py-1.5 resize-none"
        />
      </div>

      {/* Font Family */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Font</span>
        <select
          value={segment.fontFamily}
          onChange={(e) => onUpdate({ fontFamily: e.target.value })}
          className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
        >
          {fontFamilies.map((font) => (
            <option key={font} value={font} style={{ fontFamily: font }}>
              {font}
            </option>
          ))}
        </select>
      </div>

      {/* Font Size */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Size</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{segment.fontSize}px</span>
        </div>
        <Slider
          value={[segment.fontSize]}
          min={12}
          max={200}
          step={2}
          onValueChange={(values) => onUpdate({ fontSize: values[0] })}
        />
      </div>

      {/* Font Style Row */}
      <div className="flex items-center gap-2">
        {/* Font Weight */}
        <div className="flex-1">
          <span className="text-xs text-[var(--ink-muted)] block mb-2">Weight</span>
          <select
            value={segment.fontWeight}
            onChange={(e) => onUpdate({ fontWeight: parseInt(e.target.value) })}
            className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
          >
            {availableWeights.map((weight) => (
              <option key={weight} value={weight}>
                {WEIGHT_LABELS[weight] || `Weight ${weight}`}
              </option>
            ))}
          </select>
        </div>

        {/* Italic Toggle */}
        <div>
          <span className="text-xs text-[var(--ink-muted)] block mb-2">Style</span>
          <button
            onClick={() => onUpdate({ italic: !segment.italic })}
            className={`h-8 w-8 flex items-center justify-center rounded-md border transition-colors ${
              segment.italic
                ? 'bg-[var(--coral-100)] border-[var(--coral-300)] text-[var(--coral-500)]'
                : 'bg-[var(--polar-mist)] border-[var(--glass-border)] text-[var(--ink-muted)]'
            }`}
          >
            <Italic className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Text Color */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--ink-muted)]">Text Color</span>
        <input
          type="color"
          value={segment.color}
          onChange={(e) => onUpdate({ color: e.target.value })}
          className="w-8 h-6 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
        />
      </div>

      {/* Fade Duration */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Fade Duration</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{segment.fadeDuration.toFixed(2)}s</span>
        </div>
        <Slider
          value={[segment.fadeDuration * 100]}
          min={0}
          max={100}
          step={5}
          onValueChange={(values) => onUpdate({ fadeDuration: values[0] / 100 })}
        />
      </div>

      {/* Position info */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="text-xs">
          <span className="text-[var(--ink-subtle)]">Center Position</span>
          <p className="text-[var(--ink-dark)] font-mono mt-0.5">
            {Math.round(segment.center.x * 100)}%, {Math.round(segment.center.y * 100)}%
          </p>
        </div>
        <p className="text-[10px] text-[var(--ink-faint)] mt-2">
          Drag the text on the preview to reposition
        </p>
      </div>
    </div>
  );
}
