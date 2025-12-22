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
  onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

/**
 * BlurShape component - renders blur/pixelate effect
 * Uses refs for drag/transform tracking to avoid re-renders during interaction
 * Only re-renders blur on interaction END for performance
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
  const imageRef = useRef<Konva.Image>(null);
  const groupRef = useRef<Konva.Group>(null);
  const [blurResult, setBlurResult] = useState<BlurRenderResult | null>(null);

  // Use refs for live tracking during drag/transform (no re-renders)
  const isDraggingRef = useRef(false);
  const isTransformingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const blurType = shape.blurType || 'pixelate';
  const blurAmount = shape.blurAmount || shape.pixelSize || 10;

  // Normalized values for the shape bounds (handle negative dimensions)
  const shapeX = (shape.width || 0) < 0 ? (shape.x || 0) + (shape.width || 0) : (shape.x || 0);
  const shapeY = (shape.height || 0) < 0 ? (shape.y || 0) + (shape.height || 0) : (shape.y || 0);
  const shapeWidth = Math.abs(shape.width || 0);
  const shapeHeight = Math.abs(shape.height || 0);

  // Render blur only when shape dimensions/position change from props (not during drag)
  useEffect(() => {
    if (!sourceImage || shapeWidth < 1 || shapeHeight < 1) {
      setBlurResult(null);
      return;
    }
    // Don't re-render blur during active drag/transform - we'll do it on end
    if (isDraggingRef.current || isTransformingRef.current) return;

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

  // Handle drag start - store initial offset between blur image and rect
  const handleDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    isDraggingRef.current = true;
    // Store offset from rect to blur image for coordinated movement
    if (blurResult && imageRef.current) {
      dragOffsetRef.current = {
        x: blurResult.x - shapeX,
        y: blurResult.y - shapeY,
      };
    }
    onDragStart(e);
  }, [onDragStart, blurResult, shapeX, shapeY]);

  // Move blur image along with rect during drag (no React state, pure Konva)
  const handleDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (!imageRef.current || !blurResult) return;

    const node = e.target;
    const newX = node.x();
    const newY = node.y();

    // Move the blur image to match the rect position
    imageRef.current.x(newX + dragOffsetRef.current.x);
    imageRef.current.y(newY + dragOffsetRef.current.y);
  }, [blurResult]);

  // Handle drag end - trigger blur re-render at new position
  const handleDragEndInternal = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    isDraggingRef.current = false;
    // The parent will update shape props, which triggers blur re-render via useEffect
    onDragEnd(e);
  }, [onDragEnd]);

  // Handle transform (resize) - update node dimensions but defer blur re-render
  const handleTransformInternal = useCallback((e: Konva.KonvaEventObject<Event>) => {
    isTransformingRef.current = true;
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    const currentWidth = node.width();
    const currentHeight = node.height();

    const newWidth = Math.abs(currentWidth * scaleX);
    const newHeight = Math.abs(currentHeight * scaleY);

    // Reset scale and set actual dimensions on node (Konva only, no React state)
    node.scaleX(1);
    node.scaleY(1);
    node.width(newWidth);
    node.height(newHeight);
  }, []);

  // Handle transform end - trigger blur re-render
  const handleTransformEndInternal = useCallback(
    (e: Konva.KonvaEventObject<Event>) => {
      isTransformingRef.current = false;
      // The parent will update shape props, which triggers blur re-render via useEffect
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
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEndInternal}
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
        stroke={isSelected ? '#fbbf24' : 'transparent'}
        strokeWidth={isSelected ? 2 : 0}
        draggable={isDraggable}
        onMouseDown={onSelect}
        onTouchStart={onSelect}
        onClick={onSelect}
        onTap={onSelect}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEndInternal}
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
