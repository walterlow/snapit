import { useCallback } from 'react';
import Konva from 'konva';
import type { CanvasShape } from '../types';
import type { EditorHistoryActions } from './useEditorHistory';

interface UseShapeTransformProps {
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  /** Context-aware history actions for undo/redo support */
  history: EditorHistoryActions;
}

interface UseShapeTransformReturn {
  handleShapeDragStart: (id: string, e: Konva.KonvaEventObject<DragEvent>) => void;
  handleShapeDragEnd: (id: string, e: Konva.KonvaEventObject<DragEvent>) => void;
  handleArrowDragEnd: (id: string, newPoints: number[]) => void;
  handleTransformStart: () => void;
  handleTransformEnd: (id: string, e: Konva.KonvaEventObject<Event>) => void;
  handleShapeClick: (shapeId: string, e: Konva.KonvaEventObject<MouseEvent>) => void;
  handleArrowEndpointDragEnd: (shapeId: string, newPoints: number[]) => void;
}

/**
 * Hook for shape transformation operations - drag, resize, rotate
 * Manages undo history snapshots for batched operations
 */
export const useShapeTransform = ({
  shapes,
  onShapesChange,
  selectedIds,
  setSelectedIds,
  history,
}: UseShapeTransformProps): UseShapeTransformReturn => {
  const { takeSnapshot, commitSnapshot } = history;

  // Pause history at drag start to batch all drag updates
  const handleShapeDragStart = useCallback((id: string, e: Konva.KonvaEventObject<DragEvent>) => {
    // Ignore middle mouse button (used for panning)
    if (e.evt.button === 1) {
      e.evt.preventDefault();
      return;
    }

    // Add to selection if not already selected
    if (!selectedIds.includes(id)) {
      setSelectedIds([id]);
    }
    takeSnapshot();
  }, [selectedIds, setSelectedIds]);

  // Handle shape drag end - supports both single and group movement
  const handleShapeDragEnd = useCallback(
    (id: string, e: Konva.KonvaEventObject<DragEvent>) => {
      const draggedShape = shapes.find(s => s.id === id);
      if (!draggedShape) {
        commitSnapshot();
        return;
      }

      // Calculate delta based on shape type
      const isPen = draggedShape.type === 'pen' && draggedShape.points && draggedShape.points.length >= 2;
      const dx = e.target.x() - (isPen ? 0 : (draggedShape.x ?? 0));
      const dy = e.target.y() - (isPen ? 0 : (draggedShape.y ?? 0));

      // Reset position for pen strokes (they use points, not x/y)
      if (isPen) {
        e.target.position({ x: 0, y: 0 });
      }

      // Group drag: move all selected shapes by the same delta
      if (selectedIds.length > 1 && selectedIds.includes(id)) {
        const updatedShapes = shapes.map((shape) => {
          if (!selectedIds.includes(shape.id)) return shape;

          if (shape.type === 'pen' && shape.points && shape.points.length >= 2) {
            const newPoints = shape.points.map((val, i) =>
              i % 2 === 0 ? val + dx : val + dy
            );
            return { ...shape, points: newPoints };
          }

          return {
            ...shape,
            x: (shape.x ?? 0) + dx,
            y: (shape.y ?? 0) + dy,
          };
        });
        onShapesChange(updatedShapes);
      } else {
        // Single shape drag
        if (isPen) {
          const newPoints = draggedShape.points!.map((val, i) =>
            i % 2 === 0 ? val + dx : val + dy
          );
          const updatedShapes = shapes.map((shape) =>
            shape.id === id ? { ...shape, points: newPoints } : shape
          );
          onShapesChange(updatedShapes);
        } else if (draggedShape.type === 'blur') {
          // Blur uses normalized position
          const normalizedX = (draggedShape.width ?? 0) < 0
            ? (draggedShape.x ?? 0) + (draggedShape.width ?? 0)
            : (draggedShape.x ?? 0);
          const normalizedY = (draggedShape.height ?? 0) < 0
            ? (draggedShape.y ?? 0) + (draggedShape.height ?? 0)
            : (draggedShape.y ?? 0);
          const blurDx = e.target.x() - normalizedX;
          const blurDy = e.target.y() - normalizedY;
          const updatedShapes = shapes.map((shape) =>
            shape.id === id
              ? { ...shape, x: (shape.x ?? 0) + blurDx, y: (shape.y ?? 0) + blurDy }
              : shape
          );
          onShapesChange(updatedShapes);
        } else {
          const updatedShapes = shapes.map((shape) =>
            shape.id === id
              ? { ...shape, x: e.target.x(), y: e.target.y() }
              : shape
          );
          onShapesChange(updatedShapes);
        }
      }

      // Resume history tracking
      commitSnapshot();
    },
    [shapes, onShapesChange, selectedIds]
  );

  // Handle transform start - pause history
  const handleTransformStart = useCallback(() => {
    takeSnapshot();
  }, [takeSnapshot]);

  // Handle transform end - NO-OP for Transformer-attached shapes
  // The Transformer's onTransformEnd in EditorCanvas handles all shapes at once
  // to ensure proper batched history (single undo for multi-shape transforms).
  // This handler remains for API compatibility but does nothing.
  const handleTransformEnd = useCallback(
    (_id: string, _e: Konva.KonvaEventObject<Event>) => {
      // Intentionally empty - Transformer's onTransformEnd handles this
    },
    []
  );

  // Handle shape click with shift for multi-select
  const handleShapeClick = useCallback(
    (shapeId: string, e: Konva.KonvaEventObject<MouseEvent>) => {
      // Ignore middle mouse button (used for panning)
      if (e.evt.button === 1) return;

      if (e.evt.shiftKey) {
        // Toggle selection with shift
        if (selectedIds.includes(shapeId)) {
          setSelectedIds(selectedIds.filter(id => id !== shapeId));
        } else {
          setSelectedIds([...selectedIds, shapeId]);
        }
      } else {
        // Keep group selection if clicking already-selected shape
        if (!selectedIds.includes(shapeId)) {
          setSelectedIds([shapeId]);
        }
      }
    },
    [selectedIds, setSelectedIds]
  );

  // Handle arrow drag end - updates all points by delta
  const handleArrowDragEnd = useCallback(
    (id: string, newPoints: number[]) => {
      const updatedShapes = shapes.map(s =>
        s.id === id ? { ...s, points: newPoints } : s
      );
      onShapesChange(updatedShapes);
      commitSnapshot();
    },
    [shapes, onShapesChange]
  );

  // Handle arrow endpoint drag end - update state only at the end
  const handleArrowEndpointDragEnd = useCallback(
    (shapeId: string, newPoints: number[]) => {
      const updatedShapes = shapes.map(s =>
        s.id === shapeId ? { ...s, points: newPoints } : s
      );
      onShapesChange(updatedShapes);
    },
    [shapes, onShapesChange]
  );

  return {
    handleShapeDragStart,
    handleShapeDragEnd,
    handleArrowDragEnd,
    handleTransformStart,
    handleTransformEnd,
    handleShapeClick,
    handleArrowEndpointDragEnd,
  };
};
