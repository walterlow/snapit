import {
  MousePointer2,
  MoveUpRight,
  Square,
  Circle,
  Type,
  Highlighter,
  Grid3X3,
  Hash,
  Copy,
  Download,
  ArrowLeft,
  Check,
  Palette,
  Minus,
  Undo2,
  Redo2,
  Sparkles,
  Droplets,
  Crop,
  Loader2,
  Pencil,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Tool } from '../../types';
import { useEditorStore } from '../../stores/editorStore';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';

interface ToolbarProps {
  selectedTool: Tool;
  onToolChange: (tool: Tool) => void;
  strokeColor: string;
  onStrokeColorChange: (color: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
  onCopy: () => void;
  onSave: () => void;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  isCopying?: boolean;
  isSaving?: boolean;
}

const toolDefs: { id: Tool; Icon: typeof MousePointer2; label: string; shortcut: string }[] = [
  { id: 'select', Icon: MousePointer2, label: 'Select', shortcut: 'V' },
  { id: 'crop', Icon: Crop, label: 'Crop/Expand', shortcut: 'X' },
  { id: 'arrow', Icon: MoveUpRight, label: 'Arrow', shortcut: 'A' },
  { id: 'rect', Icon: Square, label: 'Rectangle', shortcut: 'R' },
  { id: 'circle', Icon: Circle, label: 'Circle', shortcut: 'C' },
  { id: 'text', Icon: Type, label: 'Text', shortcut: 'T' },
  { id: 'highlight', Icon: Highlighter, label: 'Highlight', shortcut: 'H' },
  { id: 'blur', Icon: Grid3X3, label: 'Blur', shortcut: 'B' },
  { id: 'steps', Icon: Hash, label: 'Steps', shortcut: 'S' },
  { id: 'pen', Icon: Pencil, label: 'Pen', shortcut: 'P' },
];

const colors = [
  { value: '#EF4444', name: 'Red' },
  { value: '#F97316', name: 'Orange' },
  { value: '#FBBF24', name: 'Amber' },
  { value: '#22C55E', name: 'Green' },
  { value: '#3B82F6', name: 'Blue' },
  { value: '#8B5CF6', name: 'Purple' },
  { value: '#EC4899', name: 'Pink' },
  { value: '#FFFFFF', name: 'White' },
  { value: '#000000', name: 'Black' },
];

const strokeWidths = [
  { value: 2, label: 'Thin' },
  { value: 3, label: 'Regular' },
  { value: 4, label: 'Medium' },
  { value: 6, label: 'Bold' },
  { value: 8, label: 'Heavy' },
];

export const Toolbar: React.FC<ToolbarProps> = ({
  selectedTool,
  onToolChange,
  strokeColor,
  onStrokeColorChange,
  strokeWidth,
  onStrokeWidthChange,
  onCopy,
  onSave,
  onBack,
  onUndo,
  onRedo,
  isCopying = false,
  isSaving = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [isCompact, setIsCompact] = useState(false);

  // Get undo/redo state from store
  const canUndo = useEditorStore((state) => state.canUndo);
  const canRedo = useEditorStore((state) => state.canRedo);

  // Compositor state
  const { compositorSettings, toggleCompositor, blurType, setBlurType, blurAmount, setBlurAmount } = useEditorStore();

  useEffect(() => {
    const checkSize = () => {
      setIsCompact(window.innerWidth < 720 || window.innerHeight < 500);
    };
    checkSize();
    window.addEventListener('resize', checkSize);
    return () => window.removeEventListener('resize', checkSize);
  }, []);

  const handleCopy = async () => {
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const buttonSize = isCompact ? 'h-8 w-8' : 'h-9 w-9';
  const iconSize = isCompact ? 'w-4 h-4' : 'w-[18px] h-[18px]';

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center justify-center p-3 bg-[var(--obsidian-raised)] border-t border-[var(--border-subtle)]">
        <div className="floating-toolbar animate-scale-in">
          {/* Back Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onBack}
                className={`${buttonSize} rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]`}
              >
                <ArrowLeft className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" >
              <p className="text-xs">Back to Library</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--border-default)]" />

          {/* Undo/Redo Buttons */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onUndo}
                disabled={!canUndo}
                className={`${buttonSize} rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)] disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <Undo2 className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" >
              <div className="flex items-center gap-2">
                <span className="text-xs">Undo</span>
                <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+Z</kbd>
              </div>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onRedo}
                disabled={!canRedo}
                className={`${buttonSize} rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)] disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <Redo2 className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" >
              <div className="flex items-center gap-2">
                <span className="text-xs">Redo</span>
                <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+Y</kbd>
              </div>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--border-default)]" />

