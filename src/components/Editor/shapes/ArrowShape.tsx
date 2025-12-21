import React, { useRef, useCallback } from 'react';
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
  onEndpointDragEnd: (endpointIndex: 0 | 1, newPoints: number[]) => void;
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
  onEndpointDragEnd,
}) => {
  const points = shape.points || [0, 0, 0, 0];
  const handleSize = 6 / zoom;

  // Refs for endpoint handles to move them during arrow drag
  const startHandleRef = useRef<Konva.Circle>(null);
  const endHandleRef = useRef<Konva.Circle>(null);

  const handleArrowDragStart = useCallback(() => {
    onDragStart();
  }, [onDragStart]);

  const handleArrowDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    // Move endpoint handles in sync with arrow (Konva-level, no React state)
    const dx = e.target.x();
    const dy = e.target.y();
    if (startHandleRef.current) {
      startHandleRef.current.position({ x: points[0] + dx, y: points[1] + dy });
    }
    if (endHandleRef.current) {
      endHandleRef.current.position({ x: points[2] + dx, y: points[3] + dy });
    }
  }, [points]);

  const handleArrowDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const dx = e.target.x();
    const dy = e.target.y();
    e.target.position({ x: 0, y: 0 });

    const newPoints = [
      points[0] + dx,
      points[1] + dy,
      points[2] + dx,
      points[3] + dy,
    ];
    onDragEnd(e, newPoints);
  }, [points, onDragEnd]);

  // Handle endpoint drag end - update React state only at the end
  const handleEndpointDragEnd = useCallback((endpointIndex: 0 | 1, e: Konva.KonvaEventObject<DragEvent>) => {
    const newPoints = [...points];
    if (endpointIndex === 0) {
      newPoints[0] = e.target.x();
      newPoints[1] = e.target.y();
    } else {
      newPoints[2] = e.target.x();
      newPoints[3] = e.target.y();
    }
    onEndpointDragEnd(endpointIndex, newPoints);
    commitSnapshot();
  }, [points, onEndpointDragEnd]);

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
      {/* Custom endpoint handles for arrows */}
      {isSelected && isDraggable && (
        <>
          {/* Start point handle (tail) */}
          <Circle
            ref={startHandleRef}
            x={points[0]}
            y={points[1]}
            radius={handleSize}
            fill="#3b82f6"
            stroke="#fff"
            strokeWidth={1.5 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragEnd={(e) => handleEndpointDragEnd(0, e)}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'crosshair';
            }}
            onMouseLeave={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'default';
            }}
          />
          {/* End point handle (arrow head) */}
          <Circle
            ref={endHandleRef}
            x={points[2]}
            y={points[3]}
            radius={handleSize}
            fill="#f97316"
            stroke="#fff"
            strokeWidth={1.5 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragEnd={(e) => handleEndpointDragEnd(1, e)}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'crosshair';
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
