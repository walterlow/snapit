import { useCallback } from 'react';
import Konva from 'konva';
import type { CanvasShape } from '../types';
import { takeSnapshot, commitSnapshot } from '../stores/editorStore';

interface UseShapeTransformProps {
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
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
}: UseShapeTransformProps): UseShapeTransformReturn => {

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
  }, []);

  // Handle transform end - bake final state and update React state
  const handleTransformEnd = useCallback(
    (id: string, e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      const shape = shapes.find(s => s.id === id);

      // For pen strokes, bake transform into points
      if (shape?.type === 'pen' && shape.points && shape.points.length >= 2) {
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        const nodeX = node.x();
        const nodeY = node.y();

        const newPoints = shape.points.map((val, i) => {
          if (i % 2 === 0) {
            return nodeX + val * scaleX;
          } else {
            return nodeY + val * scaleY;
          }
        });

        node.scaleX(1);
        node.scaleY(1);
        node.position({ x: 0, y: 0 });

        const updatedShapes = shapes.map(s =>
          s.id === id ? { ...s, points: newPoints } : s
        );
        onShapesChange(updatedShapes);
      }
      // For blur shapes, read dimensions from node
      else if (shape?.type === 'blur') {
        const updatedShapes = shapes.map(s => {
          if (s.id !== id) return s;
          return {
            ...s,
            x: node.x(),
            y: node.y(),
            width: node.width(),
            height: node.height(),
          };
        });
        onShapesChange(updatedShapes);
      }
      // For step shapes, bake scale into radius
      else if (shape?.type === 'step') {
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        const avgScale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
        const currentRadius = shape.radius ?? 15;
        const newRadius = Math.max(8, currentRadius * avgScale);

        node.scaleX(1);
        node.scaleY(1);

        const updatedShapes = shapes.map(s => {
          if (s.id !== id) return s;
          return {
            ...s,
            x: node.x(),
            y: node.y(),
            radius: newRadius,
          };
        });
        onShapesChange(updatedShapes);
      }
      // For rect, circle, highlight, text - bake scale into dimensions
      else if (shape) {
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();

        node.scaleX(1);
        node.scaleY(1);

        const updatedShapes = shapes.map((s) => {
          if (s.id !== id) return s;

          const updates: Partial<CanvasShape> = {
            x: node.x(),
            y: node.y(),
            rotation: node.rotation(),
          };

          if (s.width !== undefined) {
            updates.width = Math.abs(s.width * scaleX);
          }
          if (s.height !== undefined) {
            updates.height = Math.abs(s.height * scaleY);
          }
          if (s.radiusX !== undefined) {
            updates.radiusX = Math.abs(s.radiusX * scaleX);
          }
          if (s.radiusY !== undefined) {
            updates.radiusY = Math.abs(s.radiusY * scaleY);
          }
          if (s.radius !== undefined && s.radiusX === undefined) {
            updates.radiusX = Math.abs(s.radius * scaleX);
            updates.radiusY = Math.abs(s.radius * scaleY);
            updates.radius = undefined;
          }

          return { ...s, ...updates };
        });

        onShapesChange(updatedShapes);
      }

      commitSnapshot();
    },
    [shapes, onShapesChange]
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
