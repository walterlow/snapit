import {
  MousePointer2,
  MoveUpRight,
  Minus,
  Square,
  Circle,
  Type,
  Highlighter,
  Droplet,
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
  Save,
  Trash2,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Tool } from '../../types';
import { useEditorStore } from '../../stores/editorStore';

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

interface ToolbarProps {
  selectedTool: Tool;
  onToolChange: (tool: Tool) => void;
  onCopy: () => void;
  onSave: () => void;
  onSaveAs?: (format: 'png' | 'jpg' | 'webp') => void;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  isCopying?: boolean;
  isSaving?: boolean;
}

const toolDefs: { id: Tool; Icon: typeof MousePointer2; label: string; shortcut: string }[] = [
  { id: 'select', Icon: MousePointer2, label: 'Select', shortcut: 'V' },
  { id: 'crop', Icon: Crop, label: 'Crop/Expand', shortcut: 'C' },
  { id: 'arrow', Icon: MoveUpRight, label: 'Arrow', shortcut: 'A' },
  { id: 'line', Icon: Minus, label: 'Line', shortcut: 'L' },
  { id: 'rect', Icon: Square, label: 'Rectangle', shortcut: 'R' },
  { id: 'circle', Icon: Circle, label: 'Ellipse', shortcut: 'E' },
  { id: 'text', Icon: Type, label: 'Text', shortcut: 'T' },
  { id: 'highlight', Icon: Highlighter, label: 'Highlight', shortcut: 'H' },
  { id: 'blur', Icon: Droplet, label: 'Blur', shortcut: 'B' },
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
  onDelete,
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
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      <div className="editor-toolbar-container">
        <div className="floating-toolbar animate-scale-in">
          {/* Back Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onBack}
                className={`glass-btn ${buttonSize}`}
              >
                <ArrowLeft className={iconSize} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Back to Library</p>
            </TooltipContent>
          </Tooltip>

          <div className="toolbar-divider" />

          {/* Undo/Redo Buttons */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onUndo}
                disabled={!canUndo}
                className={`glass-btn ${buttonSize} disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <Undo2 className={iconSize} />
              </button>
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
              <button
                onClick={onRedo}
                disabled={!canRedo}
                className={`glass-btn ${buttonSize} disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <Redo2 className={iconSize} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="flex items-center gap-2">
                <span className="text-xs">Redo</span>
                <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+Y</kbd>
              </div>
            </TooltipContent>
          </Tooltip>

          <div className="toolbar-divider" />

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

          <div className="toolbar-divider" />

          {/* Quick Copy Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                disabled={isCopying}
                className={`glass-btn ${buttonSize} ${
                  copied ? 'glass-btn--success' : ''
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {isCopying ? (
                  <Loader2 className={`${iconSize} animate-spin`} />
                ) : copied ? (
                  <Check className={`${iconSize} animate-scale-in`} />
                ) : (
                  <Copy className={iconSize} />
                )}
              </button>
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
                  <button
                    disabled={isSaving}
                    className={`glass-btn ${buttonSize} disabled:opacity-50`}
                  >
                    {isSaving ? (
                      <Loader2 className={`${iconSize} animate-spin`} />
                    ) : (
                      <Save className={iconSize} />
                    )}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{isSaving ? 'Saving...' : 'Save'}</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+E</kbd>
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
                <span className="ml-auto text-[10px] text-[var(--ink-muted)]">Ctrl+E</span>
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

          {/* Delete Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onDelete}
                className={`glass-btn glass-btn--danger ${buttonSize}`}
              >
                <Trash2 className={iconSize} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Delete Capture</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
};
