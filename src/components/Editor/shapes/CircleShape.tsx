import React from 'react';
import { Ellipse } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';

interface CircleShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

export const CircleShape: React.FC<CircleShapeProps> = React.memo(({
  shape,
  isDraggable,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
}) => {
  return (
    <Ellipse
      id={shape.id}
      x={shape.x}
      y={shape.y}
      radiusX={shape.radiusX ?? shape.radius ?? 0}
      radiusY={shape.radiusY ?? shape.radius ?? 0}
      stroke={shape.stroke}
      strokeWidth={shape.strokeWidth}
      fill={shape.fill}
      rotation={shape.rotation}
      draggable={isDraggable}
      onClick={onClick}
      onTap={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTransformStart={onTransformStart}
      onTransformEnd={onTransformEnd}
      onMouseEnter={(e) => {
        if (isDraggable) {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'move';
        }
      }}
      onMouseLeave={(e) => {
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'default';
      }}
    />
  );
});

CircleShape.displayName = 'CircleShape';
