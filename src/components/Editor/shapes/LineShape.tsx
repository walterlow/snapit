import React, { useRef, useCallback, useEffect, useMemo } from 'react';
import { Line, Circle } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

interface LineShapeProps {
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  zoom: number;
  onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>, newPoints: number[]) => void;
  onEndpointDragEnd: (endpointIndex: 0 | 1, newPoints: number[]) => void;
  /** Take snapshot before starting an edit action */
  takeSnapshot: () => void;
  /** Commit snapshot after completing an edit action */
  commitSnapshot: () => void;
}

export const LineShape: React.FC<LineShapeProps> = React.memo(({
  shape,
  isSelected,
  isDraggable,
  zoom,
  onClick,
  onSelect,
  onDragStart,
  onDragEnd,
  onEndpointDragEnd,
  takeSnapshot,
  commitSnapshot,
}) => {
  const cursorHandlers = useShapeCursor(isDraggable);
  // points[] = [startX, startY, endX, endY]
  // Memoize to prevent new array reference on every render when shape.points is undefined
  const points = useMemo(() => shape.points || [0, 0, 0, 0], [shape.points]);
  const strokeWidth = shape.strokeWidth || 2;
  const handleSize = Math.min(6, Math.max(4, strokeWidth * 0.2)) / zoom;

  // Refs
  const lineRef = useRef<Konva.Line>(null);
  const startHandleRef = useRef<Konva.Circle>(null);
  const endHandleRef = useRef<Konva.Circle>(null);

  // Smooth handle size transitions on zoom
  const handleStrokeWidth = 1.5 / zoom;
  useEffect(() => {
    if (startHandleRef.current && isSelected) {
      startHandleRef.current.to({ radius: handleSize, strokeWidth: handleStrokeWidth, duration: 0.1 });
    }
    if (endHandleRef.current && isSelected) {
      endHandleRef.current.to({ radius: handleSize, strokeWidth: handleStrokeWidth, duration: 0.1 });
    }
  }, [handleSize, handleStrokeWidth, isSelected]);

  // Line drag handlers
  const handleLineDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    onDragStart(e);
  }, [onDragStart]);

  const handleLineDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const moveDx = e.target.x();
    const moveDy = e.target.y();
    if (startHandleRef.current) {
      startHandleRef.current.position({ x: points[0] + moveDx, y: points[1] + moveDy });
    }
    if (endHandleRef.current) {
      endHandleRef.current.position({ x: points[2] + moveDx, y: points[3] + moveDy });
    }
  }, [points]);

  const handleLineDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const dx = e.target.x();
    const dy = e.target.y();
    e.target.position({ x: 0, y: 0 });
    onDragEnd(e, [points[0] + dx, points[1] + dy, points[2] + dx, points[3] + dy]);
  }, [points, onDragEnd]);

  // Handle drag - moves 1:1, updates line in real-time
  const handleStartDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (lineRef.current) {
      lineRef.current.points([e.target.x(), e.target.y(), points[2], points[3]]);
    }
  }, [points]);

  const handleEndDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (lineRef.current) {
      lineRef.current.points([points[0], points[1], e.target.x(), e.target.y()]);
    }
  }, [points]);

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
      <Line
        ref={lineRef}
        id={shape.id}
        points={points}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
        lineCap="round"
        lineJoin="round"
        hitStrokeWidth={hitStrokeWidth}
        draggable={isDraggable}
        onClick={onClick}
        onTap={onSelect}
        onDragStart={handleLineDragStart}
        onDragMove={handleLineDragMove}
        onDragEnd={handleLineDragEnd}
        {...cursorHandlers}
      />
      {isSelected && isDraggable && (
        <>
          <Circle
            ref={startHandleRef}
            x={points[0]}
            y={points[1]}
            radius={handleSize}
            fill="#fff"
            stroke="#374151"
            strokeWidth={1.5 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragMove={handleStartDragMove}
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
          <Circle
            ref={endHandleRef}
            x={points[2]}
            y={points[3]}
            radius={handleSize}
            fill="#fff"
            stroke="#374151"
            strokeWidth={1.5 / zoom}
            draggable
            onDragStart={() => takeSnapshot()}
            onDragMove={handleEndDragMove}
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

LineShape.displayName = 'LineShape';
