import React from 'react';
import { Group, Circle, Text } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';

interface StepShapeProps {
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

export const StepShape: React.FC<StepShapeProps> = React.memo(({
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
    <Group
      id={shape.id}
      x={shape.x}
      y={shape.y}
      draggable={isDraggable}
      onClick={onClick}
      onTap={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTransformStart={onTransformStart}
      onTransform={onTransform}
      onTransformEnd={onTransformEnd}
    >
      <Circle radius={15} fill={shape.fill} />
      <Text
        text={String(shape.number)}
        fontSize={14}
        fill="white"
        fontStyle="bold"
        align="center"
        verticalAlign="middle"
        offsetX={4}
        offsetY={6}
      />
    </Group>
  );
});

StepShape.displayName = 'StepShape';
