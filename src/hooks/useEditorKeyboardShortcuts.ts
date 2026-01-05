import { useEffect, useState, useCallback } from 'react';
import type { Tool } from '../types';

/**
 * Tool shortcuts mapping (single keys, no modifiers)
 */
const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: 'select',
  c: 'crop',
  a: 'arrow',
  l: 'line',
  r: 'rect',
  e: 'circle',
  t: 'text',
  h: 'highlight',
  b: 'blur',
  s: 'steps',
  p: 'pen',
};

interface UseEditorKeyboardShortcutsProps {
  view: 'library' | 'editor' | 'videoEditor';
  selectedTool: Tool;
  selectedIds: string[];
  compositorEnabled: boolean;
  onToolChange: (tool: Tool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onCopy: () => void;
  onToggleCompositor: () => void;
  onShowShortcuts: () => void;
  onDeselect: () => void;
  onFitToCenter: () => void;
}

interface UseEditorKeyboardShortcutsReturn {
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
}

/**
 * Hook for editor keyboard shortcuts.
 * Consolidates all keyboard handling from App.tsx:
 * - Command palette (Ctrl+K) - works in all views
 * - Tool shortcuts (V, C, A, L, R, E, T, H, B, S, P, G) - editor only
 * - Undo/Redo (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) - editor only
 * - Escape handling (deselect → select tool) - editor only
 * - Fit to center (F) - editor only
 * - Help modal (?) - editor only
 * - Save (Ctrl+E) and Copy (Ctrl+C) - editor only
 */
export const useEditorKeyboardShortcuts = ({
  view,
  selectedTool,
  selectedIds,
  compositorEnabled,
  onToolChange,
  onUndo,
  onRedo,
  onSave,
  onCopy,
  onToggleCompositor,
  onShowShortcuts,
  onDeselect,
  onFitToCenter,
}: UseEditorKeyboardShortcutsProps): UseEditorKeyboardShortcutsReturn => {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Check if event target is an input field
  const isInputTarget = useCallback((e: KeyboardEvent): boolean => {
    return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  }, []);

  // Command palette shortcut (Ctrl+K / Cmd+K) - works in all views
  useEffect(() => {
    const handleCommandPalette = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handleCommandPalette);
    return () => window.removeEventListener('keydown', handleCommandPalette);
  }, []);

  // Editor-only shortcuts: tools, undo/redo, escape, help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle in editor view
      if (view !== 'editor') return;

      // Don't handle shortcuts when typing in an input
      if (isInputTarget(e)) return;

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          onRedo();
        } else {
          onUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        onRedo();
        return;
      }

      // Save (Ctrl+E) and Copy (Ctrl+C)
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        onSave();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        onCopy();
        return;
      }

      // Tool shortcuts (only when no modifier keys)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const tool = TOOL_SHORTCUTS[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        onToolChange(tool);
        return;
      }

      // G: Toggle background tool and compositor
      if (e.key.toLowerCase() === 'g') {
        e.preventDefault();
        // If already on background tool, toggle the effect off and switch to select
        if (selectedTool === 'background') {
          onToggleCompositor();
          onToolChange('select');
        } else {
          // Switch to background tool and enable effect
          onToolChange('background');
          if (!compositorEnabled) {
            onToggleCompositor();
          }
        }
        return;
      }

      // F: Fit to center
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        onFitToCenter();
        return;
      }

      // Escape: deselect shapes first, then switch to select tool
      if (e.key === 'Escape') {
        e.preventDefault();
        // Priority 1: Deselect shapes if any are selected
        if (selectedIds.length > 0) {
          onDeselect();
          return;
        }
        // Priority 2: Switch to select tool if on different tool
        if (selectedTool !== 'select') {
          onToolChange('select');
          return;
        }
        return;
      }

      // Show keyboard shortcuts help
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        onShowShortcuts();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    view,
    selectedTool,
    selectedIds,
    compositorEnabled,
    isInputTarget,
    onToolChange,
    onUndo,
    onRedo,
    onSave,
    onCopy,
    onToggleCompositor,
    onShowShortcuts,
    onDeselect,
    onFitToCenter,
  ]);

  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
  };
};
