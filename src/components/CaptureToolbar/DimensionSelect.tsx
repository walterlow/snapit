/**
 * DimensionSelect - Text inputs for dimensions with preset dropdown.
 *
 * Shows editable W × H inputs plus a preset dropdown for quick selection.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { ChevronDown } from 'lucide-react';

// Common dimension presets
const DIMENSION_PRESETS = [
  { label: '1080p', width: 1920, height: 1080 },
  { label: '720p', width: 1280, height: 720 },
  { label: '480p', width: 854, height: 480 },
  { label: '4:3', width: 640, height: 480 },
  { label: 'Square', width: 1080, height: 1080 },
  { label: 'Story', width: 1080, height: 1920 },
] as const;

interface DimensionSelectProps {
  width: number;
  height: number;
  onDimensionChange?: (width: number, height: number) => void;
  disabled?: boolean;
}

export const DimensionSelect: React.FC<DimensionSelectProps> = ({
  width,
  height,
  onDimensionChange,
  disabled = false,
}) => {
  // Local state for inputs
  const [widthInput, setWidthInput] = useState(String(Math.round(width)));
  const [heightInput, setHeightInput] = useState(String(Math.round(height)));

  // Sync when props change
  useEffect(() => {
    setWidthInput(String(Math.round(width)));
  }, [width]);

  useEffect(() => {
    setHeightInput(String(Math.round(height)));
  }, [height]);

  // Apply dimension change
  const applyChange = useCallback(() => {
    const newWidth = parseInt(widthInput, 10);
    const newHeight = parseInt(heightInput, 10);
    if (!isNaN(newWidth) && !isNaN(newHeight) && newWidth > 0 && newHeight > 0) {
      onDimensionChange?.(newWidth, newHeight);
    } else {
      setWidthInput(String(Math.round(width)));
      setHeightInput(String(Math.round(height)));
    }
  }, [widthInput, heightInput, width, height, onDimensionChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      applyChange();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setWidthInput(String(Math.round(width)));
      setHeightInput(String(Math.round(height)));
      (e.target as HTMLInputElement).blur();
    }
  }, [applyChange, width, height]);

  // Handle preset selection
  const handlePresetChange = (value: string | null) => {
    if (!value) return;
    const preset = DIMENSION_PRESETS.find((p) => p.label === value);
    if (preset) {
      onDimensionChange?.(preset.width, preset.height);
    }
  };

  // Find current preset match
  const currentPreset = DIMENSION_PRESETS.find(
    (p) => p.width === Math.round(width) && p.height === Math.round(height)
  )?.label || '';

  return (
    <div className="glass-inline-group">
      <span className="glass-inline-label">Size</span>
      <div className="glass-dimension-inputs">
        {/* Width input */}
        <input
          type="text"
          value={widthInput}
          onChange={(e) => setWidthInput(e.target.value)}
          onBlur={applyChange}
          onKeyDown={handleKeyDown}
          className="glass-dimension-input"
          title="Width"
          disabled={disabled}
        />

        <span className="glass-dimension-separator">×</span>

        {/* Height input */}
        <input
          type="text"
          value={heightInput}
          onChange={(e) => setHeightInput(e.target.value)}
          onBlur={applyChange}
          onKeyDown={handleKeyDown}
          className="glass-dimension-input"
          title="Height"
          disabled={disabled}
        />

        {/* Preset dropdown */}
        <BaseSelect.Root
          value={currentPreset}
          onValueChange={handlePresetChange}
          disabled={disabled}
        >
          <BaseSelect.Trigger className="glass-dimension-preset-trigger">
            <BaseSelect.Icon className="glass-dimension-preset-icon">
              <ChevronDown size={12} />
            </BaseSelect.Icon>
          </BaseSelect.Trigger>

          <BaseSelect.Portal>
            <BaseSelect.Positioner sideOffset={6} className="z-[9999]">
              <BaseSelect.Popup className="glass-dimension-select-popup">
                <BaseSelect.List>
                  {DIMENSION_PRESETS.map((preset) => (
                    <BaseSelect.Item
                      key={preset.label}
                      value={preset.label}
                      className="glass-dimension-select-item"
                    >
                      <BaseSelect.ItemText>
                        {preset.label}
                        <span className="glass-dimension-select-dims">
                          {preset.width}×{preset.height}
                        </span>
                      </BaseSelect.ItemText>
                    </BaseSelect.Item>
                  ))}
                </BaseSelect.List>
              </BaseSelect.Popup>
            </BaseSelect.Positioner>
          </BaseSelect.Portal>
        </BaseSelect.Root>
      </div>
    </div>
  );
};

export default DimensionSelect;
