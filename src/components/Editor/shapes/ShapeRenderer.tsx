import React, { useMemo, useCallback } from 'react';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { RectShape } from './RectShape';
import { CircleShape } from './CircleShape';
import { HighlightShape } from './HighlightShape';
import { PenShape } from './PenShape';
import { TextShape } from './TextShape';
import { StepShape } from './StepShape';
import { ArrowShape } from './ArrowShape';
import { LineShape } from './LineShape';
import { BlurShape } from './BlurShape';

interface ShapeRendererProps {
  shapes: CanvasShape[];
  selectedIds: string[];
  selectedTool: string;
  zoom: number;
  sourceImage: HTMLImageElement | undefined;
  isDrawing: boolean;
  isPanning: boolean;
  editingTextId: string | null;
  onShapeClick: (shapeId: string, e: Konva.KonvaEventObject<MouseEvent>) => void;
  onShapeSelect: (shapeId: string) => void;
  onDragStart: (shapeId: string, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (shapeId: string, e: Konva.KonvaEventObject<DragEvent>) => void;
  onArrowDragEnd: (shapeId: string, newPoints: number[]) => void;
  onTransformStart: () => void;
  onTransformEnd: (shapeId: string, e: Konva.KonvaEventObject<Event>) => void;
  onArrowEndpointDragEnd: (shapeId: string, newPoints: number[]) => void;
  onTextStartEdit: (shapeId: string, currentText: string) => void;
}

/**
 * Individual shape wrapper - memoized to prevent re-renders when other shapes change
 */
const MemoizedShape = React.memo<{
  shape: CanvasShape;
  isSelected: boolean;
  isDraggable: boolean;
  isPanning: boolean;
  isDrawing: boolean;
  isLastShape: boolean;
  zoom: number;
  sourceImage: HTMLImageElement | undefined;
  editingTextId: string | null;
  onShapeClick: (shapeId: string, e: Konva.KonvaEventObject<MouseEvent>) => void;
  onShapeSelect: (shapeId: string) => void;
  onDragStart: (shapeId: string, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (shapeId: string, e: Konva.KonvaEventObject<DragEvent>) => void;
  onArrowDragEnd: (shapeId: string, newPoints: number[]) => void;
  onTransformStart: () => void;
  onTransformEnd: (shapeId: string, e: Konva.KonvaEventObject<Event>) => void;
  onArrowEndpointDragEnd: (shapeId: string, newPoints: number[]) => void;
  onTextStartEdit: (shapeId: string, currentText: string) => void;
}>(({
  shape,
  isSelected,
  isDraggable,
  isPanning,
  isDrawing,
  isLastShape,
  zoom,
  sourceImage,
  editingTextId,
  onShapeClick,
  onShapeSelect,
  onDragStart,
  onDragEnd,
  onArrowDragEnd,
  onTransformStart,
  onTransformEnd,
  onArrowEndpointDragEnd,
  onTextStartEdit,
}) => {
  const isActivelyDrawing = isDrawing && isLastShape;

  // Stable callbacks that reference shape.id
  const handleSelect = useCallback((e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (isPanning) return;
    const evt = e?.evt as MouseEvent | undefined;
    if (evt?.button === 1) return;
    onShapeSelect(shape.id);
  }, [isPanning, onShapeSelect, shape.id]);

  const handleClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isPanning) return;
    onShapeClick(shape.id, e);
  }, [isPanning, onShapeClick, shape.id]);

