import React from 'react';
import { Rect } from 'react-konva';

interface SelectionBoundsRectProps {
  bounds: { x: number; y: number; width: number; height: number } | null;
  isDraggable: boolean;
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
  onDragStart,
  onDragEnd,
}) => {
  if (!bounds) return null;

  return (
    <Rect
      x={bounds.x}
      y={bounds.y}
      width={bounds.width}
      height={bounds.height}
      fill="transparent"
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragEnd={(e) => {
        const dx = e.target.x() - bounds.x;
        const dy = e.target.y() - bounds.y;
        // Reset position (shapes will be updated separately)
        e.target.position({ x: bounds.x, y: bounds.y });
        onDragEnd(dx, dy);
      }}
    />
  );
});

SelectionBoundsRect.displayName = 'SelectionBoundsRect';
