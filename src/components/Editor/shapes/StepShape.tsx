import React from 'react';
import { Group, Circle, Text } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';

interface StepShapeProps {
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

export const StepShape: React.FC<StepShapeProps> = React.memo(({
  shape,
  isDraggable,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
}) => {
  const radius = shape.radius ?? 15;
  const fontSize = Math.round(radius * 0.93); // Scale font with radius
  const textOffset = fontSize * 0.3; // Approximate center offset

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
