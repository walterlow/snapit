import { useState, useCallback, useRef } from 'react';
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
  fontSize: number;
  blurType: BlurType;
  blurAmount: number;
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  setSelectedIds: (ids: string[]) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
  getCanvasPosition: (screenPos: { x: number; y: number }) => { x: number; y: number };
  onTextShapeCreated?: (shapeId: string) => void;
}

interface UseShapeDrawingReturn {
  isDrawing: boolean;
  handleDrawingMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => boolean; // returns true if handled
  handleDrawingMouseMove: (pos: { x: number; y: number }) => void;
  handleDrawingMouseUp: () => void;
}

/**
 * Hook for shape drawing - handles drag-to-draw and click-to-place tools
 * Uses refs for live drawing to avoid re-renders on every mouse move
 */
export const useShapeDrawing = ({
  selectedTool,
  onToolChange,
  strokeColor,
  fillColor,
  strokeWidth,
  fontSize,
  blurType,
  blurAmount,
  shapes,
  onShapesChange,
  setSelectedIds,
  stageRef,
  getCanvasPosition,
  onTextShapeCreated,
}: UseShapeDrawingProps): UseShapeDrawingReturn => {
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [shapeSpawned, setShapeSpawned] = useState(false);

  // Refs for live drawing without re-renders
  const liveShapeRef = useRef<CanvasShape | null>(null);
  const shapesBeforeDrawRef = useRef<CanvasShape[]>([]);

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
        case 'text': {
          const width = Math.max(50, Math.abs(endPos.x - startPos.x));
          const height = Math.max(fontSize * 1.5, Math.abs(endPos.y - startPos.y));
          return {
            id,
            type: 'text',
            x: Math.min(startPos.x, endPos.x),
            y: Math.min(startPos.y, endPos.y),
            width,
            height,
            text: '',
            fontSize,
            fontFamily: 'Arial',
            fontStyle: 'normal',
            textDecoration: '',
            align: 'left',
            wrap: 'word',
            fill: fillColor,
            stroke: strokeColor,
            strokeWidth,
          };
        }
        default:
          return null;
      }
    },
    [selectedTool, strokeColor, fillColor, strokeWidth, fontSize, blurType, blurAmount]
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

      // Click-to-place tools (steps only - text is now drag-to-draw)
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
      shapesBeforeDrawRef.current = shapes;
      liveShapeRef.current = null;
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

  // Handle mouse move during drawing - uses Konva directly to avoid React re-renders
  const handleDrawingMouseMove = useCallback(
    (pos: { x: number; y: number }) => {
      if (!isDrawing) return;

      const stage = stageRef.current;
      if (!stage) return;

      // Calculate distance from start
      const distance = Math.sqrt(
        Math.pow(pos.x - drawStart.x, 2) + Math.pow(pos.y - drawStart.y, 2)
      );

      // If shape not spawned yet, check threshold
      if (!shapeSpawned) {
        if (distance < MIN_SHAPE_SIZE) {
          return;
        }
        // Spawn the shape - this requires a React state update
        const newShape = createShapeAtPosition(drawStart, pos);
        if (newShape) {
          liveShapeRef.current = newShape;
          onShapesChange([...shapesBeforeDrawRef.current, newShape]);
          setSelectedIds([newShape.id]);
          setShapeSpawned(true);
        }
        return;
      }

      // Update existing shape via Konva directly (no React re-render)
      const liveShape = liveShapeRef.current;
      if (!liveShape) return;

      const node = stage.findOne(`#${liveShape.id}`);
      if (!node) return;

      switch (liveShape.type) {
        case 'arrow': {
          const line = node as Konva.Arrow;
          const newPoints = [drawStart.x, drawStart.y, pos.x, pos.y];
          line.points(newPoints);
          liveShapeRef.current = { ...liveShape, points: newPoints };
          break;
        }
        case 'rect':
        case 'highlight':
        case 'blur': {
          const rect = node as Konva.Rect;
          const width = pos.x - drawStart.x;
          const height = pos.y - drawStart.y;
          rect.width(width);
          rect.height(height);
          liveShapeRef.current = { ...liveShape, width, height };
          break;
        }
        case 'circle': {
          const ellipse = node as Konva.Ellipse;
          const radiusX = Math.abs(pos.x - drawStart.x) / 2;
          const radiusY = Math.abs(pos.y - drawStart.y) / 2;
          const centerX = Math.min(drawStart.x, pos.x) + radiusX;
          const centerY = Math.min(drawStart.y, pos.y) + radiusY;
          ellipse.x(centerX);
          ellipse.y(centerY);
          ellipse.radiusX(radiusX);
          ellipse.radiusY(radiusY);
          liveShapeRef.current = { ...liveShape, x: centerX, y: centerY, radiusX, radiusY };
          break;
        }
        case 'pen': {
          const line = node as Konva.Line;
          const existingPoints = liveShape.points || [];
          const newPoints = [...existingPoints, pos.x, pos.y];
          line.points(newPoints);
          liveShapeRef.current = { ...liveShape, points: newPoints };
          break;
        }
        case 'text': {
          // Text uses a Group containing Rect + Text, find the Rect to resize
          const group = node as Konva.Group;
          const rect = group.findOne('.text-box-border') as Konva.Rect;
          const textNode = group.findOne('.text-content') as Konva.Text;
          const width = Math.max(50, Math.abs(pos.x - drawStart.x));
          const height = Math.max(fontSize * 1.5, Math.abs(pos.y - drawStart.y));
          const x = Math.min(drawStart.x, pos.x);
          const y = Math.min(drawStart.y, pos.y);
          group.x(x);
          group.y(y);
          if (rect) {
            rect.width(width);
            rect.height(height);
          }
          if (textNode) {
            textNode.width(width);
            textNode.height(height);
          }
          liveShapeRef.current = { ...liveShape, x, y, width, height };
          break;
        }
      }

      // Trigger Konva layer redraw (much faster than React re-render)
      node.getLayer()?.batchDraw();
    },
    [isDrawing, shapeSpawned, drawStart, fontSize, createShapeAtPosition, setSelectedIds, stageRef, onShapesChange]
  );

  // Handle mouse up - finalize drawing and sync React state
  const handleDrawingMouseUp = useCallback(() => {
    if (!isDrawing) return;

    if (shapeSpawned && liveShapeRef.current) {
      // Commit final shape to React state
      const finalShape = liveShapeRef.current;
      onShapesChange([...shapesBeforeDrawRef.current, finalShape]);
      commitSnapshot();
      // Switch to select mode unless tool retains mode
      if (!TOOLS_RETAIN_MODE.has(selectedTool)) {
        onToolChange('select');
      }
      // If text shape was created, trigger editor to open immediately
      if (finalShape.type === 'text' && onTextShapeCreated) {
        onTextShapeCreated(finalShape.id);
      }
    }

    // Clean up refs
    liveShapeRef.current = null;
    shapesBeforeDrawRef.current = [];
    setIsDrawing(false);
    setShapeSpawned(false);
  }, [isDrawing, shapeSpawned, selectedTool, onToolChange, onShapesChange, onTextShapeCreated]);

  return {
    isDrawing,
    handleDrawingMouseDown,
    handleDrawingMouseMove,
    handleDrawingMouseUp,
  };
};
