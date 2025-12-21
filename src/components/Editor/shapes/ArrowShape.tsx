import React from 'react';
import { Arrow, Circle } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { takeSnapshot, commitSnapshot } from '../../../stores/editorStore';

interface ArrowShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  zoom: number;
  onSelect: () => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: () => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>, newPoints: number[]) => void;
  onEndpointDrag: (endpointIndex: 0 | 1, e: Konva.KonvaEventObject<DragEvent>) => void;
}

export const ArrowShape: React.FC<ArrowShapeProps> = React.memo(({
  shape,
  isSelected,
  isDraggable,
  zoom,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onEndpointDrag,
}) => {
  const points = shape.points || [0, 0, 0, 0];
  const handleSize = 6 / zoom;

  const handleArrowDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    // Calculate delta and update all points
    const dx = e.target.x();
    const dy = e.target.y();
    e.target.position({ x: 0, y: 0 }); // Reset position

    const newPoints = [
      points[0] + dx,
      points[1] + dy,
      points[2] + dx,
      points[3] + dy,
    ];
    onDragEnd(e, newPoints);
  };

  return (
    <>
      <Arrow
        id={shape.id}
        points={points}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
        fill={shape.fill}
        pointerLength={10}
        pointerWidth={10}
        draggable={isDraggable}
        onClick={onClick}
        onTap={onSelect}
        onDragStart={onDragStart}
        onDragEnd={handleArrowDragEnd}
      />
      {/* Custom endpoint handles for arrows */}
      {isSelected && isDraggable && (
        <>
          {/* Start point handle */}
          <Circle
            x={points[0]}
            y={points[1]}
            radius={handleSize}
            fill="#fbbf24"
            stroke="#fff"
            strokeWidth={1 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragMove={(e) => onEndpointDrag(0, e)}
            onDragEnd={() => commitSnapshot()}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'move';
            }}
            onMouseLeave={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'default';
            }}
          />
          {/* End point handle (arrow head) */}
          <Circle
            x={points[2]}
            y={points[3]}
            radius={handleSize}
            fill="#fbbf24"
            stroke="#fff"
            strokeWidth={1 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragMove={(e) => onEndpointDrag(1, e)}
            onDragEnd={() => commitSnapshot()}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'move';
            }}
            onMouseLeave={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'default';
            }}
          />
        </>
      )}
    </>
  );
});

ArrowShape.displayName = 'ArrowShape';
