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
  Undo2,
  Redo2,
  Sparkles,
  Crop,
  Loader2,
  Pencil,
  FileImage,
  Share2,
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
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';

interface ToolbarProps {
  selectedTool: Tool;
  onToolChange: (tool: Tool) => void;
  onCopy: () => void;
  onSave: () => void;
  onSaveAs?: (format: 'png' | 'jpg' | 'webp') => void;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  isCopying?: boolean;
  isSaving?: boolean;
}

const toolDefs: { id: Tool; Icon: typeof MousePointer2; label: string; shortcut: string }[] = [
  { id: 'select', Icon: MousePointer2, label: 'Select', shortcut: 'V' },
  { id: 'crop', Icon: Crop, label: 'Crop/Expand', shortcut: 'C' },
  { id: 'arrow', Icon: MoveUpRight, label: 'Arrow', shortcut: 'A' },
  { id: 'rect', Icon: Square, label: 'Rectangle', shortcut: 'R' },
  { id: 'circle', Icon: Circle, label: 'Ellipse', shortcut: 'E' },
  { id: 'text', Icon: Type, label: 'Text', shortcut: 'T' },
  { id: 'highlight', Icon: Highlighter, label: 'Highlight', shortcut: 'H' },
  { id: 'blur', Icon: Grid3X3, label: 'Blur', shortcut: 'B' },
  { id: 'steps', Icon: Hash, label: 'Steps', shortcut: 'S' },
  { id: 'pen', Icon: Pencil, label: 'Pen', shortcut: 'P' },
  { id: 'background', Icon: Sparkles, label: 'Background', shortcut: 'G' },
];

export const Toolbar: React.FC<ToolbarProps> = ({
  selectedTool,
  onToolChange,
  onCopy,
  onSave,
  onSaveAs,
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
      <div className="flex items-center justify-center p-3 bg-[var(--polar-ice)] border-t border-[var(--polar-frost)]">
        <div className="floating-toolbar animate-scale-in">
          {/* Back Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onBack}
                className={`${buttonSize} rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-mist)]`}
              >
                <ArrowLeft className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Back to Library</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--polar-frost)]" />

          {/* Undo/Redo Buttons */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onUndo}
                disabled={!canUndo}
                className={`${buttonSize} rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-mist)] disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <Undo2 className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
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
                className={`${buttonSize} rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-mist)] disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <Redo2 className={iconSize} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="flex items-center gap-2">
                <span className="text-xs">Redo</span>
                <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+Y</kbd>
              </div>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--polar-frost)]" />

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
                <TooltipContent side="top">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{tool.label}</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">{tool.shortcut}</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>

          <Separator orientation="vertical" className="h-6 mx-2 bg-[var(--polar-frost)]" />

          {/* Quick Copy Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                disabled={isCopying}
                className={`${buttonSize} rounded-lg transition-all ${
                  copied
                    ? 'bg-emerald-50 text-emerald-500'
                    : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-mist)]'
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
            <TooltipContent side="top">
              <div className="flex items-center gap-2">
                <span className="text-xs">{isCopying ? 'Copying...' : copied ? 'Copied!' : 'Copy'}</span>
                <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+C</kbd>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Export Dropdown */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={isSaving}
                    className={`${buttonSize} rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-mist)] disabled:opacity-50`}
                  >
                    {isSaving ? (
                      <Loader2 className={`${iconSize} animate-spin`} />
                    ) : (
                      <div className="flex items-center">
                        <Share2 className={iconSize} />
                      </div>
                    )}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{isSaving ? 'Saving...' : 'Export'}</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+S</kbd>
                </div>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              side="top"
              align="end"
              className="w-48"
            >
              <DropdownMenuItem onClick={onSave} className="gap-2">
                <Download className="w-4 h-4" />
                <span>Save to File</span>
                <span className="ml-auto text-[10px] text-[var(--ink-muted)]">Ctrl+S</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onSaveAs?.('png')} className="gap-2">
                <FileImage className="w-4 h-4" />
                <span>Save as PNG</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSaveAs?.('jpg')} className="gap-2">
                <FileImage className="w-4 h-4" />
                <span>Save as JPG</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSaveAs?.('webp')} className="gap-2">
                <FileImage className="w-4 h-4" />
                <span>Save as WebP</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </TooltipProvider>
  );
};
