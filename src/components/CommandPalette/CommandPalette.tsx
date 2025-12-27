/**
 * Command Palette - Quick access to tools, actions, and navigation
 *
 * Keyboard shortcut: Ctrl+K / Cmd+K
 * Uses cmdk library with existing command primitives
 */

import React, { useCallback, useMemo } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@/components/ui/command';
import {
  MousePointer,
  Crop,
  MoveRight,
  Minus,
  Square,
  Circle,
  Type,
  Highlighter,
  Blinds,
  ListOrdered,
  Pen,
  Palette,
  Copy,
  Save,
  Undo2,
  Redo2,
  ZoomIn,
  Settings,
  Keyboard,
  Trash2,
  ArrowLeft,
} from 'lucide-react';
import type { Tool } from '@/types';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Editor state
  view: 'library' | 'editor';
  selectedTool: Tool;
  hasProject: boolean;
  canUndo: boolean;
  canRedo: boolean;
  // Actions
  onToolChange: (tool: Tool) => void;
  onCopy: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFitToCenter: () => void;
  onShowShortcuts: () => void;
  onOpenSettings: () => void;
  onBackToLibrary: () => void;
  onRequestDelete: () => void;
  onToggleCompositor: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
  disabled?: boolean;
}

const TOOL_ICONS: Record<Tool, React.ReactNode> = {
  select: <MousePointer className="h-4 w-4" />,
  crop: <Crop className="h-4 w-4" />,
  arrow: <MoveRight className="h-4 w-4" />,
  line: <Minus className="h-4 w-4" />,
  rect: <Square className="h-4 w-4" />,
  circle: <Circle className="h-4 w-4" />,
  text: <Type className="h-4 w-4" />,
  highlight: <Highlighter className="h-4 w-4" />,
  blur: <Blinds className="h-4 w-4" />,
  steps: <ListOrdered className="h-4 w-4" />,
  pen: <Pen className="h-4 w-4" />,
  background: <Palette className="h-4 w-4" />,
};

const TOOL_SHORTCUTS: Partial<Record<Tool, string>> = {
  select: 'V',
  crop: 'C',
  arrow: 'A',
  line: 'L',
  rect: 'R',
  circle: 'E',
  text: 'T',
  highlight: 'H',
  blur: 'B',
  steps: 'S',
  pen: 'P',
  background: 'G',
};

const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  crop: 'Crop',
  arrow: 'Arrow',
  line: 'Line',
  rect: 'Rectangle',
  circle: 'Ellipse',
  text: 'Text',
  highlight: 'Highlight',
  blur: 'Blur',
  steps: 'Steps',
  pen: 'Pen',
  background: 'Background',
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onOpenChange,
  view,
  selectedTool,
  hasProject,
  canUndo,
  canRedo,
  onToolChange,
  onCopy,
  onSave,
  onUndo,
  onRedo,
  onFitToCenter,
  onShowShortcuts,
  onOpenSettings,
  onBackToLibrary,
  onRequestDelete,
  onToggleCompositor,
}) => {
  const runCommand = useCallback((action: () => void) => {
    onOpenChange(false);
    // Small delay to let dialog close before action
    requestAnimationFrame(action);
  }, [onOpenChange]);

  const isEditor = view === 'editor';

  // Tool commands - only show in editor view
  const toolCommands = useMemo<CommandItem[]>(() => {
    if (!isEditor) return [];

    const tools: Tool[] = ['select', 'crop', 'arrow', 'rect', 'circle', 'text', 'highlight', 'blur', 'steps', 'pen', 'background'];

    return tools.map(tool => ({
      id: `tool-${tool}`,
      label: TOOL_LABELS[tool],
      icon: TOOL_ICONS[tool],
      shortcut: TOOL_SHORTCUTS[tool],
      action: () => {
        if (tool === 'background') {
          onToggleCompositor();
        }
        onToolChange(tool);
      },
      disabled: tool === selectedTool,
    }));
  }, [isEditor, selectedTool, onToolChange, onToggleCompositor]);

  // Action commands
  const actionCommands = useMemo<CommandItem[]>(() => {
    const commands: CommandItem[] = [];

    if (isEditor && hasProject) {
      commands.push(
        {
          id: 'copy',
          label: 'Copy to Clipboard',
          icon: <Copy className="h-4 w-4" />,
          shortcut: '⌘C',
          action: onCopy,
        },
        {
          id: 'save',
          label: 'Save to File',
          icon: <Save className="h-4 w-4" />,
          shortcut: '⌘S',
          action: onSave,
        },
        {
          id: 'undo',
          label: 'Undo',
          icon: <Undo2 className="h-4 w-4" />,
          shortcut: '⌘Z',
          action: onUndo,
          disabled: !canUndo,
        },
        {
          id: 'redo',
          label: 'Redo',
          icon: <Redo2 className="h-4 w-4" />,
          shortcut: '⌘⇧Z',
          action: onRedo,
          disabled: !canRedo,
        },
        {
          id: 'fit',
          label: 'Fit to Center',
          icon: <ZoomIn className="h-4 w-4" />,
          shortcut: 'F',
          action: onFitToCenter,
        },
        {
          id: 'delete',
          label: 'Delete Capture',
          icon: <Trash2 className="h-4 w-4" />,
          action: onRequestDelete,
        }
      );
    }

    return commands;
  }, [isEditor, hasProject, canUndo, canRedo, onCopy, onSave, onUndo, onRedo, onFitToCenter, onRequestDelete]);

  // Navigation commands
  const navigationCommands = useMemo<CommandItem[]>(() => {
    const commands: CommandItem[] = [];

    if (isEditor) {
      commands.push({
        id: 'library',
        label: 'Back to Library',
        icon: <ArrowLeft className="h-4 w-4" />,
        action: onBackToLibrary,
      });
    }

    commands.push(
      {
        id: 'settings',
        label: 'Open Settings',
        icon: <Settings className="h-4 w-4" />,
        action: onOpenSettings,
      },
      {
        id: 'shortcuts',
        label: 'Keyboard Shortcuts',
        icon: <Keyboard className="h-4 w-4" />,
        shortcut: '?',
        action: onShowShortcuts,
      }
    );

    return commands;
  }, [isEditor, onBackToLibrary, onOpenSettings, onShowShortcuts]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {toolCommands.length > 0 && (
          <CommandGroup heading="Tools">
            {toolCommands.map(cmd => (
              <CommandItem
                key={cmd.id}
                onSelect={() => runCommand(cmd.action)}
                disabled={cmd.disabled}
              >
                {cmd.icon}
                <span>{cmd.label}</span>
                {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {toolCommands.length > 0 && actionCommands.length > 0 && <CommandSeparator />}

        {actionCommands.length > 0 && (
          <CommandGroup heading="Actions">
            {actionCommands.map(cmd => (
              <CommandItem
                key={cmd.id}
                onSelect={() => runCommand(cmd.action)}
                disabled={cmd.disabled}
              >
                {cmd.icon}
                <span>{cmd.label}</span>
                {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {(actionCommands.length > 0 || toolCommands.length > 0) && <CommandSeparator />}

        <CommandGroup heading="Navigation">
          {navigationCommands.map(cmd => (
            <CommandItem
              key={cmd.id}
              onSelect={() => runCommand(cmd.action)}
              disabled={cmd.disabled}
            >
              {cmd.icon}
              <span>{cmd.label}</span>
              {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
};
