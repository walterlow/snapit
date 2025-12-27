import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Group, Image, Rect } from 'react-konva';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { renderBlurCanvas, BlurRenderResult } from '../../../utils/blurRenderer';
import { useShapeCursor } from '../../../hooks/useShapeCursor';

interface BlurShapeProps {
  shape: CanvasShape;
  sourceImage: HTMLImageElement | undefined;
  isSelected: boolean;
  isDraggable: boolean;
  isActivelyDrawing: boolean;
  onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

/**
 * BlurShape component - renders blur/pixelate effect with LIVE preview
 * Re-renders blur in real-time during drag and resize for accurate preview
 */
export const BlurShape: React.FC<BlurShapeProps> = React.memo(({
  shape,
  sourceImage,
  isSelected: _isSelected,
  isDraggable,
  isActivelyDrawing,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
}) => {
  void _isSelected; // Blur shapes don't show selection border
  const cursorHandlers = useShapeCursor(isDraggable);
  const rectRef = useRef<Konva.Rect>(null);
  const imageRef = useRef<Konva.Image>(null);
  const groupRef = useRef<Konva.Group>(null);
  const [blurResult, setBlurResult] = useState<BlurRenderResult | null>(null);

  // Live position/size refs for real-time blur updates
  const liveXRef = useRef(0);
  const liveYRef = useRef(0);
  const liveWidthRef = useRef(0);
  const liveHeightRef = useRef(0);

  const blurType = shape.blurType || 'pixelate';
  const blurAmount = shape.blurAmount || shape.pixelSize || 15;

  // Normalized values for the shape bounds (handle negative dimensions)
  const shapeX = (shape.width || 0) < 0 ? (shape.x || 0) + (shape.width || 0) : (shape.x || 0);
  const shapeY = (shape.height || 0) < 0 ? (shape.y || 0) + (shape.height || 0) : (shape.y || 0);
  const shapeWidth = Math.abs(shape.width || 0);
  const shapeHeight = Math.abs(shape.height || 0);

  // Keep live refs in sync with props
  useEffect(() => {
    liveXRef.current = shapeX;
    liveYRef.current = shapeY;
    liveWidthRef.current = shapeWidth;
    liveHeightRef.current = shapeHeight;
  }, [shapeX, shapeY, shapeWidth, shapeHeight]);

  // Helper to render blur and update Konva image directly (no React state during interaction)
  const renderBlurLive = useCallback((x: number, y: number, width: number, height: number) => {
    if (!sourceImage || width < 1 || height < 1 || !imageRef.current) return;

    const result = renderBlurCanvas(sourceImage, x, y, width, height, blurType, blurAmount);
    if (!result) return;

    // Update Konva image directly for performance
    imageRef.current.image(result.canvas);
    imageRef.current.x(result.x);
    imageRef.current.y(result.y);
    imageRef.current.width(result.width);
    imageRef.current.height(result.height);
    imageRef.current.getLayer()?.batchDraw();
  }, [sourceImage, blurType, blurAmount]);

  // Initial blur render from props
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

  // Handle drag start
  const handleDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    onDragStart(e);
  }, [onDragStart]);

  // Live blur update during drag
  const handleDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const newX = node.x();
    const newY = node.y();

    // Re-render blur at new position
    renderBlurLive(newX, newY, liveWidthRef.current, liveHeightRef.current);
  }, [renderBlurLive]);

  // Handle drag end
  const handleDragEndInternal = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    onDragEnd(e);
  }, [onDragEnd]);

  // Handle transform start
  const handleTransformStartInternal = useCallback(() => {
    onTransformStart();
  }, [onTransformStart]);

  // Live blur update during resize
  const handleTransformInternal = useCallback((e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    const newWidth = Math.abs(node.width() * scaleX);
    const newHeight = Math.abs(node.height() * scaleY);
    const newX = node.x();
    const newY = node.y();

    // Reset scale and set actual dimensions
    node.scaleX(1);
    node.scaleY(1);
    node.width(newWidth);
    node.height(newHeight);

    // Update live refs
    liveWidthRef.current = newWidth;
    liveHeightRef.current = newHeight;

    // Re-render blur at new size
    renderBlurLive(newX, newY, newWidth, newHeight);
  }, [renderBlurLive]);

  // Handle transform end
  const handleTransformEndInternal = useCallback(
    (e: Konva.KonvaEventObject<Event>) => {
      onTransformEnd(e);
    },
    [onTransformEnd]
  );

  // Live blur preview during drawing - with visible border
  if (isActivelyDrawing && sourceImage && shapeWidth >= 1 && shapeHeight >= 1) {
    const drawingBlur = renderBlurCanvas(
      sourceImage,
      shapeX,
      shapeY,
      shapeWidth,
      shapeHeight,
      blurType,
      blurAmount
    );

    if (drawingBlur) {
      return (
        <Group>
          <Image
            id={shape.id}
            image={drawingBlur.canvas}
            x={drawingBlur.x}
            y={drawingBlur.y}
            width={drawingBlur.width}
            height={drawingBlur.height}
            listening={false}
          />
          {/* Border while drawing */}
          <Rect
            x={shapeX}
            y={shapeY}
            width={shapeWidth}
            height={shapeHeight}
            stroke="#fbbf24"
            strokeWidth={2}
            dash={[6, 3]}
            listening={false}
          />
        </Group>
      );
    }
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
        stroke="#666"
        strokeWidth={1}
        dash={[4, 4]}
        draggable={isDraggable}
        onMouseDown={onSelect}
        onTouchStart={onSelect}
        onClick={onSelect}
        onTap={onSelect}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEndInternal}
        onTransformStart={handleTransformStartInternal}
        onTransform={handleTransformInternal}
        onTransformEnd={handleTransformEndInternal}
        {...cursorHandlers}
      />
    );
  }

  // Use Group: invisible Rect at shape position for interaction,
  // blur Image at clamped position for display
  return (
    <Group ref={groupRef}>
      {/* Blur image - positioned at clamped bounds, non-interactive */}
      {blurResult && (
        <Image
          ref={imageRef}
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
        stroke="transparent"
        strokeWidth={0}
        draggable={isDraggable}
        onMouseDown={onSelect}
        onTouchStart={onSelect}
        onClick={onSelect}
        onTap={onSelect}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEndInternal}
        onTransformStart={handleTransformStartInternal}
        onTransform={handleTransformInternal}
        onTransformEnd={handleTransformEndInternal}
        {...cursorHandlers}
      />
    </Group>
  );
});

BlurShape.displayName = 'BlurShape';
