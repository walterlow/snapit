import React, { useRef } from 'react';
import { Rect } from 'react-konva';
import Konva from 'konva';

interface SelectionBoundsRectProps {
  bounds: { x: number; y: number; width: number; height: number } | null;
  isDraggable: boolean;
  selectedIds: string[];
  layerRef: React.RefObject<Konva.Layer | null>;
  onDragStart: () => void;
  onDragEnd: (dx: number, dy: number) => void;
}

/**
 * Transparent rectangle for group drag operations
 * Shown when multiple shapes are selected
 */
export const SelectionBoundsRect: React.FC<SelectionBoundsRectProps> = React.memo(({
  bounds,
  isDraggable,
  selectedIds,
  layerRef,
  onDragStart,
  onDragEnd,
}) => {
  // Store initial positions of shapes when drag starts
  const initialPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const startBoundsRef = useRef<{ x: number; y: number } | null>(null);

  if (!bounds) return null;

  return (
    <Rect
      x={bounds.x}
      y={bounds.y}
      width={bounds.width}
      height={bounds.height}
      fill="transparent"
      draggable={isDraggable}
      onDragStart={(e) => {
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'move';

        // Store initial positions
        startBoundsRef.current = { x: bounds.x, y: bounds.y };
        initialPositionsRef.current.clear();

        if (layerRef.current) {
          selectedIds.forEach((id) => {
            const node = layerRef.current!.findOne(`#${id}`);
            if (node) {
              initialPositionsRef.current.set(id, { x: node.x(), y: node.y() });
            }
          });
        }

        onDragStart();
      }}
      onDragMove={(e) => {
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'move';

        if (!startBoundsRef.current || !layerRef.current) return;

        const dx = e.target.x() - startBoundsRef.current.x;
        const dy = e.target.y() - startBoundsRef.current.y;

        // Move Konva nodes directly (no React state update)
        initialPositionsRef.current.forEach((pos, id) => {
          const node = layerRef.current!.findOne(`#${id}`);
          if (node) {
            node.position({ x: pos.x + dx, y: pos.y + dy });
          }
        });

        layerRef.current.batchDraw();
      }}
      onDragEnd={(e) => {
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'default';

        if (!startBoundsRef.current) return;

        const dx = e.target.x() - startBoundsRef.current.x;
        const dy = e.target.y() - startBoundsRef.current.y;

        // Reset rect position
        e.target.position({ x: bounds.x, y: bounds.y });

        // Clear refs
        initialPositionsRef.current.clear();
        startBoundsRef.current = null;

        onDragEnd(dx, dy);
      }}
      onMouseEnter={(e) => {
        if (!isDraggable) return;
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'move';
      }}
      onMouseLeave={(e) => {
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'default';
      }}
    />
  );
});

SelectionBoundsRect.displayName = 'SelectionBoundsRect';
