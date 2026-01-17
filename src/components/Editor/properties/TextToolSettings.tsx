import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Check,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ChevronDown,
} from 'lucide-react';
import { useEditorStore, recordAction } from '../../../stores/editorStore';
import { DEFAULT_FONT_FAMILIES, type CanvasShape } from '../../../types';
import { editorLogger } from '@/utils/logger';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ColorPicker } from '@/components/ui/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

// Color presets for quick selection
const COLOR_PRESETS = [
  '#EF4444', '#F97316', '#F97066', '#22C55E',
  '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF', '#1A1A1A',
];

interface TextToolSettingsProps {
  textShape: CanvasShape | null;
  strokeColor: string;
  strokeWidth: number;
  onStrokeColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
}

export const TextToolSettings: React.FC<TextToolSettingsProps> = ({
  textShape,
  strokeColor,
  strokeWidth,
  onStrokeColorChange,
  onStrokeWidthChange,
}) => {
  const { fontSize, setFontSize, updateShape } = useEditorStore();

  // System fonts state
  const [systemFonts, setSystemFonts] = useState<string[]>([...DEFAULT_FONT_FAMILIES]);
  const [fontComboboxOpen, setFontComboboxOpen] = useState(false);

  // Fetch system fonts on mount
  useEffect(() => {
    invoke<string[]>('get_system_fonts')
      .then((fonts) => {
        if (fonts && fonts.length > 0) {
          setSystemFonts(fonts);
        }
      })
      .catch((err) => {
        editorLogger.warn('Failed to load system fonts:', err);
      });
  }, []);

  const currentFontSize = textShape?.fontSize || fontSize;
  const currentFontFamily = textShape?.fontFamily || 'Arial';
  const currentFontStyle = textShape?.fontStyle || 'normal';
  const currentTextDecoration = textShape?.textDecoration || '';
  const currentAlign = textShape?.align || 'left';
  const currentTextStroke = textShape?.stroke || 'transparent';
  const currentTextStrokeWidth = textShape?.strokeWidth || 0;
  const currentVerticalAlign = textShape?.verticalAlign || 'top';

  const isBold = currentFontStyle.includes('bold');
  const isItalic = currentFontStyle.includes('italic');
  const isUnderline = currentTextDecoration === 'underline';

  const toggleBold = () => {
    let newStyle = currentFontStyle;
    if (isBold) {
      newStyle = newStyle.replace('bold', '').trim() || 'normal';
    } else {
      newStyle = newStyle === 'normal' ? 'bold' : `bold ${newStyle}`;
    }
    if (textShape) {
      recordAction(() => updateShape(textShape.id, { fontStyle: newStyle }));
    }
  };

  const toggleItalic = () => {
    let newStyle = currentFontStyle;
    if (isItalic) {
      newStyle = newStyle.replace('italic', '').trim() || 'normal';
    } else {
      newStyle = newStyle === 'normal' ? 'italic' : `${newStyle} italic`;
    }
    if (textShape) {
      recordAction(() => updateShape(textShape.id, { fontStyle: newStyle }));
    }
  };

  const toggleUnderline = () => {
    const newDecoration = isUnderline ? '' : 'underline';
    if (textShape) {
      recordAction(() => updateShape(textShape.id, { textDecoration: newDecoration }));
    }
  };

  const setAlignment = (align: string) => {
    if (textShape) {
      recordAction(() => updateShape(textShape.id, { align }));
    }
  };

  const setVerticalAlignment = (verticalAlign: string) => {
    if (textShape) {
      recordAction(() => updateShape(textShape.id, { verticalAlign }));
    }
  };

  return (
    <>
      {/* Font Family */}
      <Separator className="bg-[var(--polar-frost)]" />
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Font Family</Label>
        <Popover open={fontComboboxOpen} onOpenChange={setFontComboboxOpen}>
          <PopoverTrigger asChild>
            <button
              disabled={!textShape}
              className="w-full h-9 px-3 pr-8 rounded-lg text-xs font-medium bg-[var(--card)] border border-[var(--polar-frost)] text-[var(--ink-dark)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between text-left relative"
              style={{ fontFamily: currentFontFamily }}
            >
              <span className="truncate">{currentFontFamily}</span>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--ink-muted)]" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
            <Command>
              <CommandInput placeholder="Search fonts..." className="h-9" />
              <CommandList>
                <CommandEmpty>No font found.</CommandEmpty>
                <CommandGroup>
                  {systemFonts.map((font) => (
                    <CommandItem
                      key={font}
                      value={font}
                      onSelect={() => {
                        if (textShape) {
                          recordAction(() => updateShape(textShape.id, { fontFamily: font }));
                        }
                        setFontComboboxOpen(false);
                      }}
                      style={{ fontFamily: font }}
                      className="text-sm"
                    >
                      <Check
                        className={`mr-2 h-4 w-4 ${currentFontFamily === font ? 'opacity-100' : 'opacity-0'}`}
                      />
                      {font}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* Font Size */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Font Size</Label>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{currentFontSize}px</span>
        </div>
        <Slider
          value={[currentFontSize]}
          onValueChange={([value]) => {
            if (textShape) {
              updateShape(textShape.id, { fontSize: value });
            } else {
              setFontSize(value);
            }
          }}
          onValueCommit={() => {
            // Commit handled by recordAction on individual changes
          }}
          min={8}
          max={72}
          step={1}
          className="w-full"
        />
      </div>

      {/* Bold, Italic, Underline */}
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Style</Label>
        <div className="flex gap-2">
          <button
            onClick={toggleBold}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border ${
              isBold
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={toggleItalic}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border ${
              isItalic
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            onClick={toggleUnderline}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border ${
              isUnderline
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <Underline className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Text Alignment - Horizontal */}
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Horizontal Align</Label>
        <div className="flex gap-2">
          <button
            onClick={() => setAlignment('left')}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border ${
              currentAlign === 'left'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <AlignLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setAlignment('center')}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border ${
              currentAlign === 'center'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <AlignCenter className="w-4 h-4" />
          </button>
          <button
            onClick={() => setAlignment('right')}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border ${
              currentAlign === 'right'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <AlignRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Text Alignment - Vertical */}
      <div className="space-y-3">
        <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Vertical Align</Label>
        <div className="flex gap-2">
          <button
            onClick={() => setVerticalAlignment('top')}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border text-xs font-medium ${
              currentVerticalAlign === 'top'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Top
          </button>
          <button
            onClick={() => setVerticalAlignment('middle')}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border text-xs font-medium ${
              currentVerticalAlign === 'middle'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Middle
          </button>
          <button
            onClick={() => setVerticalAlignment('bottom')}
            disabled={!textShape}
            className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-all border text-xs font-medium ${
              currentVerticalAlign === 'bottom'
                ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border-[var(--coral-200)]'
                : 'bg-[var(--card)] text-[var(--ink-muted)] border-[var(--polar-frost)] hover:bg-[var(--polar-ice)]'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Bottom
          </button>
        </div>
      </div>

      {/* Text Stroke - show for text tool and selected text shapes */}
      <>
        <Separator className="bg-[var(--polar-frost)]" />
        <div className="space-y-3">
          <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Stroke Color</Label>
          <ColorPicker
            value={textShape ? (currentTextStroke === 'transparent' ? '#000000' : currentTextStroke) : strokeColor}
            onChange={(color) => {
              if (textShape) {
                recordAction(() => updateShape(textShape.id, { stroke: color }));
              } else {
                onStrokeColorChange(color);
              }
            }}
            presets={COLOR_PRESETS}
            showTransparent
          />
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-[var(--ink-muted)] uppercase tracking-wide font-medium">Stroke Width</Label>
            <span className="text-xs text-[var(--ink-dark)] font-mono">{textShape ? currentTextStrokeWidth : strokeWidth}px</span>
          </div>
          <Slider
            value={[textShape ? currentTextStrokeWidth : strokeWidth]}
            onValueChange={([value]) => {
              if (textShape) {
                updateShape(textShape.id, { strokeWidth: value });
              } else {
                onStrokeWidthChange(value);
              }
            }}
            min={0}
            max={4}
            step={0.5}
            className="w-full"
          />
        </div>
      </>
    </>
  );
};
