import React from 'react';
import { Ellipse } from 'react-konva';
import type { BaseShapeProps } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

export const CircleShape: React.FC<BaseShapeProps> = React.memo(({
  shape,
  isDraggable,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
}) => {
  const cursorHandlers = useShapeCursor(isDraggable);

  return (
    <Ellipse
      id={shape.id}
      x={shape.x}
      y={shape.y}
      radiusX={shape.radiusX ?? shape.radius ?? 0}
      radiusY={shape.radiusY ?? shape.radius ?? 0}
      stroke={shape.stroke}
      strokeWidth={shape.strokeWidth}
      strokeScaleEnabled={false}
      fill={shape.fill}
      rotation={shape.rotation}
      draggable={isDraggable}
      onClick={onClick}
      onTap={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTransformStart={onTransformStart}
      onTransformEnd={onTransformEnd}
      {...cursorHandlers}
    />
  );
});

CircleShape.displayName = 'CircleShape';
