import React, { useState, useCallback } from 'react';
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

  // Track drag offset so handles follow the arrow in real-time
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleArrowDragStart = useCallback(() => {
    setDragOffset({ x: 0, y: 0 });
    onDragStart();
  }, [onDragStart]);

  const handleArrowDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    // Update offset so handles follow in real-time
    setDragOffset({ x: e.target.x(), y: e.target.y() });
  }, []);

  const handleArrowDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    // Calculate delta and update all points
    const dx = e.target.x();
    const dy = e.target.y();
    e.target.position({ x: 0, y: 0 }); // Reset position
    setDragOffset({ x: 0, y: 0 }); // Reset offset

    const newPoints = [
      points[0] + dx,
      points[1] + dy,
      points[2] + dx,
      points[3] + dy,
    ];
    onDragEnd(e, newPoints);
  }, [points, onDragEnd]);

  // Larger hit area for easier body dragging
  const hitStrokeWidth = Math.max((shape.strokeWidth || 2) * 3, 12);

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
        hitStrokeWidth={hitStrokeWidth}
        draggable={isDraggable}
        onClick={onClick}
        onTap={onSelect}
        onDragStart={handleArrowDragStart}
        onDragMove={handleArrowDragMove}
        onDragEnd={handleArrowDragEnd}
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
      />
      {/* Custom endpoint handles for arrows - for changing direction */}
      {isSelected && isDraggable && (
        <>
          {/* Start point handle (tail) */}
          <Circle
            x={points[0] + dragOffset.x}
            y={points[1] + dragOffset.y}
            radius={handleSize}
            fill="#3b82f6"
            stroke="#fff"
            strokeWidth={1.5 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragMove={(e) => onEndpointDrag(0, e)}
            onDragEnd={() => commitSnapshot()}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'ew-resize';
            }}
            onMouseLeave={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'default';
            }}
          />
          {/* End point handle (arrow head) */}
          <Circle
            x={points[2] + dragOffset.x}
            y={points[3] + dragOffset.y}
            radius={handleSize}
            fill="#f97316"
            stroke="#fff"
            strokeWidth={1.5 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragMove={(e) => onEndpointDrag(1, e)}
            onDragEnd={() => commitSnapshot()}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'ew-resize';
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
