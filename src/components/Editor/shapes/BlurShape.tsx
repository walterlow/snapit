import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Group, Image, Rect } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { renderBlurCanvas, BlurRenderResult } from '../../../utils/blurRenderer';

interface BlurShapeProps {
  shape: CanvasShape;
  sourceImage: HTMLImageElement | undefined;
  isSelected: boolean;
  isDraggable: boolean;
  isActivelyDrawing: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

/**
 * BlurShape component - renders blur/pixelate effect with real-time updates
 * Uses GPU-accelerated blur via native canvas filter
 */
export const BlurShape: React.FC<BlurShapeProps> = React.memo(({
  shape,
  sourceImage,
  isSelected,
  isDraggable,
  isActivelyDrawing,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
}) => {
  const rectRef = useRef<Konva.Rect>(null);
  const [blurResult, setBlurResult] = useState<BlurRenderResult | null>(null);

  // Track the shape's logical bounds (may extend outside image)
  const [liveRect, setLiveRect] = useState({
    x: shape.x || 0,
    y: shape.y || 0,
    width: shape.width || 0,
    height: shape.height || 0,
  });

  const blurType = shape.blurType || 'pixelate';
  const blurAmount = shape.blurAmount || shape.pixelSize || 10;

  // Normalized values for the shape bounds (handle negative dimensions)
  const shapeX = liveRect.width < 0 ? liveRect.x + liveRect.width : liveRect.x;
  const shapeY = liveRect.height < 0 ? liveRect.y + liveRect.height : liveRect.y;
  const shapeWidth = Math.abs(liveRect.width);
  const shapeHeight = Math.abs(liveRect.height);

  // Sync with shape state when props change (external updates)
  useEffect(() => {
    setLiveRect({
      x: shape.x || 0,
      y: shape.y || 0,
      width: shape.width || 0,
      height: shape.height || 0,
    });
  }, [shape.x, shape.y, shape.width, shape.height]);

  // Render blur whenever position/size changes
  useEffect(() => {
    if (!sourceImage || shapeWidth < 1 || shapeHeight < 1) {
      setBlurResult(null);
      return;
    }
    const result = renderBlurCanvas(
      sourceImage,
      shapeX,
      shapeY,
      shapeWidth,
      shapeHeight,
      blurType,
      blurAmount
    );
    setBlurResult(result);
  }, [sourceImage, shapeX, shapeY, shapeWidth, shapeHeight, blurType, blurAmount]);

  // Real-time update during drag
  const handleDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    setLiveRect((prev) => ({
      ...prev,
      x: prev.width < 0 ? node.x() + Math.abs(prev.width) : node.x(),
      y: prev.height < 0 ? node.y() + Math.abs(prev.height) : node.y(),
    }));
  }, []);

  // Real-time update during transform (resize)
  const handleTransformInternal = useCallback((e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    const currentWidth = node.width();
    const currentHeight = node.height();

    const newWidth = Math.abs(currentWidth * scaleX);
    const newHeight = Math.abs(currentHeight * scaleY);
    const newX = node.x();
    const newY = node.y();

    // Reset scale and set actual dimensions on node
    node.scaleX(1);
    node.scaleY(1);
    node.width(newWidth);
    node.height(newHeight);

    // Update live rect to trigger blur re-render
    setLiveRect({
      x: newX,
      y: newY,
      width: newWidth,
      height: newHeight,
    });
  }, []);

  const handleTransformEndInternal = useCallback(
    (e: Konva.KonvaEventObject<Event>) => {
      onTransformEnd(e);
    },
    [onTransformEnd]
  );

  // Fast preview during drawing - just a dashed rect
  if (isActivelyDrawing) {
    return (
      <Rect
        id={shape.id}
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        fill="rgba(0, 0, 0, 0.3)"
        stroke="#fbbf24"
        strokeWidth={2}
        dash={[6, 3]}
      />
    );
  }

  // Placeholder while no image or blur completely outside bounds
  if (!sourceImage || shapeWidth < 1 || shapeHeight < 1) {
    return (
      <Rect
        ref={rectRef}
        id={shape.id}
        x={shapeX}
        y={shapeY}
        width={shapeWidth || 50}
        height={shapeHeight || 50}
        fill="rgba(128, 128, 128, 0.5)"
        stroke={isSelected ? '#fbbf24' : '#666'}
        strokeWidth={isSelected ? 2 : 1}
        dash={[4, 4]}
        draggable={isDraggable}
        onMouseDown={onSelect}
        onTouchStart={onSelect}
        onClick={onSelect}
        onTap={onSelect}
        onDragStart={onDragStart}
        onDragMove={handleDragMove}
        onDragEnd={onDragEnd}
        onTransformStart={onTransformStart}
        onTransform={handleTransformInternal}
        onTransformEnd={handleTransformEndInternal}
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
    );
  }

  // Use Group: invisible Rect at shape position for interaction,
  // blur Image at clamped position for display
  return (
    <Group>
      {/* Blur image - positioned at clamped bounds, non-interactive */}
      {blurResult && (
        <Image
          image={blurResult.canvas}
          x={blurResult.x}
          y={blurResult.y}
          width={blurResult.width}
          height={blurResult.height}
          listening={false}
        />
      )}
      {/* Invisible rect at shape's logical position - handles all interaction */}
      <Rect
        ref={rectRef}
        id={shape.id}
        x={shapeX}
        y={shapeY}
        width={shapeWidth}
        height={shapeHeight}
        fill="transparent"
        stroke={isSelected ? '#fbbf24' : 'transparent'}
        strokeWidth={isSelected ? 2 : 0}
        draggable={isDraggable}
        onMouseDown={onSelect}
        onTouchStart={onSelect}
        onClick={onSelect}
        onTap={onSelect}
        onDragStart={onDragStart}
        onDragMove={handleDragMove}
        onDragEnd={onDragEnd}
        onTransformStart={onTransformStart}
        onTransform={handleTransformInternal}
        onTransformEnd={handleTransformEndInternal}
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
    </Group>
  );
});

BlurShape.displayName = 'BlurShape';