          {/* Tool Buttons */}
          <div className="flex items-center gap-0.5">
            {toolDefs.map((tool) => (
              <Tooltip key={tool.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onToolChange(tool.id)}
                    className={`tool-button ${buttonSize} ${selectedTool === tool.id ? 'active' : ''}`}
                  >
                    <tool.Icon className={`${iconSize} relative z-10`} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" >
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{tool.label}</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">{tool.shortcut}</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--border-default)]" />

          {/* Color Picker */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`${buttonSize} rounded-lg hover:bg-[var(--obsidian-hover)] relative`}
                  >
                    <Palette className={`${iconSize} text-[var(--text-secondary)]`} />
                    <div
                      className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 rounded-full border border-white/20"
                      style={{ backgroundColor: strokeColor }}
                    />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" >
                <p className="text-xs">Color</p>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              side="top"
              align="center"
              className="p-3 bg-[var(--obsidian-float)] border-[var(--border-default)] animate-scale-in"
            >
              <div className="color-picker">
                {colors.map((color) => (
                  <button
                    key={color.value}
                    onClick={() => onStrokeColorChange(color.value)}
                    className={`color-swatch ${strokeColor === color.value ? 'active' : ''}`}
                    style={{ backgroundColor: color.value }}
                    title={color.name}
                  />
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Stroke Width */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`${buttonSize} rounded-lg hover:bg-[var(--obsidian-hover)]`}
                  >
                    <Minus className={`${iconSize} text-[var(--text-secondary)]`} style={{ strokeWidth: strokeWidth }} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" >
                <p className="text-xs">Stroke Width</p>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              side="top"
              align="center"
              className="p-3 bg-[var(--obsidian-float)] border-[var(--border-default)] animate-scale-in"
            >
              <div className="flex items-center gap-2">
                {strokeWidths.map((sw) => (
                  <Tooltip key={sw.value}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onStrokeWidthChange(sw.value)}
                        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                          strokeWidth === sw.value
                            ? 'bg-[var(--amber-glow)] border border-[var(--amber-400)]'
                            : 'hover:bg-[var(--obsidian-hover)]'
                        }`}
                      >
                        <div
                          className="rounded-full bg-white"
                          style={{
                            width: Math.min(sw.value * 2, 16),
                            height: Math.min(sw.value * 2, 16),
                          }}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="text-xs">{sw.label}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Blur Type Toggle - only shown when blur tool is selected */}
          {selectedTool === 'blur' && (
            <>
              <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--border-default)]" />
              <div className="flex items-center gap-1 px-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setBlurType('pixelate')}
                      className={`${buttonSize} rounded-lg flex items-center justify-center transition-all ${
                        blurType === 'pixelate'
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]'
                      }`}
                    >
                      <Grid3X3 className={iconSize} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" >
                    <p className="text-xs">Pixelate</p>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setBlurType('gaussian')}
                      className={`${buttonSize} rounded-lg flex items-center justify-center transition-all ${
                        blurType === 'gaussian'
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]'
                      }`}
                    >
                      <Droplets className={iconSize} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" >
                    <p className="text-xs">Gaussian Blur</p>
                  </TooltipContent>
                </Tooltip>
                {/* Blur Amount Slider */}
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button className={`${buttonSize} rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]`}>
                          <span className="text-xs font-mono">{blurAmount}</span>
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top" >
                      <p className="text-xs">Blur Amount</p>
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent
                    side="top"
                    align="center"
                    className="p-3 bg-[var(--obsidian-float)] border-[var(--border-default)] animate-scale-in"
                  >
                    <div className="flex items-center gap-2">
                      {[5, 10, 15, 20, 30].map((amount) => (
                        <Tooltip key={amount}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => setBlurAmount(amount)}
                              className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-mono transition-all ${
                                blurAmount === amount
                                  ? 'bg-[var(--amber-glow)] border border-[var(--amber-400)] text-amber-400'
                                  : 'hover:bg-[var(--obsidian-hover)] text-[var(--text-secondary)]'
                              }`}
                            >
                              {amount}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p className="text-xs">{blurType === 'pixelate' ? 'Pixel size' : 'Blur radius'}: {amount}px</p>
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--border-default)]" />

          {/* Background Compositor Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleCompositor}
                className={`${buttonSize} rounded-lg transition-all ${
                  compositorSettings.enabled
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]'
                }`}
              >
                <Sparkles className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" >
              <p className="text-xs">{compositorSettings.enabled ? 'Disable' : 'Enable'} Background</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--border-default)]" />

          {/* Copy Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                disabled={isCopying}
                className={`${buttonSize} rounded-lg transition-all ${
                  copied
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {isCopying ? (
                  <Loader2 className={`${iconSize} animate-spin`} />
                ) : copied ? (
                  <Check className={`${iconSize} animate-scale-in`} />
                ) : (
                  <Copy className={iconSize} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" >
              <p className="text-xs">{isCopying ? 'Copying...' : copied ? 'Copied!' : 'Copy to Clipboard'}</p>
            </TooltipContent>
          </Tooltip>

          {/* Save Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onSave}
                disabled={isSaving}
                className={`${buttonSize} rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)] disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {isSaving ? (
                  <Loader2 className={`${iconSize} animate-spin`} />
                ) : (
                  <Download className={iconSize} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" >
              <p className="text-xs">{isSaving ? 'Saving...' : 'Save to File'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
};
