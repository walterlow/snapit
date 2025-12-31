/**
 * DimensionSelect - Compact dimension inputs matching source selector style.
 *
 * Shows editable W × H inputs plus a button that opens a native OS menu
 * for preset selection. Styled to match glass-source-group buttons.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { ChevronDown, ChevronLeft } from 'lucide-react';

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
  onBack?: () => void;
  disabled?: boolean;
}

export const DimensionSelect: React.FC<DimensionSelectProps> = ({
  width,
  height,
  onDimensionChange,
  onBack,
  disabled = false,
}) => {
  // Local state for inputs
  const [widthInput, setWidthInput] = useState(String(Math.round(width)));
  const [heightInput, setHeightInput] = useState(String(Math.round(height)));
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  // Handle preset selection via native menu
  const handlePresetSelect = useCallback((preset: typeof DIMENSION_PRESETS[number]) => {
    onDimensionChange?.(preset.width, preset.height);
  }, [onDimensionChange]);

  // Open native menu
  const openPresetMenu = useCallback(async () => {
    if (disabled) return;

    try {
      const items = await Promise.all([
        MenuItem.new({
          id: 'header',
          text: 'Presets',
          enabled: false,
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        ...DIMENSION_PRESETS.map((preset) =>
          MenuItem.new({
            id: `preset-${preset.label}`,
            text: `${preset.label}  (${preset.width}×${preset.height})`,
            action: () => handlePresetSelect(preset),
          })
        ),
      ]);

      const menu = await Menu.new({ items });

      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
      } else {
        await menu.popup();
      }
    } catch (error) {
      console.error('Failed to open preset menu:', error);
    }
  }, [disabled, handlePresetSelect]);

  return (
    <div className={`glass-source-group ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {/* Back button */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="glass-source-btn"
          title="Back to source selection"
        >
          <span className="glass-source-icon">
            <ChevronLeft size={18} strokeWidth={1.5} />
          </span>
          <span className="glass-source-label">Back</span>
        </button>
      )}

      {/* Dimension inputs styled as a source button */}
      <div className="glass-dimension-compact">
        <input
          type="text"
          value={widthInput}
          onChange={(e) => setWidthInput(e.target.value)}
          onBlur={applyChange}
          onKeyDown={handleKeyDown}
          className="glass-dimension-compact-input"
          title="Width"
          disabled={disabled}
        />
        <span className="glass-dimension-compact-sep">×</span>
        <input
          type="text"
          value={heightInput}
          onChange={(e) => setHeightInput(e.target.value)}
          onBlur={applyChange}
          onKeyDown={handleKeyDown}
          className="glass-dimension-compact-input"
          title="Height"
          disabled={disabled}
        />
      </div>

      {/* Preset menu button styled as source button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={openPresetMenu}
        className="glass-source-btn"
        disabled={disabled}
        title="Dimension presets"
      >
        <span className="glass-source-icon">
          <ChevronDown size={18} strokeWidth={1.5} />
        </span>
        <span className="glass-source-label">Preset</span>
      </button>
    </div>
  );
};

export default DimensionSelect;