  const handleDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (isPanning) return;
    onDragStart(shape.id, e);
  }, [isPanning, onDragStart, shape.id]);

  const handleDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    onDragEnd(shape.id, e);
  }, [onDragEnd, shape.id]);

  const handleTransformEnd = useCallback((e: Konva.KonvaEventObject<Event>) => {
    onTransformEnd(shape.id, e);
  }, [onTransformEnd, shape.id]);

  const handleArrowDragEnd = useCallback((_e: unknown, newPoints: number[]) => {
    onArrowDragEnd(shape.id, newPoints);
  }, [onArrowDragEnd, shape.id]);

  const handleArrowEndpointDragEnd = useCallback((_: unknown, newPoints: number[]) => {
    onArrowEndpointDragEnd(shape.id, newPoints);
  }, [onArrowEndpointDragEnd, shape.id]);

  const handleTextStartEdit = useCallback(() => {
    onTextStartEdit(shape.id, shape.text || '');
  }, [onTextStartEdit, shape.id, shape.text]);

  const commonProps = {
    shape,
    isSelected,
    isDraggable,
    onSelect: handleSelect,
    onClick: handleClick,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    onTransformStart,
    onTransformEnd: handleTransformEnd,
  };

  switch (shape.type) {
    case 'arrow':
      return (
        <ArrowShape
          {...commonProps}
          zoom={zoom}
          onDragEnd={handleArrowDragEnd}
          onEndpointDragEnd={handleArrowEndpointDragEnd}
        />
      );
    case 'line':
      return (
        <LineShape
          {...commonProps}
          zoom={zoom}
          onDragEnd={handleArrowDragEnd}
          onEndpointDragEnd={handleArrowEndpointDragEnd}
        />
      );
    case 'rect':
      return <RectShape {...commonProps} />;
    case 'circle':
      return <CircleShape {...commonProps} />;
    case 'highlight':
      return <HighlightShape {...commonProps} />;
    case 'blur':
      return (
        <BlurShape
          shape={shape}
          sourceImage={sourceImage}
          isSelected={isSelected}
          isDraggable={isDraggable}
          isActivelyDrawing={isActivelyDrawing}
          onSelect={handleSelect}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onTransformStart={onTransformStart}
          onTransformEnd={handleTransformEnd}
        />
      );
    case 'text':
      return (
        <TextShape
          {...commonProps}
          isEditing={editingTextId === shape.id}
          zoom={zoom}
          onStartEdit={handleTextStartEdit}
        />
      );
    case 'step':
      return <StepShape {...commonProps} />;
    case 'pen':
      return <PenShape {...commonProps} />;
    default:
      return null;
  }
});

MemoizedShape.displayName = 'MemoizedShape';

/**
 * ShapeRenderer - dispatches rendering to appropriate shape component
 * Uses memoization to prevent re-renders when unrelated state changes
 */
export const ShapeRenderer: React.FC<ShapeRendererProps> = React.memo(({
  shapes,
  selectedIds,
  selectedTool,
  zoom,
  sourceImage,
  isDrawing,
  isPanning,
  editingTextId,
  onShapeClick,
  onShapeSelect,
  onDragStart,
  onDragEnd,
  onArrowDragEnd,
  onTransformStart,
  onTransformEnd,
  onArrowEndpointDragEnd,
  onTextStartEdit,
}) => {
  const isDraggable = selectedTool === 'select' && !isPanning;

  // Memoize the selected set for O(1) lookup
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const lastShapeId = shapes[shapes.length - 1]?.id;

  return (
    <>
      {shapes.map((shape) => (
        <MemoizedShape
          key={shape.id}
          shape={shape}
          isSelected={selectedSet.has(shape.id)}
          isDraggable={isDraggable}
          isPanning={isPanning}
          isDrawing={isDrawing}
          isLastShape={shape.id === lastShapeId}
          zoom={zoom}
          sourceImage={sourceImage}
          editingTextId={editingTextId}
          onShapeClick={onShapeClick}
          onShapeSelect={onShapeSelect}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onArrowDragEnd={onArrowDragEnd}
          onTransformStart={onTransformStart}
          onTransformEnd={onTransformEnd}
          onArrowEndpointDragEnd={onArrowEndpointDragEnd}
          onTextStartEdit={onTextStartEdit}
        />
      ))}
    </>
  );
});
