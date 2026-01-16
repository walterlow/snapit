/**
 * MaskSegmentConfig - Configuration panel for mask segments.
 * Allows editing mask type, intensity, feather, and color.
 */
import { Slider } from '../../components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import type { MaskSegment, MaskType } from '../../types';

export interface MaskSegmentConfigProps {
  segment: MaskSegment;
  onUpdate: (updates: Partial<MaskSegment>) => void;
  onDelete: () => void;
  onDone: () => void;
}

export function MaskSegmentConfig({ segment, onUpdate, onDelete, onDone }: MaskSegmentConfigProps) {
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
          <span className="text-xs text-[var(--ink-subtle)]">Mask segment</span>
        </div>
        <button
          onClick={onDelete}
          className="h-7 px-2.5 bg-[var(--error-light)] hover:bg-[rgba(239,68,68,0.2)] text-[var(--error)] text-xs rounded-md transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Mask Type */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Mask Type</span>
        <ToggleGroup
          type="single"
          value={segment.maskType}
          onValueChange={(value) => {
            if (value) onUpdate({ maskType: value as MaskType });
          }}
          className="justify-start"
        >
          <ToggleGroupItem value="blur" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
            Blur
          </ToggleGroupItem>
          <ToggleGroupItem value="pixelate" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
            Pixelate
          </ToggleGroupItem>
          <ToggleGroupItem value="solid" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
            Solid
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Intensity (for blur/pixelate) */}
      {segment.maskType !== 'solid' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--ink-muted)]">Intensity</span>
            <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(segment.intensity)}%</span>
          </div>
          <Slider
            value={[segment.intensity]}
            min={0}
            max={100}
            step={5}
            onValueChange={(values) => onUpdate({ intensity: values[0] })}
          />
        </div>
      )}

      {/* Color (for solid) */}
      {segment.maskType === 'solid' && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--ink-muted)]">Color</span>
          <input
            type="color"
            value={segment.color}
            onChange={(e) => onUpdate({ color: e.target.value })}
            className="w-8 h-6 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
          />
        </div>
      )}

      {/* Feather */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--ink-muted)]">Feather (Edge Softness)</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{Math.round(segment.feather)}%</span>
        </div>
        <Slider
          value={[segment.feather]}
          min={0}
          max={100}
          step={5}
          onValueChange={(values) => onUpdate({ feather: values[0] })}
        />
      </div>

      {/* Position info */}
      <div className="pt-3 border-t border-[var(--glass-border)]">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-[var(--ink-subtle)]">Position</span>
            <p className="text-[var(--ink-dark)] font-mono mt-0.5">
              {Math.round(segment.x * 100)}%, {Math.round(segment.y * 100)}%
            </p>
          </div>
          <div>
            <span className="text-[var(--ink-subtle)]">Size</span>
            <p className="text-[var(--ink-dark)] font-mono mt-0.5">
              {Math.round(segment.width * 100)}% x {Math.round(segment.height * 100)}%
            </p>
          </div>
        </div>
        <p className="text-[10px] text-[var(--ink-faint)] mt-2">
          Drag the mask on the preview to reposition
        </p>
      </div>
    </div>
  );
}
