import React from 'react';
import { Line } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';

interface PenShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  onSelect: () => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: () => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransform: (e: Konva.KonvaEventObject<Event>) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

export const PenShape: React.FC<PenShapeProps> = React.memo(({
  shape,
  isDraggable,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransform,
  onTransformEnd,
}) => {
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
      onTransform={onTransform}
      onTransformEnd={onTransformEnd}
    />
  );
});

PenShape.displayName = 'PenShape';
