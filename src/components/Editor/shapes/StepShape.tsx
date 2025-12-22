import React from 'react';
import { Group, Circle, Text } from 'react-konva';
import type { BaseShapeProps } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

export const StepShape: React.FC<BaseShapeProps> = React.memo(({
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
  const radius = shape.radius ?? 15;
  const fontSize = Math.round(radius * 0.93);
  const textOffset = fontSize * 0.3;

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
      onTransformEnd={onTransformEnd}
      {...cursorHandlers}
    >
      <Circle radius={radius} fill={shape.fill} />
      <Text
        text={String(shape.number)}
        fontSize={fontSize}
        fill="white"
        fontStyle="bold"
        align="center"
        verticalAlign="middle"
        offsetX={textOffset}
        offsetY={fontSize * 0.43}
      />
    </Group>
  );
});

StepShape.displayName = 'StepShape';
