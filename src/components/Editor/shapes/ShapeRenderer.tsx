import React from 'react';
import Konva from 'konva';
import type { CanvasShape } from '../../../types';
import { RectShape } from './RectShape';
import { CircleShape } from './CircleShape';
import { HighlightShape } from './HighlightShape';
import { PenShape } from './PenShape';
import { TextShape } from './TextShape';
import { StepShape } from './StepShape';
import { ArrowShape } from './ArrowShape';
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
 * ShapeRenderer - dispatches rendering to appropriate shape component
 */
export const ShapeRenderer: React.FC<ShapeRendererProps> = ({
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

  return (
    <>
      {shapes.map((shape) => {
        const isSelected = selectedIds.includes(shape.id);
        const isActivelyDrawing = isDrawing && shapes[shapes.length - 1]?.id === shape.id;

        // Common props for all shapes
        const commonProps = {
          shape,
          isSelected,
          isDraggable,
          onSelect: (e?: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
            // Block selection while panning or on middle mouse button
            if (isPanning) return;
            const evt = e?.evt as MouseEvent | undefined;
            if (evt?.button === 1) return;
            onShapeSelect(shape.id);
          },
          onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
            if (isPanning) return;
            onShapeClick(shape.id, e);
          },
          onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => {
            if (isPanning) return;
            onDragStart(shape.id, e);
          },
          onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onDragEnd(shape.id, e),
          onTransformStart,
          onTransformEnd: (e: Konva.KonvaEventObject<Event>) => onTransformEnd(shape.id, e),
        };

        switch (shape.type) {
          case 'arrow':
            return (
              <ArrowShape
                key={shape.id}
                {...commonProps}
                zoom={zoom}
                onDragEnd={(_e, newPoints) => onArrowDragEnd(shape.id, newPoints)}
                onEndpointDragEnd={(_, newPoints) =>
                  onArrowEndpointDragEnd(shape.id, newPoints)
                }
              />
            );
          case 'rect':
            return <RectShape key={shape.id} {...commonProps} />;
          case 'circle':
            return <CircleShape key={shape.id} {...commonProps} />;
          case 'highlight':
            return <HighlightShape key={shape.id} {...commonProps} />;
          case 'blur':
            return (
              <BlurShape
                key={shape.id}
                shape={shape}
                sourceImage={sourceImage}
                isSelected={isSelected}
                isDraggable={isDraggable}
                isActivelyDrawing={isActivelyDrawing}
                onSelect={commonProps.onSelect}
                onDragStart={(e) => onDragStart(shape.id, e)}
                onDragEnd={(e) => onDragEnd(shape.id, e)}
                onTransformStart={onTransformStart}
                onTransformEnd={(e) => onTransformEnd(shape.id, e)}
              />
            );
          case 'text':
            return (
              <TextShape
                key={shape.id}
                {...commonProps}
                isEditing={editingTextId === shape.id}
                onStartEdit={() => onTextStartEdit(shape.id, shape.text || '')}
              />
            );
          case 'step':
            return <StepShape key={shape.id} {...commonProps} />;
          case 'pen':
            return <PenShape key={shape.id} {...commonProps} />;
          default:
            return null;
        }
      })}
    </>
  );
};
