import { useEffect, useState, useCallback } from 'react';
import type { CanvasShape } from '../types';
import { recordAction } from '../stores/editorStore';

interface UseKeyboardShortcutsProps {
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
}

interface UseKeyboardShortcutsReturn {
  isShiftHeld: boolean;
}

/**
 * Hook for keyboard shortcuts in the editor canvas
 * - Delete/Backspace: Delete selected shapes
 * - Ctrl+A: Select all shapes
 * - Escape: Deselect all
 * - Shift: Track for proportional resize constraint
 */
export const useKeyboardShortcuts = ({
  selectedIds,
  setSelectedIds,
  shapes,
  onShapesChange,
}: UseKeyboardShortcutsProps): UseKeyboardShortcutsReturn => {
  const [isShiftHeld, setIsShiftHeld] = useState(false);

  // Delete selected shapes handler
  const handleDelete = useCallback(() => {
    if (selectedIds.length === 0) return;

    recordAction(() => {
      const newShapes = shapes.filter((shape) => !selectedIds.includes(shape.id));
      onShapesChange(newShapes);
    });
    setSelectedIds([]);
  }, [selectedIds, shapes, onShapesChange, setSelectedIds]);

  // Select all shapes handler
  const handleSelectAll = useCallback(() => {
    if (shapes.length === 0) return;
    setSelectedIds(shapes.map(s => s.id));
  }, [shapes, setSelectedIds]);

  // Deselect all handler
  const handleDeselect = useCallback(() => {
    setSelectedIds([]);
  }, [setSelectedIds]);

  // Keyboard shortcuts for shape manipulation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Delete selected shapes
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault();
        handleDelete();
        return;
      }

      // Ctrl+A: Select all shapes
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && shapes.length > 0) {
        e.preventDefault();
        handleSelectAll();
        return;
      }

      // Escape: Deselect all
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDeselect();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, shapes, handleDelete, handleSelectAll, handleDeselect]);

  // Track Shift key for proportional resize constraint
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftHeld(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  return { isShiftHeld };
};
