import React, { useRef, useCallback, useMemo, useEffect } from 'react';
import { Arrow, Circle } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

interface ArrowShapeProps {
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

// Compute arrow visual endpoints from anchor positions
function computeArrowPoints(
  startX: number, startY: number,
  endX: number, endY: number,
  tailOffset: number,
  headOffset: number
): [number, number, number, number] {
  const dx = endX - startX;
  const dy = endY - startY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len;
  const ny = dy / len;

  return [
    startX + nx * tailOffset,  // Arrow start (small offset from tail anchor)
    startY + ny * tailOffset,
    endX - nx * headOffset,    // Arrow end (larger offset from head anchor)
    endY - ny * headOffset,
  ];
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
  takeSnapshot,
  commitSnapshot,
}) => {
  const cursorHandlers = useShapeCursor(isDraggable);
  // points[] = anchor positions (where handles sit)
  // Memoize to prevent new array reference on every render when shape.points is undefined
  const anchors = useMemo(() => shape.points || [0, 0, 0, 0], [shape.points]);
  const strokeWidth = shape.strokeWidth || 2;
  const handleSize = Math.min(6, Math.max(4, strokeWidth * 0.2)) / zoom;
  const tailOffset = strokeWidth + 1;  // Offset for tail, accounts for stroke
  const headOffset = strokeWidth + 6;        // Larger offset for arrowhead

  // Compute arrow visual endpoints (offset inward from anchors)
  const arrowPoints = useMemo(() =>
    computeArrowPoints(anchors[0], anchors[1], anchors[2], anchors[3], tailOffset, headOffset),
    [anchors, tailOffset, headOffset]
  );

  // Refs
  const arrowRef = useRef<Konva.Arrow>(null);
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

  // Arrow drag handlers
  const handleArrowDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    onDragStart(e);
  }, [onDragStart]);

  const handleArrowDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const moveDx = e.target.x();
    const moveDy = e.target.y();
    if (startHandleRef.current) {
      startHandleRef.current.position({ x: anchors[0] + moveDx, y: anchors[1] + moveDy });
    }
    if (endHandleRef.current) {
      endHandleRef.current.position({ x: anchors[2] + moveDx, y: anchors[3] + moveDy });
    }
  }, [anchors]);

  const handleArrowDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const dx = e.target.x();
    const dy = e.target.y();
    e.target.position({ x: 0, y: 0 });
    onDragEnd(e, [anchors[0] + dx, anchors[1] + dy, anchors[2] + dx, anchors[3] + dy]);
  }, [anchors, onDragEnd]);

  // Handle drag - moves 1:1, updates arrow in real-time
  const handleStartDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (arrowRef.current) {
      const newArrowPts = computeArrowPoints(
        e.target.x(), e.target.y(),
        anchors[2], anchors[3],
        tailOffset, headOffset
      );
      arrowRef.current.points(newArrowPts);
    }
  }, [anchors, tailOffset, headOffset]);

  const handleEndDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (arrowRef.current) {
      const newArrowPts = computeArrowPoints(
        anchors[0], anchors[1],
        e.target.x(), e.target.y(),
        tailOffset, headOffset
      );
      arrowRef.current.points(newArrowPts);
    }
  }, [anchors, tailOffset, headOffset]);

  const handleEndpointDragEnd = useCallback((endpointIndex: 0 | 1, e: Konva.KonvaEventObject<DragEvent>) => {
    const newAnchors = [...anchors];
    if (endpointIndex === 0) {
      newAnchors[0] = e.target.x();
      newAnchors[1] = e.target.y();
    } else {
      newAnchors[2] = e.target.x();
      newAnchors[3] = e.target.y();
    }
    onEndpointDragEnd(endpointIndex, newAnchors);
    commitSnapshot();
  }, [anchors, onEndpointDragEnd]);

  const hitStrokeWidth = Math.max((shape.strokeWidth || 2) * 3, 12);

  return (
    <>
      <Arrow
        ref={arrowRef}
        id={shape.id}
        points={arrowPoints}
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
        {...cursorHandlers}
      />
      {isSelected && isDraggable && (
        <>
          <Circle
            ref={startHandleRef}
            x={anchors[0]}
            y={anchors[1]}
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
            x={anchors[2]}
            y={anchors[3]}
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

ArrowShape.displayName = 'ArrowShape';
