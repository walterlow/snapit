import React from 'react';
import { Text } from 'react-konva';
import type { BaseShapeProps } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

interface TextShapeProps extends BaseShapeProps {
  isEditing: boolean;
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
  onTransformEnd,
  onStartEdit,
}) => {
  const cursorHandlers = useShapeCursor(isDraggable);

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
      onTransformEnd={onTransformEnd}
      {...cursorHandlers}
    />
  );
});

TextShape.displayName = 'TextShape';
