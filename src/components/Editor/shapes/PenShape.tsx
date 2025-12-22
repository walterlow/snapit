import React from 'react';
import { Line } from 'react-konva';
import type { BaseShapeProps } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

export const PenShape: React.FC<BaseShapeProps> = React.memo(({
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
    <Line
      id={shape.id}
      points={shape.points || []}
      stroke={shape.stroke}
      strokeWidth={shape.strokeWidth}
      hitStrokeWidth={Math.max(20, (shape.strokeWidth || 2) * 3)}
      tension={0.5}
      lineCap="round"
      lineJoin="round"
      globalCompositeOperation="source-over"
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

PenShape.displayName = 'PenShape';
