import { useEffect, useState, useCallback } from 'react';
import { nanoid } from 'nanoid';
import type { CanvasShape } from '../types';

/** Check if keyboard event target is a text input (should ignore shortcuts) */
export function isTextInputTarget(e: KeyboardEvent): boolean {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
}

interface UseKeyboardShortcutsProps {
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  /** Record action for undo/redo (take snapshot + action + commit) */
  recordAction: (action: () => void) => void;
}

interface UseKeyboardShortcutsReturn {
  isShiftHeld: boolean;
}

/**
 * Hook for keyboard shortcuts in the editor canvas
 * - Delete/Backspace: Delete selected shapes
 * - Ctrl+A: Select all shapes
 * - Ctrl+D: Duplicate selected shapes
 * - Shift: Track for proportional resize constraint
 */
export const useKeyboardShortcuts = ({
  selectedIds,
  setSelectedIds,
  shapes,
  onShapesChange,
  recordAction,
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

  // Duplicate selected shapes handler
  const handleDuplicate = useCallback(() => {
    if (selectedIds.length === 0) return;

    recordAction(() => {
      const duplicatedShapes: CanvasShape[] = [];
      const newSelectedIds: string[] = [];
      const OFFSET = 20; // Offset duplicates by 20px for visibility

      selectedIds.forEach(id => {
        const original = shapes.find(s => s.id === id);
        if (original) {
          const newId = nanoid();
          const duplicate: CanvasShape = {
            ...original,
            id: newId,
            // Offset position for visibility
            x: (original.x ?? 0) + OFFSET,
            y: (original.y ?? 0) + OFFSET,
            // For pen tool, offset all points
            points: original.points?.map((val) =>
              val + OFFSET // All points need offset (x and y alternate)
            ),
          };
          duplicatedShapes.push(duplicate);
          newSelectedIds.push(newId);
        }
      });

      onShapesChange([...shapes, ...duplicatedShapes]);
      setSelectedIds(newSelectedIds);
    });
  }, [selectedIds, shapes, onShapesChange, setSelectedIds]);

  // Keyboard shortcuts for shape manipulation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (isTextInputTarget(e)) {
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

      // Ctrl+D: Duplicate selected shapes
      if ((e.ctrlKey || e.metaKey) && e.key === 'd' && selectedIds.length > 0) {
        e.preventDefault();
        handleDuplicate();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, shapes, handleDelete, handleSelectAll, handleDuplicate]);

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
