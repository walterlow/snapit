import React from 'react';
import { Text } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';

interface TextShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: () => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransform: (e: Konva.KonvaEventObject<Event>) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
  onStartEdit: () => void;
}

export const TextShape: React.FC<TextShapeProps> = React.memo(({
  shape,
  isDraggable,
  isEditing,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransform,
  onTransformEnd,
  onStartEdit,
}) => {
  return (
    <Text
      id={shape.id}
      x={shape.x}
      y={shape.y}
      text={shape.text}
      fontSize={shape.fontSize}
      fill={shape.fill}
      rotation={shape.rotation}
      visible={!isEditing}
      draggable={isDraggable}
      onClick={onClick}
      onTap={onSelect}
      onDblClick={onStartEdit}
      onDblTap={onStartEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTransformStart={onTransformStart}
      onTransform={onTransform}
      onTransformEnd={onTransformEnd}
    />
  );
});

TextShape.displayName = 'TextShape';
