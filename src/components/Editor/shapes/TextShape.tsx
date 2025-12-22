import React, { useRef } from 'react';
import { Group, Rect, Text } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

interface TextShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  isEditing: boolean;
  zoom: number;
  onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
  onStartEdit: () => void;
}

// Minimum dimensions for text box
const MIN_WIDTH = 50;
const MIN_HEIGHT = 24;

export const TextShape: React.FC<TextShapeProps> = React.memo(({
  shape,
  isSelected,
  isDraggable,
  isEditing,
  zoom,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
  onStartEdit,
}) => {
  const cursorHandlers = useShapeCursor(isDraggable);
  const groupRef = useRef<Konva.Group>(null);

  const width = shape.width || MIN_WIDTH;
  const height = shape.height || MIN_HEIGHT;

  // Show placeholder text when empty
  const displayText = shape.text || (isEditing ? '' : 'Double-click to edit');
  const textOpacity = shape.text ? 1 : 0.4;

  return (
    <Group
      ref={groupRef}
      id={shape.id}
      x={shape.x}
      y={shape.y}
      width={width}
      height={height}
      rotation={shape.rotation}
      scaleX={shape.scaleX}
      scaleY={shape.scaleY}
      draggable={isDraggable && !isEditing}
      onClick={onClick}
      onTap={onSelect}
      onDblClick={onStartEdit}
      onDblTap={onStartEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTransformStart={onTransformStart}
      onTransformEnd={onTransformEnd}
      {...cursorHandlers}
    >
      {/* Bounding box border - only visible when selected and not editing */}
      {isSelected && !isEditing && (
        <Rect
          name="text-box-border"
          x={0}
          y={0}
          width={width}
          height={height}
          stroke="#3B82F6"
          strokeWidth={1 / zoom}
          dash={[4 / zoom, 4 / zoom]}
          listening={false}
        />
      )}

      {/* Text content */}
      <Text
        name="text-content"
        x={0}
        y={0}
        width={width}
        height={height}
        text={displayText}
        fontSize={shape.fontSize || 36}
        fontFamily={shape.fontFamily || 'Arial'}
        fontStyle={shape.fontStyle || 'normal'}
        textDecoration={shape.textDecoration || ''}
        align={shape.align || 'left'}
        verticalAlign={shape.verticalAlign || 'top'}
        wrap={shape.wrap || 'word'}
        lineHeight={shape.lineHeight || 1.2}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth || 0}
        opacity={textOpacity}
        visible={!isEditing}
        padding={4}
      />
    </Group>
  );
});

TextShape.displayName = 'TextShape';
