import { useState, useCallback } from 'react';
import Konva from 'konva';
import type { Tool, CanvasShape, BlurType } from '../types';
import { takeSnapshot, commitSnapshot, recordAction } from '../stores/editorStore';

const MIN_SHAPE_SIZE = 5;

// Tools that stay in draw mode after completing a shape
const TOOLS_RETAIN_MODE: Set<Tool> = new Set(['pen', 'steps']);

interface UseShapeDrawingProps {
  selectedTool: Tool;
  onToolChange: (tool: Tool) => void;
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  blurType: BlurType;
  blurAmount: number;
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  setSelectedIds: (ids: string[]) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
  getCanvasPosition: (screenPos: { x: number; y: number }) => { x: number; y: number };
}

interface UseShapeDrawingReturn {
  isDrawing: boolean;
  handleDrawingMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => boolean; // returns true if handled
  handleDrawingMouseMove: (pos: { x: number; y: number }) => void;
  handleDrawingMouseUp: () => void;
}

/**
 * Hook for shape drawing - handles drag-to-draw and click-to-place tools
 */
export const useShapeDrawing = ({
  selectedTool,
  onToolChange,
  strokeColor,
  fillColor,
  strokeWidth,
  blurType,
  blurAmount,
  shapes,
  onShapesChange,
  setSelectedIds,
  stageRef,
  getCanvasPosition,
}: UseShapeDrawingProps): UseShapeDrawingReturn => {
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [shapeSpawned, setShapeSpawned] = useState(false);

  // Create a new shape based on tool type
  const createShapeAtPosition = useCallback(
    (startPos: { x: number; y: number }, endPos: { x: number; y: number }): CanvasShape | null => {
      const id = `shape_${Date.now()}`;

      switch (selectedTool) {
        case 'arrow':
          return {
            id,
            type: 'arrow',
            points: [startPos.x, startPos.y, endPos.x, endPos.y],
            stroke: strokeColor,
            strokeWidth,
            fill: strokeColor,
          };
        case 'rect':
          return {
            id,
            type: 'rect',
            x: startPos.x,
            y: startPos.y,
            width: endPos.x - startPos.x,
            height: endPos.y - startPos.y,
            stroke: strokeColor,
            strokeWidth,
            fill: fillColor,
          };
        case 'circle': {
          const radiusX = Math.abs(endPos.x - startPos.x) / 2;
          const radiusY = Math.abs(endPos.y - startPos.y) / 2;
          const centerX = Math.min(startPos.x, endPos.x) + radiusX;
          const centerY = Math.min(startPos.y, endPos.y) + radiusY;
          return {
            id,
            type: 'circle',
            x: centerX,
            y: centerY,
            radiusX,
            radiusY,
            stroke: strokeColor,
            strokeWidth,
            fill: fillColor,
          };
        }
        case 'highlight': {
          // Convert strokeColor to rgba with 40% opacity
          const hexToRgba = (hex: string, alpha: number) => {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
          };
          return {
            id,
            type: 'highlight',
            x: startPos.x,
            y: startPos.y,
            width: endPos.x - startPos.x,
            height: endPos.y - startPos.y,
            fill: hexToRgba(strokeColor, 0.4),
          };
        }
        case 'blur':
          return {
            id,
            type: 'blur',
            x: startPos.x,
            y: startPos.y,
            width: endPos.x - startPos.x,
            height: endPos.y - startPos.y,
            blurType: blurType,
            blurAmount: blurAmount,
            pixelSize: blurAmount,
          };
        case 'pen':
          return {
            id,
            type: 'pen',
            points: [startPos.x, startPos.y, endPos.x, endPos.y],
            stroke: strokeColor,
            strokeWidth,
          };
        default:
          return null;
      }
    },
    [selectedTool, strokeColor, fillColor, strokeWidth, blurType, blurAmount]
  );

  // Handle mouse down for drawing
  const handleDrawingMouseDown = useCallback(
    (_e: Konva.KonvaEventObject<MouseEvent>): boolean => {
      const stage = stageRef.current;
      if (!stage) return false;

      const screenPos = stage.getPointerPosition();
      if (!screenPos) return false;

      const pos = getCanvasPosition(screenPos);

      // Select tool doesn't draw
      if (selectedTool === 'select') return false;

      // Click-to-place tools (text, steps)
      if (selectedTool === 'text') {
        const id = `shape_${Date.now()}`;
        const newShape: CanvasShape = {
          id,
          type: 'text',
          x: pos.x,
          y: pos.y,
          text: 'Double-click to edit',
          fontSize: 16,
          fill: strokeColor,
        };
        recordAction(() => onShapesChange([...shapes, newShape]));
        setSelectedIds([id]);
        onToolChange('select');
        return true;
      }

      if (selectedTool === 'steps') {
        // Find the next available step number (fill gaps first, then continue series)
        const existingNumbers = shapes
          .filter((s) => s.type === 'step' && s.number !== undefined)
          .map((s) => s.number as number)
          .sort((a, b) => a - b);

        let nextNumber = 1;
        for (const num of existingNumbers) {
          if (num === nextNumber) {
            nextNumber++;
          } else if (num > nextNumber) {
            break; // Found a gap
          }
        }

        const id = `shape_${Date.now()}`;
        const newShape: CanvasShape = {
          id,
          type: 'step',
          x: pos.x,
          y: pos.y,
          number: nextNumber,
          fill: strokeColor,
          radius: 15,
        };
        recordAction(() => onShapesChange([...shapes, newShape]));
        setSelectedIds([id]);
        // Don't switch to select - steps tool retains mode
        return true;
      }

      // Crop tool is handled elsewhere
      if (selectedTool === 'crop') return false;

      // For drag-to-draw tools, snapshot before drawing starts
      takeSnapshot();
      setIsDrawing(true);
      setDrawStart(pos);
      setShapeSpawned(false);
      return true;
    },
    [
      selectedTool,
      strokeColor,
      shapes,
      onShapesChange,
      onToolChange,
      stageRef,
      getCanvasPosition,
      setSelectedIds,
    ]
  );

  // Handle mouse move during drawing
  const handleDrawingMouseMove = useCallback(
    (pos: { x: number; y: number }) => {
      if (!isDrawing) return;

      // Calculate distance from start
      const distance = Math.sqrt(
        Math.pow(pos.x - drawStart.x, 2) + Math.pow(pos.y - drawStart.y, 2)
      );

      // If shape not spawned yet, check threshold
      if (!shapeSpawned) {
        if (distance < MIN_SHAPE_SIZE) {
          return;
        }
        // Spawn the shape
        const newShape = createShapeAtPosition(drawStart, pos);
        if (newShape) {
          onShapesChange([...shapes, newShape]);
          setSelectedIds([newShape.id]);
          setShapeSpawned(true);
        }
        return;
      }

      // Update existing shape
      const lastShape = shapes[shapes.length - 1];
      if (!lastShape) return;

      const updatedShapes = [...shapes];
      const shapeIndex = updatedShapes.length - 1;

      switch (lastShape.type) {
        case 'arrow':
          updatedShapes[shapeIndex] = {
            ...lastShape,
            points: [drawStart.x, drawStart.y, pos.x, pos.y],
          };
          break;
        case 'rect':
        case 'highlight':
        case 'blur':
          updatedShapes[shapeIndex] = {
            ...lastShape,
            width: pos.x - drawStart.x,
            height: pos.y - drawStart.y,
          };
          break;
        case 'circle': {
          const radiusX = Math.abs(pos.x - drawStart.x) / 2;
          const radiusY = Math.abs(pos.y - drawStart.y) / 2;
          const centerX = Math.min(drawStart.x, pos.x) + radiusX;
          const centerY = Math.min(drawStart.y, pos.y) + radiusY;
          updatedShapes[shapeIndex] = {
            ...lastShape,
            x: centerX,
            y: centerY,
            radiusX,
            radiusY,
          };
          break;
        }
        case 'pen': {
          const existingPoints = lastShape.points || [];
          updatedShapes[shapeIndex] = {
            ...lastShape,
            points: [...existingPoints, pos.x, pos.y],
          };
          break;
        }
      }

      onShapesChange(updatedShapes);
    },
    [isDrawing, shapeSpawned, shapes, drawStart, onShapesChange, createShapeAtPosition, setSelectedIds]
  );

  // Handle mouse up - finalize drawing
  const handleDrawingMouseUp = useCallback(() => {
    if (!isDrawing) return;

    if (shapeSpawned) {
      commitSnapshot();
      // Switch to select mode unless tool retains mode
      if (!TOOLS_RETAIN_MODE.has(selectedTool)) {
        onToolChange('select');
      }
    }

    setIsDrawing(false);
    setShapeSpawned(false);
  }, [isDrawing, shapeSpawned, selectedTool, onToolChange]);

  return {
    isDrawing,
    handleDrawingMouseDown,
    handleDrawingMouseMove,
    handleDrawingMouseUp,
  };
};
