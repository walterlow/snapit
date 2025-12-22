import React from 'react';
import { Rect } from 'react-konva';
import type { BaseShapeProps } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

export const HighlightShape: React.FC<BaseShapeProps> = React.memo(({
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
    <Rect
      id={shape.id}
      x={shape.x}
      y={shape.y}
      width={shape.width}
      height={shape.height}
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

HighlightShape.displayName = 'HighlightShape';
