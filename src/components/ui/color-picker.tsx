import * as React from 'react';
import Wheel from '@uiw/react-color-wheel';
import { hsvaToHex, hexToHsva } from '@uiw/color-convert';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  presets?: string[];
  className?: string;
  showInput?: boolean;
  showTransparent?: boolean;
}

const DEFAULT_PRESETS = [
  '#EF4444', '#F97316', '#F97066', '#22C55E',
  '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF', '#1A1A1A',
];

const safeHexToHsva = (hex: string): HsvaColor => {
  try {
    return hexToHsva(hex || '#EF4444');
  } catch {
    return { h: 0, s: 100, v: 100, a: 1 };
  }
};

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  className,
  showInput = true,
  showTransparent = false,
}) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);

  // Committed HSVA (synced with parent value)
  const committedHsva = React.useMemo(() => safeHexToHsva(value), [value]);

  // Local HSVA for live preview during drag
  const [localHsva, setLocalHsva] = React.useState<HsvaColor>(committedHsva);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const wheelRef = React.useRef<HTMLDivElement>(null);

  // Sync local state when committed value changes (and not dragging)
  React.useEffect(() => {
    if (!isDragging) {
      setLocalHsva(committedHsva);
    }
  }, [committedHsva, isDragging]);

  // Close on outside click
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Handle pointer up to commit the color
  React.useEffect(() => {
    const handlePointerUp = () => {
      if (isDragging) {
        setIsDragging(false);
        // Commit the local color to parent
        const hex = hsvaToHex(localHsva);
        onChange(hex);
      }
    };

    if (isDragging) {
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
      return () => {
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
      };
    }
  }, [isDragging, localHsva, onChange]);

  // Handle wheel change - only update local state for preview
  const handleWheelChange = React.useCallback((color: { hsva: HsvaColor }) => {
    setLocalHsva(color.hsva);
    if (!isDragging) {
      setIsDragging(true);
    }
  }, [isDragging]);

  // Handle input change - commit immediately
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    onChange(inputValue);
  };

  // Get the display color (local during drag, committed otherwise)
  const displayHsva = isDragging ? localHsva : committedHsva;
  const displayHex = hsvaToHex(displayHsva);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Preset Colors */}
      <div className="flex flex-wrap gap-2 mb-2">
        {showTransparent && (
          <button
            type="button"
            onClick={() => onChange('transparent')}
            className={cn(
              'w-7 h-7 rounded-lg border-2 transition-all hover:scale-110 flex items-center justify-center',
              value === 'transparent' ? 'border-[var(--ink-black)]' : 'border-[var(--polar-frost)]'
            )}
            style={{ background: 'repeating-conic-gradient(#d4d4d4 0% 25%, transparent 0% 50%) 50% / 8px 8px' }}
            title="No fill"
          >
            <X className="w-3 h-3 text-[var(--ink-muted)]" />
          </button>
        )}
        {presets.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={cn(
              'w-7 h-7 rounded-lg border-2 transition-all hover:scale-110',
              value === color ? 'border-[var(--ink-black)] shadow-md' : 'border-transparent'
            )}
            style={{
              backgroundColor: color,
              boxShadow: color === '#FFFFFF' ? 'inset 0 0 0 1px rgba(0,0,0,0.1)' : undefined,
            }}
          />
        ))}
      </div>

      {/* Color Input Row */}
      <div className="flex items-center gap-2">
        {/* Swatch Button to Toggle Wheel */}
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'w-10 h-10 rounded-lg border-2 transition-all cursor-pointer flex-shrink-0',
            isOpen ? 'border-[var(--coral-400)] ring-2 ring-[var(--coral-glow)]' : 'border-[var(--polar-frost)]'
          )}
          style={{
            backgroundColor: value === 'transparent' ? undefined : displayHex,
            background: value === 'transparent' ? 'repeating-conic-gradient(#d4d4d4 0% 25%, transparent 0% 50%) 50% / 8px 8px' : undefined,
          }}
        />

        {/* Hex Input */}
        {showInput && (
          <input
            type="text"
            value={isDragging ? displayHex : value}
            onChange={handleInputChange}
            className="flex-1 h-10 px-3 rounded-lg bg-white border border-[var(--polar-frost)] text-sm text-[var(--ink-black)] font-mono focus:border-[var(--coral-400)] focus:ring-2 focus:ring-[var(--coral-glow)] focus:outline-none"
            placeholder="#000000"
          />
        )}
      </div>

      {/* Wheel Popover */}
      {isOpen && (
        <div
          ref={wheelRef}
          className="absolute z-50 mt-2 p-4 bg-white rounded-xl border border-[var(--polar-frost)] shadow-xl"
        >
          <Wheel
            color={displayHsva}
            onChange={handleWheelChange}
            width={180}
            height={180}
          />
          {/* Color Preview */}
          <div className="mt-3 flex items-center gap-2">
            <div
              className="flex-1 h-6 rounded-md border border-[var(--polar-frost)]"
              style={{ backgroundColor: displayHex }}
            />
            <span className="text-xs font-mono text-[var(--ink-muted)] w-16 text-right">
              {displayHex.toUpperCase()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColorPicker;
