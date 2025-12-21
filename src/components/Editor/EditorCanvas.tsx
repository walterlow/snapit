import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import {
  Stage,
  Layer,
  Image,
  Rect,
  Arrow,
  Circle,
  Ellipse,
  Text,
  Group,
  Transformer,
  Line,
} from 'react-konva';
import Konva from 'konva';
import useImage from 'use-image';
import { ZoomIn, ZoomOut, Maximize2, Square, Check, X } from 'lucide-react';
import type { Tool, CanvasShape } from '../../types';
import { useEditorStore, takeSnapshot, commitSnapshot, recordAction } from '../../stores/editorStore';
import { CompositorBackground } from './CompositorBackground';

// Pre-rendered blur region with real-time updates during drag/resize
// GPU-accelerated via native canvas filter
interface BlurRegionProps {
  shape: CanvasShape;
  sourceImage: HTMLImageElement | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onDragStart?: () => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformStart?: () => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
  draggable: boolean;
}

// Result from blur rendering - includes actual bounds for proper positioning
interface BlurRenderResult {
  canvas: HTMLCanvasElement;
  x: number;      // Actual x position (clamped to image bounds)
  y: number;      // Actual y position (clamped to image bounds)
  width: number;  // Actual width (may be smaller if clipped)
  height: number; // Actual height (may be smaller if clipped)
}

// Renders blur effect to an offscreen canvas
// Returns the canvas AND the actual bounds (clamped to image) for correct positioning
const renderBlurCanvas = (
  sourceImage: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  blurType: string,
  blurAmount: number
): BlurRenderResult | null => {
  // Handle negative dimensions (drawing right-to-left or bottom-to-top)
  const absWidth = Math.abs(width);
  const absHeight = Math.abs(height);
  
  if (absWidth < 1 || absHeight < 1) return null;

  // Normalize position for negative dimensions
  const normalizedX = width < 0 ? x + width : x;
  const normalizedY = height < 0 ? y + height : y;

  // Calculate the intersection with image bounds
  const imgW = sourceImage.width;
  const imgH = sourceImage.height;
  
  // Clamp to image bounds
  const clampedX = Math.max(0, normalizedX);
  const clampedY = Math.max(0, normalizedY);
  const clampedRight = Math.min(imgW, normalizedX + absWidth);
  const clampedBottom = Math.min(imgH, normalizedY + absHeight);
  
  // Actual dimensions after clamping
  const actualW = clampedRight - clampedX;
  const actualH = clampedBottom - clampedY;
  
  // If completely outside image bounds, return null
  if (actualW < 1 || actualH < 1) return null;

  const canvas = document.createElement('canvas');
  canvas.width = actualW;
  canvas.height = actualH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (blurType === 'pixelate') {
    // Fast pixelation: downscale then upscale with nearest-neighbor
    const pixelSize = Math.max(2, blurAmount);
    const smallW = Math.max(1, Math.ceil(actualW / pixelSize));
    const smallH = Math.max(1, Math.ceil(actualH / pixelSize));
    
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sourceImage, clampedX, clampedY, actualW, actualH, 0, 0, smallW, smallH);
    
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, smallW, smallH, 0, 0, actualW, actualH);
  } else {
    // GPU-accelerated blur via native canvas filter
    ctx.filter = `blur(${blurAmount}px)`;
    const padding = blurAmount * 2;
    ctx.drawImage(
      sourceImage,
      clampedX - padding, clampedY - padding, actualW + padding * 2, actualH + padding * 2,
      -padding, -padding, actualW + padding * 2, actualH + padding * 2
    );
    ctx.filter = 'none';
  }

  return {
    canvas,
    x: clampedX,
    y: clampedY,
    width: actualW,
    height: actualH
  };
};

const BlurRegion: React.FC<BlurRegionProps> = ({
  shape,
  sourceImage,
  isSelected,
  onSelect,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
  draggable,
}) => {
  const rectRef = useRef<Konva.Rect>(null);
  const [blurResult, setBlurResult] = useState<BlurRenderResult | null>(null);
  
  // Track the shape's logical bounds (may extend outside image)
  const [liveRect, setLiveRect] = useState({ 
    x: shape.x || 0, 
    y: shape.y || 0,
    width: shape.width || 0, 
    height: shape.height || 0 
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
      height: shape.height || 0 
    });
  }, [shape.x, shape.y, shape.width, shape.height]);

  // Render blur whenever position/size changes
  // Result includes clamped bounds for correct positioning within image
  useEffect(() => {
    if (!sourceImage || shapeWidth < 1 || shapeHeight < 1) {
      setBlurResult(null);
      return;
    }
    const result = renderBlurCanvas(
      sourceImage, shapeX, shapeY, 
      shapeWidth, shapeHeight, 
      blurType, blurAmount
    );
    setBlurResult(result);
  }, [sourceImage, shapeX, shapeY, shapeWidth, shapeHeight, blurType, blurAmount]);

  // Real-time update during drag - track delta, apply to logical position
  const handleDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    // Node position IS the shape's logical position (Rect is at shapeX/shapeY)
    setLiveRect(prev => ({ 
      ...prev, 
      x: prev.width < 0 ? node.x() + Math.abs(prev.width) : node.x(),
      y: prev.height < 0 ? node.y() + Math.abs(prev.height) : node.y()
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
      height: newHeight
    });
  }, []);

  const handleTransformEndInternal = useCallback((e: Konva.KonvaEventObject<Event>) => {
    onTransformEnd(e);
  }, [onTransformEnd]);

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
        draggable={draggable}
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
        draggable={draggable}
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
      />
    </Group>
  );
};

interface EditorCanvasProps {
  imageData: string;
  selectedTool: Tool;
  onToolChange: (tool: Tool) => void;
  strokeColor: string;
  strokeWidth: number;
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;
const MIN_SHAPE_SIZE = 5; // Minimum size to create a shape

// Tools that stay in draw mode after completing a shape (don't auto-switch to select)
const TOOLS_RETAIN_MODE: Set<Tool> = new Set(['pen']);

export const EditorCanvas: React.FC<EditorCanvasProps> = ({
  imageData,
  selectedTool,
  onToolChange,
  strokeColor,
  strokeWidth,
  shapes,
  onShapesChange,
  stageRef,
}) => {
  const [stepCount, setStepCount] = useState(1);
  const layerRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Get state from store
  const selectedIds = useEditorStore((state) => state.selectedIds);
  const setSelectedIds = useEditorStore((state) => state.setSelectedIds);
  const compositorSettings = useEditorStore((state) => state.compositorSettings);
  const blurType = useEditorStore((state) => state.blurType);
  const blurAmount = useEditorStore((state) => state.blurAmount);
  const canvasBounds = useEditorStore((state) => state.canvasBounds);
  const setCanvasBounds = useEditorStore((state) => state.setCanvasBounds);
  const setOriginalImageSize = useEditorStore((state) => state.setOriginalImageSize);
  const resetCanvasBounds = useEditorStore((state) => state.resetCanvasBounds);
  const originalImageSize = useEditorStore((state) => state.originalImageSize);
  
  // Helpers to manage undo history during drag/transform
  // Takes a snapshot before action starts, commits when action ends
  const pauseHistory = useCallback(() => {
    takeSnapshot();
  }, []);
  const resumeHistory = useCallback(() => {
    commitSnapshot();
  }, []);
  // Note: getCompositorPreviewStyle is used for export, not preview rendering

  const imageUrl = `data:image/png;base64,${imageData}`;
  const [image] = useImage(imageUrl);

  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [shapeSpawned, setShapeSpawned] = useState(false); // Track if shape has been created

  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isInitialFit, setIsInitialFit] = useState(true);
  const resizeTimeoutRef = useRef<number | null>(null);

  // Middle mouse panning state
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [positionStart, setPositionStart] = useState({ x: 0, y: 0 });

  // Marquee selection state
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeStart, setMarqueeStart] = useState({ x: 0, y: 0 });
  const [marqueeEnd, setMarqueeEnd] = useState({ x: 0, y: 0 });

  // Crop preview state - used during drag to avoid fighting with Konva
  const [cropPreview, setCropPreview] = useState<{
    x: number; y: number; width: number; height: number;
  } | null>(null);

  // Crop drag axis constraint state (for Shift+drag)
  const [cropDragStart, setCropDragStart] = useState<{ x: number; y: number } | null>(null);
  const [cropLockedAxis, setCropLockedAxis] = useState<'x' | 'y' | null>(null);

  // Inline text editing state
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingTextValue, setEditingTextValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Shift key state for proportional resize
  const [isShiftHeld, setIsShiftHeld] = useState(false);

  // Reset initial fit when image changes
  useEffect(() => {
    setIsInitialFit(true);
  }, [imageData]);

  // Keyboard shortcuts for shape manipulation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Delete selected shapes
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault();
        recordAction(() => {
          const newShapes = shapes.filter((shape) => !selectedIds.includes(shape.id));
          onShapesChange(newShapes);
        });
        setSelectedIds([]);
        return;
      }

      // Ctrl+A: Select all shapes
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && shapes.length > 0) {
        e.preventDefault();
        setSelectedIds(shapes.map(s => s.id));
        return;
      }

      // Escape: Deselect all
      if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedIds([]);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, shapes, onShapesChange]);

  // Track Shift key for proportional resize constraint
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftHeld(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Debounced container size update
  useEffect(() => {
    const updateContainerSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    const debouncedUpdate = () => {
      // Clear pending timeout
      if (resizeTimeoutRef.current) {
        cancelAnimationFrame(resizeTimeoutRef.current);
      }
      // Use requestAnimationFrame for smoother updates
      resizeTimeoutRef.current = requestAnimationFrame(updateContainerSize);
    };

    // Initial size
    updateContainerSize();

    // Use ResizeObserver with debouncing
    const resizeObserver = new ResizeObserver(debouncedUpdate);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      if (resizeTimeoutRef.current) {
        cancelAnimationFrame(resizeTimeoutRef.current);
      }
      resizeObserver.disconnect();
    };
  }, []);

  // Track previous container size to detect significant changes (like sidebar open/close)
  const prevContainerSizeRef = useRef(containerSize);

  // Fit to size when image loads, recenter ONLY on significant container resize
  // Padding/border changes should NOT trigger re-centering - keeps composition stable
  // Calculate composition dimensions (image + uniform padding)
  const getCompositionSize = useCallback((imgWidth: number, imgHeight: number) => {
    if (!compositorSettings.enabled) {
      return { width: imgWidth, height: imgHeight };
    }
    // Uniform padding based on average dimension
    const avgDimension = (imgWidth + imgHeight) / 2;
    const padding = avgDimension * (compositorSettings.padding / 100);
    return {
      width: imgWidth + padding * 2,
      height: imgHeight + padding * 2,
    };
  }, [compositorSettings.enabled, compositorSettings.padding]);

  useEffect(() => {
    if (image && containerSize.width > 0 && containerSize.height > 0) {
      setCanvasSize({ width: image.width, height: image.height });
      
      // Initialize canvas bounds and original image size on first load
      setOriginalImageSize({ width: image.width, height: image.height });
      if (!canvasBounds) {
        setCanvasBounds({
          width: image.width,
          height: image.height,
          imageOffsetX: 0,
          imageOffsetY: 0,
        });
      }

      const prevSize = prevContainerSizeRef.current;
      const widthDiff = Math.abs(containerSize.width - prevSize.width);
      const heightDiff = Math.abs(containerSize.height - prevSize.height);
      const isSignificantChange = widthDiff > 100 || heightDiff > 100;

      if (isInitialFit || isSignificantChange) {
        // Initial load or sidebar toggle: fit the content (respecting crop bounds)
        const viewPadding = 48;
        const availableWidth = containerSize.width - viewPadding * 2;
        const availableHeight = containerSize.height - viewPadding * 2;
        
        // Use crop bounds if available, otherwise full image
        const hasCrop = canvasBounds && (
          canvasBounds.imageOffsetX !== 0 ||
          canvasBounds.imageOffsetY !== 0 ||
          canvasBounds.width !== image.width ||
          canvasBounds.height !== image.height
        );
        const contentWidth = hasCrop ? canvasBounds!.width : image.width;
        const contentHeight = hasCrop ? canvasBounds!.height : image.height;
        const cropX = hasCrop ? -canvasBounds!.imageOffsetX : 0;
        const cropY = hasCrop ? -canvasBounds!.imageOffsetY : 0;
        
        // Account for compositor padding when calculating fit
        const compositionSize = getCompositionSize(contentWidth, contentHeight);
        const scaleX = availableWidth / compositionSize.width;
        const scaleY = availableHeight / compositionSize.height;
        const fitZoom = Math.min(scaleX, scaleY, 1) * 0.9;
        
        // Center the visible content
        const x = (containerSize.width - contentWidth * fitZoom) / 2 - cropX * fitZoom;
        const y = (containerSize.height - contentHeight * fitZoom) / 2 - cropY * fitZoom;
        
        setZoom(fitZoom);
        setPosition({ x, y });
        if (isInitialFit) setIsInitialFit(false);
      }

      prevContainerSizeRef.current = containerSize;
    }
  }, [image, containerSize, isInitialFit, getCompositionSize, canvasBounds]);

  // Zoom handlers - keep CROPPED CONTENT centered (respects crop bounds)
  const handleZoomIn = useCallback(() => {
    setZoom((prevZoom) => {
      const newZoom = Math.min(prevZoom + ZOOM_STEP, MAX_ZOOM);
      if (image) {
        // Use crop bounds if applied, otherwise full image
        const isCropApplied = canvasBounds && (
          canvasBounds.imageOffsetX !== 0 ||
          canvasBounds.imageOffsetY !== 0 ||
          canvasBounds.width !== image.width ||
          canvasBounds.height !== image.height
        );
        const contentWidth = isCropApplied ? canvasBounds!.width : image.width;
        const contentHeight = isCropApplied ? canvasBounds!.height : image.height;
        const cropX = isCropApplied ? -canvasBounds!.imageOffsetX : 0;
        const cropY = isCropApplied ? -canvasBounds!.imageOffsetY : 0;
        
        // Center the crop region in the container
        const x = (containerSize.width - contentWidth * newZoom) / 2 - cropX * newZoom;
        const y = (containerSize.height - contentHeight * newZoom) / 2 - cropY * newZoom;
        setPosition({ x, y });
      }
      return newZoom;
    });
  }, [image, containerSize, canvasBounds]);

  const handleZoomOut = useCallback(() => {
    setZoom((prevZoom) => {
      const newZoom = Math.max(prevZoom - ZOOM_STEP, MIN_ZOOM);
      if (image) {
        // Use crop bounds if applied, otherwise full image
        const isCropApplied = canvasBounds && (
          canvasBounds.imageOffsetX !== 0 ||
          canvasBounds.imageOffsetY !== 0 ||
          canvasBounds.width !== image.width ||
          canvasBounds.height !== image.height
        );
        const contentWidth = isCropApplied ? canvasBounds!.width : image.width;
        const contentHeight = isCropApplied ? canvasBounds!.height : image.height;
        const cropX = isCropApplied ? -canvasBounds!.imageOffsetX : 0;
        const cropY = isCropApplied ? -canvasBounds!.imageOffsetY : 0;
        
        // Center the crop region in the container
        const x = (containerSize.width - contentWidth * newZoom) / 2 - cropX * newZoom;
        const y = (containerSize.height - contentHeight * newZoom) / 2 - cropY * newZoom;
        setPosition({ x, y });
      }
      return newZoom;
    });
  }, [image, containerSize, canvasBounds]);

  const handleFitToSize = useCallback(() => {
    if (!image) return;
    
    // Use crop bounds if applied, otherwise use image size
    const isCropApplied = canvasBounds && (
      canvasBounds.imageOffsetX !== 0 || 
      canvasBounds.imageOffsetY !== 0 ||
      canvasBounds.width !== image.width ||
      canvasBounds.height !== image.height
    );
    
    const contentWidth = isCropApplied ? canvasBounds!.width : image.width;
    const contentHeight = isCropApplied ? canvasBounds!.height : image.height;
    // Crop region position in image coords
    const cropX = isCropApplied ? -canvasBounds!.imageOffsetX : 0;
    const cropY = isCropApplied ? -canvasBounds!.imageOffsetY : 0;
    
    const viewPadding = 48;
    const availableWidth = containerSize.width - viewPadding * 2;
    const availableHeight = containerSize.height - viewPadding * 2;
    
    // Account for compositor padding when calculating fit
    const compositionSize = getCompositionSize(contentWidth, contentHeight);
    const scaleX = availableWidth / compositionSize.width;
    const scaleY = availableHeight / compositionSize.height;
    // Zoom out slightly (90%) for better overview
    const fitZoom = Math.min(scaleX, scaleY, 1) * 0.9;
    
    // Center the crop region (stays in its original position, view moves to frame it)
    const x = (containerSize.width - contentWidth * fitZoom) / 2 - cropX * fitZoom;
    const y = (containerSize.height - contentHeight * fitZoom) / 2 - cropY * fitZoom;
    setZoom(fitZoom);
    setPosition({ x, y });
  }, [image, containerSize, getCompositionSize, canvasBounds]);

  // Fit to cropped content when exiting crop mode
  const prevToolRef = useRef(selectedTool);
  useEffect(() => {
    if (prevToolRef.current === 'crop' && selectedTool !== 'crop') {
      handleFitToSize();
    }
    prevToolRef.current = selectedTool;
  }, [selectedTool, handleFitToSize]);

  // 100% zoom - actual size centered on cropped content
  const handleActualSize = useCallback(() => {
    if (!image) return;
    
    // Use crop bounds if applied, otherwise full image
    const isCropApplied = canvasBounds && (
      canvasBounds.imageOffsetX !== 0 ||
      canvasBounds.imageOffsetY !== 0 ||
      canvasBounds.width !== image.width ||
      canvasBounds.height !== image.height
    );
    const contentWidth = isCropApplied ? canvasBounds!.width : image.width;
    const contentHeight = isCropApplied ? canvasBounds!.height : image.height;
    const cropX = isCropApplied ? -canvasBounds!.imageOffsetX : 0;
    const cropY = isCropApplied ? -canvasBounds!.imageOffsetY : 0;
    
    // Center the crop region in the container at 100% zoom
    const x = (containerSize.width - contentWidth) / 2 - cropX;
    const y = (containerSize.height - contentHeight) / 2 - cropY;
    setZoom(1);
    setPosition({ x, y });
  }, [image, containerSize, canvasBounds]);

  // Middle mouse panning handlers
  const handleMiddleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) { // Middle mouse button
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      setPositionStart(position);
    }
  }, [position]);

  const handleMiddleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    setPosition({
      x: positionStart.x + dx,
      y: positionStart.y + dy,
    });
  }, [isPanning, panStart, positionStart]);

  const handleMiddleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Prevent default middle-click auto-scroll behavior
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const preventMiddleClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    
    container.addEventListener('mousedown', preventMiddleClick);
    container.addEventListener('auxclick', preventMiddleClick);
    
    return () => {
      container.removeEventListener('mousedown', preventMiddleClick);
      container.removeEventListener('auxclick', preventMiddleClick);
    };
  }, []);

  // Auto-refit when compositor padding changes (keeps composition in view)
  const prevPaddingRef = useRef(compositorSettings.padding);
  useEffect(() => {
    if (compositorSettings.enabled && compositorSettings.padding !== prevPaddingRef.current) {
      prevPaddingRef.current = compositorSettings.padding;
      handleFitToSize();
    }
  }, [compositorSettings.enabled, compositorSettings.padding, handleFitToSize]);

  // Auto-refit when canvas bounds change (keeps compositor aligned with cropped content)
  // Skip when in crop mode - user is actively adjusting, don't interrupt
  const prevBoundsRef = useRef<typeof canvasBounds>(null);
  useEffect(() => {
    if (!canvasBounds) {
      prevBoundsRef.current = canvasBounds;
      return;
    }

    // Don't auto-refit while in crop mode - let user work freely
    if (selectedTool === 'crop') {
      prevBoundsRef.current = canvasBounds;
      return;
    }

    // Refit if bounds changed OR if this is first time bounds are set with actual crop
    const prev = prevBoundsRef.current;
    const hasCropApplied = canvasBounds.imageOffsetX !== 0 ||
      canvasBounds.imageOffsetY !== 0 ||
      (image && (canvasBounds.width !== image.width || canvasBounds.height !== image.height));

    const changed = !prev || (
      canvasBounds.width !== prev.width ||
      canvasBounds.height !== prev.height ||
      canvasBounds.imageOffsetX !== prev.imageOffsetX ||
      canvasBounds.imageOffsetY !== prev.imageOffsetY
    );

    if (changed && hasCropApplied) {
      handleFitToSize();
    }
    prevBoundsRef.current = canvasBounds;
  }, [canvasBounds, handleFitToSize, image, selectedTool]);

  // Mouse wheel zoom - keep CROPPED CONTENT centered
  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();

      if (!image) return;

      // Zoom direction
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newZoom = Math.min(
        Math.max(zoom + direction * ZOOM_STEP, MIN_ZOOM),
        MAX_ZOOM
      );

      // Use crop bounds if applied, otherwise full image
      const isCropApplied = canvasBounds && (
        canvasBounds.imageOffsetX !== 0 ||
        canvasBounds.imageOffsetY !== 0 ||
        canvasBounds.width !== image.width ||
        canvasBounds.height !== image.height
      );
      const contentWidth = isCropApplied ? canvasBounds!.width : image.width;
      const contentHeight = isCropApplied ? canvasBounds!.height : image.height;
      const cropX = isCropApplied ? -canvasBounds!.imageOffsetX : 0;
      const cropY = isCropApplied ? -canvasBounds!.imageOffsetY : 0;

      // Center the crop region in the container
      const x = (containerSize.width - contentWidth * newZoom) / 2 - cropX * newZoom;
      const y = (containerSize.height - contentHeight * newZoom) / 2 - cropY * newZoom;

      setZoom(newZoom);
      setPosition({ x, y });
    },
    [zoom, image, containerSize, canvasBounds]
  );

  // Handle transformer - supports multiple selection, excludes arrows (they have custom handles)
  useEffect(() => {
    if (transformerRef.current && selectedIds.length > 0) {
      // Don't show transformer when in pen mode (no gizmo while drawing freehand)
      if (selectedTool === 'pen') {
        transformerRef.current.nodes([]);
        return;
      }
      
      // Filter out arrows - they use custom endpoint handles instead
      const nonArrowIds = selectedIds.filter(id => {
        const shape = shapes.find(s => s.id === id);
        return shape && shape.type !== 'arrow';
      });
      
      const nodes = nonArrowIds
        .map(id => stageRef.current?.findOne(`#${id}`))
        .filter((node): node is Konva.Node => node !== undefined);
      transformerRef.current.nodes(nodes);
      transformerRef.current.getLayer()?.batchDraw();
    } else if (transformerRef.current) {
      transformerRef.current.nodes([]);
    }
  }, [selectedIds, stageRef, shapes, selectedTool]);

  // Transform screen position to canvas position (accounting for zoom and pan)
  const getCanvasPosition = useCallback(
    (screenPos: { x: number; y: number }) => {
      return {
        x: (screenPos.x - position.x) / zoom,
        y: (screenPos.y - position.y) / zoom,
      };
    },
    [zoom, position]
  );

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const stage = stageRef.current;
      if (!stage) return;

      const screenPos = stage.getPointerPosition();
      if (!screenPos) return;

      const pos = getCanvasPosition(screenPos);

      // Clicked on empty space
      if (e.target === stage || e.target.name() === 'background') {
        setSelectedIds([]);
        
        // Start marquee selection in select mode
        if (selectedTool === 'select') {
          setIsMarqueeSelecting(true);
          setMarqueeStart(pos);
          setMarqueeEnd(pos);
          return;
        }
      }

      if (selectedTool === 'select') return;

      // For click-to-place tools (text, steps), create immediately with undo support
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
        return;
      }

      if (selectedTool === 'steps') {
        const id = `shape_${Date.now()}`;
        const newShape: CanvasShape = {
          id,
          type: 'step',
          x: pos.x,
          y: pos.y,
          number: stepCount,
          fill: strokeColor,
        };
        setStepCount(stepCount + 1);
        recordAction(() => onShapesChange([...shapes, newShape]));
        setSelectedIds([id]);
        onToolChange('select');
        return;
      }

      // For drag-to-draw tools, snapshot before drawing starts
      takeSnapshot();
      setIsDrawing(true);
      setDrawStart(pos);
      setShapeSpawned(false);
    },
    [selectedTool, strokeColor, strokeWidth, stepCount, shapes, onShapesChange, onToolChange, stageRef, getCanvasPosition, blurType, blurAmount]
  );

  // Helper to create a new shape based on tool type
  const createShapeAtPosition = useCallback((startPos: { x: number; y: number }, endPos: { x: number; y: number }): CanvasShape | null => {
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
          fill: 'transparent',
        };
      case 'circle': {
        // Drag from corner to corner (like rectangles)
        // Center is midpoint, radii are half the bounding box
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
          fill: 'transparent',
        };
      }
      case 'highlight':
        return {
          id,
          type: 'highlight',
          x: startPos.x,
          y: startPos.y,
          width: endPos.x - startPos.x,
          height: endPos.y - startPos.y,
          fill: 'rgba(255, 255, 0, 0.4)',
        };
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
        // Pen uses points array for freehand drawing
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
  }, [selectedTool, strokeColor, strokeWidth, blurType, blurAmount]);

  const handleMouseMove = useCallback(
    (_e: Konva.KonvaEventObject<MouseEvent>) => {
      const stage = stageRef.current;
      if (!stage) return;

      const screenPos = stage.getPointerPosition();
      if (!screenPos) return;

      const pos = getCanvasPosition(screenPos);

      // Handle marquee selection
      if (isMarqueeSelecting) {
        setMarqueeEnd(pos);
        return;
      }

      if (!isDrawing) return;

      // Calculate distance from start
      const distance = Math.sqrt(
        Math.pow(pos.x - drawStart.x, 2) + Math.pow(pos.y - drawStart.y, 2)
      );

      // If shape not spawned yet, check threshold
      if (!shapeSpawned) {
        if (distance < MIN_SHAPE_SIZE) {
          return; // Don't spawn yet
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
          // Drag from corner to corner - center is midpoint
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
          // Accumulate points for freehand drawing
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
    [isDrawing, isMarqueeSelecting, shapeSpawned, shapes, drawStart, onShapesChange, stageRef, getCanvasPosition, createShapeAtPosition]
  );

  const handleMouseUp = useCallback(() => {
    // Handle marquee selection completion
    if (isMarqueeSelecting) {
      // Calculate marquee bounds
      const x1 = Math.min(marqueeStart.x, marqueeEnd.x);
      const y1 = Math.min(marqueeStart.y, marqueeEnd.y);
      const x2 = Math.max(marqueeStart.x, marqueeEnd.x);
      const y2 = Math.max(marqueeStart.y, marqueeEnd.y);

      // Find shapes that intersect with marquee
      const selectedShapeIds = shapes.filter(shape => {
        // Get shape bounds
        let shapeX = shape.x ?? 0;
        let shapeY = shape.y ?? 0;
        const radiusX = shape.radiusX ?? shape.radius ?? 0;
        const radiusY = shape.radiusY ?? shape.radius ?? 0;
        let shapeW = shape.width ?? (radiusX ? radiusX * 2 : 0);
        let shapeH = shape.height ?? (radiusY ? radiusY * 2 : 0);

        // For circles/ellipses, adjust position to be top-left
        if (radiusX || radiusY) {
          shapeX -= radiusX;
          shapeY -= radiusY;
        }

        // For arrows, calculate bounding box from points
        if (shape.type === 'arrow' && shape.points && shape.points.length >= 4) {
          const [px1, py1, px2, py2] = shape.points;
          shapeX = Math.min(px1, px2);
          shapeY = Math.min(py1, py2);
          shapeW = Math.abs(px2 - px1);
          shapeH = Math.abs(py2 - py1);
        }

        // For pen strokes, calculate bounding box from all points
        if (shape.type === 'pen' && shape.points && shape.points.length >= 2) {
          const xs = shape.points.filter((_, i) => i % 2 === 0);
          const ys = shape.points.filter((_, i) => i % 2 === 1);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          shapeX = minX;
          shapeY = minY;
          shapeW = maxX - minX;
          shapeH = maxY - minY;
        }

        // Check intersection
        return !(shapeX > x2 || shapeX + shapeW < x1 || shapeY > y2 || shapeY + shapeH < y1);
      }).map(shape => shape.id);

      if (selectedShapeIds.length > 0) {
        setSelectedIds(selectedShapeIds);
      }

      setIsMarqueeSelecting(false);
      return;
    }

    // If drawing ended, commit the snapshot (shape creation is now undoable)
    if (isDrawing) {
      if (shapeSpawned) {
        commitSnapshot(); // Shape was created, commit to history
        // Switch back to select mode (unless tool retains mode like pen)
        if (!TOOLS_RETAIN_MODE.has(selectedTool)) {
          onToolChange('select');
        }
      }
      // If no shape was spawned (click without drag), discard the pending snapshot
      // No need to call discardSnapshot - commitSnapshot handles the case where nothing changed
    }

    setIsDrawing(false);
    setShapeSpawned(false);
  }, [isMarqueeSelecting, isDrawing, shapeSpawned, marqueeStart, marqueeEnd, shapes, onToolChange, selectedTool]);

  // Handle shape drag - supports both single and group movement
  // Resumes history tracking to commit drag as single undo step
  const handleShapeDragEnd = useCallback(
    (id: string, e: Konva.KonvaEventObject<DragEvent>) => {
      const draggedShape = shapes.find(s => s.id === id);
      if (!draggedShape) {
        resumeHistory();
        return;
      }

      // Calculate delta based on shape type
      const isPen = draggedShape.type === 'pen' && draggedShape.points && draggedShape.points.length >= 2;
      const dx = e.target.x() - (isPen ? 0 : (draggedShape.x ?? 0));
      const dy = e.target.y() - (isPen ? 0 : (draggedShape.y ?? 0));

      // Reset position for pen strokes (they use points, not x/y)
      if (isPen) {
        e.target.position({ x: 0, y: 0 });
      }

      // Group drag: move all selected shapes by the same delta
      if (selectedIds.length > 1 && selectedIds.includes(id)) {
        const updatedShapes = shapes.map((shape) => {
          if (!selectedIds.includes(shape.id)) return shape;

          if (shape.type === 'pen' && shape.points && shape.points.length >= 2) {
            const newPoints = shape.points.map((val, i) =>
              i % 2 === 0 ? val + dx : val + dy
            );
            return { ...shape, points: newPoints };
          }

          return {
            ...shape,
            x: (shape.x ?? 0) + dx,
            y: (shape.y ?? 0) + dy,
          };
        });
        onShapesChange(updatedShapes);
      } else {
        // Single shape drag
        if (isPen) {
          const newPoints = draggedShape.points!.map((val, i) =>
            i % 2 === 0 ? val + dx : val + dy
          );
          const updatedShapes = shapes.map((shape) =>
            shape.id === id ? { ...shape, points: newPoints } : shape
          );
          onShapesChange(updatedShapes);
        } else if (draggedShape.type === 'blur') {
          // Blur uses normalized position (Rect is at shapeX, not shape.x)
          // Calculate delta from normalized position to preserve negative width/height
          const normalizedX = (draggedShape.width ?? 0) < 0 
            ? (draggedShape.x ?? 0) + (draggedShape.width ?? 0) 
            : (draggedShape.x ?? 0);
          const normalizedY = (draggedShape.height ?? 0) < 0 
            ? (draggedShape.y ?? 0) + (draggedShape.height ?? 0) 
            : (draggedShape.y ?? 0);
          const blurDx = e.target.x() - normalizedX;
          const blurDy = e.target.y() - normalizedY;
          const updatedShapes = shapes.map((shape) =>
            shape.id === id
              ? { ...shape, x: (shape.x ?? 0) + blurDx, y: (shape.y ?? 0) + blurDy }
              : shape
          );
          onShapesChange(updatedShapes);
        } else {
          const updatedShapes = shapes.map((shape) =>
            shape.id === id
              ? { ...shape, x: e.target.x(), y: e.target.y() }
              : shape
          );
          onShapesChange(updatedShapes);
        }
      }

      // Resume history tracking - commits all changes since pause as one undo step
      resumeHistory();
    },
    [shapes, onShapesChange, selectedIds, resumeHistory]
  );

  // Handle transform start - pause history to batch all intermediate updates
  const handleTransformStart = useCallback(() => {
    pauseHistory();
  }, [pauseHistory]);

  // Handle transform (resize/rotate via gizmo) - updates in real-time for proper stroke rendering
  const handleTransform = useCallback(
    (id: string, e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      const shape = shapes.find(s => s.id === id);
      if (!shape) return;

      // For pen and blur, let Konva handle visual scaling - bake it on transformEnd
      // This avoids expensive re-renders during transform
      if (shape.type === 'pen' || shape.type === 'blur') {
        return;
      }

      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      // Reset scale immediately and apply to dimensions
      // This keeps stroke width consistent during resize
      node.scaleX(1);
      node.scaleY(1);

      const updatedShapes = shapes.map((s) => {
        if (s.id !== id) return s;

        const updates: Partial<CanvasShape> = {
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
        };

        // Apply scale to width/height for rect-like shapes
        if (s.width !== undefined) {
          updates.width = Math.abs(s.width * scaleX);
        }
        if (s.height !== undefined) {
          updates.height = Math.abs(s.height * scaleY);
        }
        // Apply scale to radiusX/radiusY for ellipses
        if (s.radiusX !== undefined) {
          updates.radiusX = Math.abs(s.radiusX * scaleX);
        }
        if (s.radiusY !== undefined) {
          updates.radiusY = Math.abs(s.radiusY * scaleY);
        }
        // Legacy: convert old radius to radiusX/radiusY
        if (s.radius !== undefined && s.radiusX === undefined) {
          updates.radiusX = Math.abs(s.radius * scaleX);
          updates.radiusY = Math.abs(s.radius * scaleY);
          updates.radius = undefined;
        }

        return { ...s, ...updates };
      });

      onShapesChange(updatedShapes);
    },
    [shapes, onShapesChange]
  );

  // Handle transform end - bake scale into dimensions for pen/blur, ensure final state for others
  // Resume history tracking to commit all batched changes as single undo step
  const handleTransformEnd = useCallback(
    (id: string, e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      const shape = shapes.find(s => s.id === id);

      // For pen strokes, bake the accumulated transform into points
      if (shape?.type === 'pen' && shape.points && shape.points.length >= 2) {
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        const nodeX = node.x();
        const nodeY = node.y();

        const newPoints = shape.points.map((val, i) => {
          if (i % 2 === 0) {
            return nodeX + val * scaleX;
          } else {
            return nodeY + val * scaleY;
          }
        });

        node.scaleX(1);
        node.scaleY(1);
        node.position({ x: 0, y: 0 });

        const updatedShapes = shapes.map(s =>
          s.id === id ? { ...s, points: newPoints } : s
        );
        onShapesChange(updatedShapes);
      } 
      // For blur shapes, read dimensions directly from node
      // (BlurRegion's handleTransformInternal already bakes scale into node.width/height)
      else if (shape?.type === 'blur') {
        const updatedShapes = shapes.map(s => {
          if (s.id !== id) return s;
          return {
            ...s,
            x: node.x(),
            y: node.y(),
            width: node.width(),
            height: node.height(),
          };
        });
        onShapesChange(updatedShapes);
      } else {
        // For other shapes, just ensure scale is reset
        node.scaleX(1);
        node.scaleY(1);
      }

      // Resume history tracking - commits all changes since pause as one undo step
      resumeHistory();
    },
    [shapes, onShapesChange, resumeHistory]
  );

  // Handle shape click with shift for multi-select
  const handleShapeClick = useCallback((shapeId: string, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.shiftKey) {
      // Toggle selection with shift
      if (selectedIds.includes(shapeId)) {
        setSelectedIds(selectedIds.filter(id => id !== shapeId));
      } else {
        setSelectedIds([...selectedIds, shapeId]);
      }
    } else {
      // Keep group selection if clicking on already-selected shape (allows group drag)
      if (!selectedIds.includes(shapeId)) {
        setSelectedIds([shapeId]);
      }
    }
  }, [selectedIds, setSelectedIds]);

  // Handle arrow endpoint drag
  const handleArrowEndpointDrag = useCallback(
    (shapeId: string, endpointIndex: 0 | 1, e: Konva.KonvaEventObject<DragEvent>) => {
      const shape = shapes.find(s => s.id === shapeId);
      if (!shape || !shape.points || shape.points.length < 4) return;

      const newPoints = [...shape.points];
      if (endpointIndex === 0) {
        // Start point
        newPoints[0] = e.target.x();
        newPoints[1] = e.target.y();
      } else {
        // End point (arrow head)
        newPoints[2] = e.target.x();
        newPoints[3] = e.target.y();
      }

      const updatedShapes = shapes.map(s =>
        s.id === shapeId ? { ...s, points: newPoints } : s
      );
      onShapesChange(updatedShapes);
    },
    [shapes, onShapesChange]
  );

  // Handle saving inline text edit
  const handleSaveTextEdit = useCallback(() => {
    if (!editingTextId) return;
    
    const updatedShapes = shapes.map(s =>
      s.id === editingTextId ? { ...s, text: editingTextValue } : s
    );
    onShapesChange(updatedShapes);
    setEditingTextId(null);
    setEditingTextValue('');
  }, [editingTextId, editingTextValue, shapes, onShapesChange]);

  // Handle canceling inline text edit
  const handleCancelTextEdit = useCallback(() => {
    setEditingTextId(null);
    setEditingTextValue('');
  }, []);

  // Get the position for the textarea overlay
  const getTextareaPosition = useCallback(() => {
    if (!editingTextId || !stageRef.current || !containerRef.current) return null;
    
    const shape = shapes.find(s => s.id === editingTextId);
    if (!shape) return null;
    
    // Get stage transform
    const containerRect = containerRef.current.getBoundingClientRect();
    
    // Calculate screen position
    const screenX = containerRect.left + position.x + (shape.x || 0) * zoom;
    const screenY = containerRect.top + position.y + (shape.y || 0) * zoom;
    
    return {
      left: screenX,
      top: screenY,
      fontSize: (shape.fontSize || 16) * zoom,
      color: shape.fill || '#000',
    };
  }, [editingTextId, shapes, position, zoom, stageRef]);

  const renderShape = useCallback(
    (shape: CanvasShape) => {
      const commonProps = {
        id: shape.id,
        key: shape.id,
        draggable: selectedTool === 'select',
        onClick: (e: Konva.KonvaEventObject<MouseEvent>) => handleShapeClick(shape.id, e),
        onTap: () => setSelectedIds([shape.id]),
        onDragStart: () => {
          // Add to selection if not already selected
          if (!selectedIds.includes(shape.id)) {
            setSelectedIds([shape.id]);
          }
          // Pause history to batch drag updates
          pauseHistory();
        },
        onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) =>
          handleShapeDragEnd(shape.id, e),
        onTransformStart: handleTransformStart,
        onTransform: (e: Konva.KonvaEventObject<Event>) =>
          handleTransform(shape.id, e),
        onTransformEnd: (e: Konva.KonvaEventObject<Event>) =>
          handleTransformEnd(shape.id, e),
      };

      switch (shape.type) {
        case 'arrow': {
          const points = shape.points || [0, 0, 0, 0];
          const isArrowSelected = selectedIds.includes(shape.id);
          const handleSize = 6 / zoom; // Scale handles inversely with zoom
          
          return (
            <React.Fragment key={shape.id}>
              <Arrow
                id={shape.id}
                points={points}
                stroke={shape.stroke}
                strokeWidth={shape.strokeWidth}
                fill={shape.fill}
                pointerLength={10}
                pointerWidth={10}
                draggable={selectedTool === 'select'}
                onClick={(e: Konva.KonvaEventObject<MouseEvent>) => handleShapeClick(shape.id, e)}
                onTap={() => setSelectedIds([shape.id])}
                onDragStart={() => {
                  if (!selectedIds.includes(shape.id)) {
                    setSelectedIds([shape.id]);
                  }
                  pauseHistory();
                }}
                onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => {
                  // Update all points by the drag delta
                  const dx = e.target.x();
                  const dy = e.target.y();
                  e.target.position({ x: 0, y: 0 }); // Reset position
                  const newPoints = [
                    points[0] + dx,
                    points[1] + dy,
                    points[2] + dx,
                    points[3] + dy,
                  ];
                  const updatedShapes = shapes.map(s =>
                    s.id === shape.id ? { ...s, points: newPoints } : s
                  );
                  onShapesChange(updatedShapes);
                  resumeHistory();
                }}
              />
              {/* Custom endpoint handles for arrows */}
              {isArrowSelected && selectedTool === 'select' && (
                <>
                  {/* Start point handle */}
                  <Circle
                    x={points[0]}
                    y={points[1]}
                    radius={handleSize}
                    fill="#fbbf24"
                    stroke="#fff"
                    strokeWidth={1 / zoom}
                    draggable
                    onDragStart={() => pauseHistory()}
                    onDragMove={(e) => handleArrowEndpointDrag(shape.id, 0, e)}
                    onDragEnd={() => resumeHistory()}
                    onMouseEnter={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'move';
                    }}
                    onMouseLeave={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'default';
                    }}
                  />
                  {/* End point handle (arrow head) */}
                  <Circle
                    x={points[2]}
                    y={points[3]}
                    radius={handleSize}
                    fill="#fbbf24"
                    stroke="#fff"
                    strokeWidth={1 / zoom}
                    draggable
                    onDragStart={() => pauseHistory()}
                    onDragMove={(e) => handleArrowEndpointDrag(shape.id, 1, e)}
                    onDragEnd={() => resumeHistory()}
                    onMouseEnter={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'move';
                    }}
                    onMouseLeave={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'default';
                    }}
                  />
                </>
              )}
            </React.Fragment>
          );
        }
        case 'rect':
          return (
            <Rect
              {...commonProps}
              x={shape.x}
              y={shape.y}
              width={shape.width}
              height={shape.height}
              stroke={shape.stroke}
              strokeWidth={shape.strokeWidth}
              fill={shape.fill}
            />
          );
        case 'circle':
          return (
            <Ellipse
              {...commonProps}
              x={shape.x}
              y={shape.y}
              radiusX={shape.radiusX ?? shape.radius ?? 0}
              radiusY={shape.radiusY ?? shape.radius ?? 0}
              stroke={shape.stroke}
              strokeWidth={shape.strokeWidth}
              fill={shape.fill}
            />
          );
        case 'highlight':
          return (
            <Rect
              {...commonProps}
              x={shape.x}
              y={shape.y}
              width={shape.width}
              height={shape.height}
              fill={shape.fill}
            />
          );
        case 'blur': {
          // While actively drawing this shape, show simple preview (no expensive blur)
          const isActivelyDrawing = isDrawing && shapes[shapes.length - 1]?.id === shape.id;
          
          if (isActivelyDrawing) {
            // Fast preview during drawing - just a dashed rect
            return (
              <Rect
                key={shape.id}
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
          
          return (
            <BlurRegion
              key={shape.id}
              shape={shape}
              sourceImage={image}
              isSelected={selectedIds.includes(shape.id)}
              onSelect={() => setSelectedIds([shape.id])}
              onDragStart={() => pauseHistory()}
              onDragEnd={(e) => handleShapeDragEnd(shape.id, e)}
              onTransformStart={handleTransformStart}
              onTransformEnd={(e) => handleTransformEnd(shape.id, e)}
              draggable={selectedTool === 'select'}
            />
          );
        }
        case 'text':
          return (
            <Text
              {...commonProps}
              x={shape.x}
              y={shape.y}
              text={shape.text}
              fontSize={shape.fontSize}
              fill={shape.fill}
              draggable
              visible={editingTextId !== shape.id}
              onDblClick={() => {
                setEditingTextId(shape.id);
                setEditingTextValue(shape.text || '');
              }}
              onDblTap={() => {
                setEditingTextId(shape.id);
                setEditingTextValue(shape.text || '');
              }}
            />
          );
        case 'step':
          return (
            <Group {...commonProps} x={shape.x} y={shape.y}>
              <Circle radius={15} fill={shape.fill} />
              <Text
                text={String(shape.number)}
                fontSize={14}
                fill="white"
                fontStyle="bold"
                align="center"
                verticalAlign="middle"
                offsetX={4}
                offsetY={6}
              />
            </Group>
          );
        case 'pen':
          return (
            <Line
              {...commonProps}
              points={shape.points || []}
              stroke={shape.stroke}
              strokeWidth={shape.strokeWidth}
              hitStrokeWidth={Math.max(20, (shape.strokeWidth || 2) * 3)}
              tension={0.5}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation="source-over"
            />
          );
        default:
          return null;
      }
    },
    [selectedTool, handleShapeDragEnd, handleTransform, handleTransformEnd, handleShapeClick, handleArrowEndpointDrag, image, selectedIds, shapes, onShapesChange, zoom, editingTextId]
  );

  // Memoize rendered shapes to prevent recalculation during resize
  const renderedShapes = useMemo(() => shapes.map(renderShape), [shapes, renderShape]);

  // Compute the visible content bounds - used by both clipping and compositor
  // This ensures they always match
  const visibleBounds = useMemo(() => {
    if (!image || !canvasBounds) return null;

    // In crop mode, ALWAYS show full image - the dark overlay handles showing crop region
    // Don't clip based on cropPreview, user needs to see the full image while adjusting
    if (selectedTool === 'crop') {
      return { x: 0, y: 0, width: image.width, height: image.height };
    }

    // Check if crop is actually applied (bounds differ from image)
    const hasCrop =
      canvasBounds.imageOffsetX !== 0 ||
      canvasBounds.imageOffsetY !== 0 ||
      canvasBounds.width !== image.width ||
      canvasBounds.height !== image.height;

    if (hasCrop) {
      return {
        x: -canvasBounds.imageOffsetX,
        y: -canvasBounds.imageOffsetY,
        width: canvasBounds.width,
        height: canvasBounds.height,
      };
    }

    // No crop - full image
    return { x: 0, y: 0, width: image.width, height: image.height };
  }, [image, canvasBounds, selectedTool]);

  // Compute bounding box of selected shapes for group drag background
  const selectionBounds = useMemo(() => {
    if (selectedIds.length < 2) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const id of selectedIds) {
      const shape = shapes.find(s => s.id === id);
      if (!shape) continue;

      let x = shape.x ?? 0;
      let y = shape.y ?? 0;
      let w = shape.width ?? 0;
      let h = shape.height ?? 0;

      // Handle circles/ellipses
      if (shape.radiusX || shape.radiusY || shape.radius) {
        const rx = shape.radiusX ?? shape.radius ?? 0;
        const ry = shape.radiusY ?? shape.radius ?? 0;
        x -= rx;
        y -= ry;
        w = rx * 2;
        h = ry * 2;
      }

      // Handle point-based shapes (pen, arrow)
      if (shape.points && shape.points.length >= 2) {
        const xs = shape.points.filter((_, i) => i % 2 === 0);
        const ys = shape.points.filter((_, i) => i % 2 === 1);
        x = Math.min(...xs);
        y = Math.min(...ys);
        w = Math.max(...xs) - x;
        h = Math.max(...ys) - y;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }

    if (!isFinite(minX)) return null;

    // Add padding for easier grabbing
    const padding = 4;
    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }, [selectedIds, shapes]);

  // Create checkerboard pattern image for transparency indication
  const [checkerPatternImage, setCheckerPatternImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    const size = 16; // Size of each checker square
    const canvas = document.createElement('canvas');
    canvas.width = size * 2;
    canvas.height = size * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Light gray squares
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, size, size);
    ctx.fillRect(size, size, size, size);

    // Dark gray squares
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(size, 0, size, size);
    ctx.fillRect(0, size, size, size);

    // Convert canvas to image
    const img = new window.Image();
    img.onload = () => setCheckerPatternImage(img);
    img.src = canvas.toDataURL();
  }, []);

  // Calculate composition box dimensions (for preview background)
  // Uses visibleBounds to match exactly what's clipped
  // Position is derived from Stage position + visibleBounds offset
  const compositionBox = useMemo(() => {
    if (!compositorSettings.enabled || !visibleBounds) return null;
    
    const contentWidth = visibleBounds.width;
    const contentHeight = visibleBounds.height;
    
    const paddingPercent = compositorSettings.padding / 100;
    const avgDimension = (contentWidth + contentHeight) / 2;
    const padding = avgDimension * zoom * paddingPercent;
    
    // Round to integers and add 1px buffer to prevent sub-pixel edge artifacts
    // Use floor for position (expand left/up) and ceil for size (expand right/down)
    const left = Math.floor(position.x + visibleBounds.x * zoom - padding) - 1;
    const top = Math.floor(position.y + visibleBounds.y * zoom - padding) - 1;
    const width = Math.ceil(contentWidth * zoom + padding * 2) + 2;
    const height = Math.ceil(contentHeight * zoom + padding * 2) + 2;
    
    return { width, height, left, top };
  }, [compositorSettings.enabled, compositorSettings.padding, visibleBounds, zoom, position]);

  // Calculate base composition size (at zoom=1) for consistent background scaling
  // Uses visibleBounds to match compositor
  const baseCompositionSize = useMemo(() => {
    if (!visibleBounds) return { width: 0, height: 0 };
    
    const contentWidth = visibleBounds.width;
    const contentHeight = visibleBounds.height;
    
    // Uniform padding based on average dimension
    const avgDimension = (contentWidth + contentHeight) / 2;
    const paddingPercent = compositorSettings.padding / 100;
    const padding = avgDimension * paddingPercent;
    
    return {
      width: contentWidth + padding * 2,
      height: contentHeight + padding * 2,
    };
  }, [visibleBounds, compositorSettings.padding]);

  // Generate background style for composition box only - granular deps for perf
  const compositionBackgroundStyle = useMemo((): React.CSSProperties => {
    if (!compositorSettings.enabled) return {};
    
    let background: string;
    let backgroundSize: string = 'cover';
    
    switch (compositorSettings.backgroundType) {
      case 'solid':
        background = compositorSettings.backgroundColor;
        break;
      case 'gradient': {
        const gradientStops = compositorSettings.gradientStops
          .map((s) => `${s.color} ${s.position}%`)
          .join(', ');
        background = `linear-gradient(${compositorSettings.gradientAngle}deg, ${gradientStops})`;
        break;
      }
      case 'image':
        background = compositorSettings.backgroundImage
          ? `url(${compositorSettings.backgroundImage})`
          : '#1a1a2e';
        // Scale background image proportionally with zoom to maintain aspect ratio
        // Use base size so the image crops consistently regardless of zoom level
        if (compositorSettings.backgroundImage && baseCompositionSize.width > 0) {
          const bgWidth = baseCompositionSize.width * zoom;
          const bgHeight = baseCompositionSize.height * zoom;
          backgroundSize = `${bgWidth}px ${bgHeight}px`;
        }
        break;
      default:
        background = '#1a1a2e';
    }
    
    return {
      background,
      backgroundSize,
      backgroundPosition: 'center',
    };
  }, [
    compositorSettings.enabled,
    compositorSettings.backgroundType,
    compositorSettings.backgroundColor,
    compositorSettings.backgroundImage,
    compositorSettings.gradientStops,
    compositorSettings.gradientAngle,
    baseCompositionSize,
    zoom,
  ]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden relative"
      style={{
        backgroundColor: 'var(--obsidian-base)',
        cursor: isPanning ? 'grabbing' : 'default',
      }}
      onMouseDown={handleMiddleMouseDown}
      onMouseMove={handleMiddleMouseMove}
      onMouseUp={handleMiddleMouseUp}
      onMouseLeave={handleMiddleMouseUp}
    >
      
      {/* Composition Preview Background - renders BEHIND the Konva stage */}
      {compositorSettings.enabled && compositionBox && visibleBounds && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: compositionBox.left,
            top: compositionBox.top,
            width: compositionBox.width,
            height: compositionBox.height,
            zIndex: 0,
            willChange: 'transform, width, height',
            contain: 'layout style paint',
            ...compositionBackgroundStyle,
          }}
        >
          {/* Shadow element for content - positioned inside compositor padding */}
          {compositorSettings.shadowEnabled && (() => {
            const intensity = compositorSettings.shadowIntensity;
            // Calculate content position relative to compositor box
            const contentLeft = position.x + visibleBounds.x * zoom - compositionBox.left;
            const contentTop = position.y + visibleBounds.y * zoom - compositionBox.top;
            const contentWidth = visibleBounds.width * zoom;
            const contentHeight = visibleBounds.height * zoom;
            
            return (
              <div
                style={{
                  position: 'absolute',
                  left: contentLeft,
                  top: contentTop,
                  width: contentWidth,
                  height: contentHeight,
                  borderRadius: compositorSettings.borderRadius * zoom,
                  boxShadow: [
                    `0 ${2 * intensity}px ${10 * intensity}px rgba(0,0,0,${0.1 * intensity})`,
                    `0 ${8 * intensity}px ${30 * intensity}px rgba(0,0,0,${0.15 * intensity})`,
                    `0 ${16 * intensity}px ${60 * intensity}px rgba(0,0,0,${0.2 * intensity})`,
                  ].join(', '),
                }}
              />
            );
          })()}
        </div>
      )}
      
      {/* Canvas Stage */}
      <Stage
        ref={stageRef}
        width={containerSize.width}
        height={containerSize.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        scaleX={zoom}
        scaleY={zoom}
        x={position.x}
        y={position.y}
        style={{ backgroundColor: 'transparent' }}
      >
        <Layer ref={layerRef}>
          {/* Default shadow when compositor disabled */}
          {!compositorSettings.enabled && visibleBounds && (
            <Rect
              name="editor-shadow"
              x={visibleBounds.x - 2}
              y={visibleBounds.y - 2}
              width={visibleBounds.width + 4}
              height={visibleBounds.height + 4}
              fill="rgba(0,0,0,0.3)"
              cornerRadius={4}
              shadowColor="black"
              shadowBlur={20}
              shadowOpacity={0.5}
              listening={false}
            />
          )}

          {/* Full compositor background (with padding) - rendered in Konva for direct export */}
          {compositorSettings.enabled && visibleBounds && baseCompositionSize.width > 0 && (() => {
            // Calculate padding in canvas coordinates
            const avgDimension = (visibleBounds.width + visibleBounds.height) / 2;
            const padding = avgDimension * (compositorSettings.padding / 100);
            
            // Compositor bounds (content + padding)
            // Round to integers to match export bounds calculation and prevent sub-pixel artifacts
            // Add 1px buffer on all sides to prevent edge clipping artifacts
            const compBounds = {
              x: Math.round(visibleBounds.x - padding) - 1,
              y: Math.round(visibleBounds.y - padding) - 1,
              width: Math.round(visibleBounds.width + padding * 2) + 2,
              height: Math.round(visibleBounds.height + padding * 2) + 2,
            };
            
            return (
              <>
                {/* Full background with padding - NO shadow here (shadow goes on content) */}
                <CompositorBackground
                  name="compositor-background"
                  settings={compositorSettings}
                  bounds={compBounds}
                  borderRadius={0}
                  includeShadow={false}
                />
                {/* Shadow around content (inside padding) - matches export behavior */}
                {/* Uses multiple shadow layers like export for realistic effect */}
                {/* The black fill casts the shadow; content drawn on top covers the fill */}
                {compositorSettings.shadowEnabled && (() => {
                  const intensity = compositorSettings.shadowIntensity;
                  const shadowLayers = [
                    { blur: 10, opacity: 0.1 * intensity, offsetY: 2 },
                    { blur: 30, opacity: 0.15 * intensity, offsetY: 8 },
                    { blur: 60, opacity: 0.2 * intensity, offsetY: 16 },
                  ];
                  return shadowLayers.map((layer, i) => (
                    <Rect
                      key={`shadow-${i}`}
                      name={`content-shadow-${i}`}
                      x={Math.round(visibleBounds.x)}
                      y={Math.round(visibleBounds.y)}
                      width={Math.round(visibleBounds.width)}
                      height={Math.round(visibleBounds.height)}
                      fill="black"
                      cornerRadius={compositorSettings.borderRadius}
                      shadowColor="black"
                      shadowBlur={layer.blur}
                      shadowOffsetX={0}
                      shadowOffsetY={layer.offsetY}
                      shadowOpacity={layer.opacity}
                      shadowEnabled={true}
                      listening={false}
                    />
                  ));
                })()}
                {/* Content area background with rounded corners - fills corner gaps */}
                {/* Use rounded bounds with 1px buffer to match clip and prevent sub-pixel gaps */}
                {compositorSettings.borderRadius > 0 && (
                  <CompositorBackground
                    settings={compositorSettings}
                    bounds={{
                      x: Math.round(visibleBounds.x) - 1,
                      y: Math.round(visibleBounds.y) - 1,
                      width: Math.round(visibleBounds.width) + 2,
                      height: Math.round(visibleBounds.height) + 2,
                    }}
                    borderRadius={compositorSettings.borderRadius}
                  />
                )}
              </>
            );
          })()}

          {/* Cropped canvas content - clips to crop bounds when applied */}
          {image && (() => {
            // Always clip to visibleBounds when set (round to avoid sub-pixel artifacts)
            const clipX = Math.round(visibleBounds?.x ?? 0);
            const clipY = Math.round(visibleBounds?.y ?? 0);
            const clipW = Math.round(visibleBounds?.width ?? canvasSize.width);
            const clipH = Math.round(visibleBounds?.height ?? canvasSize.height);
            const radius = compositorSettings.enabled ? compositorSettings.borderRadius : 0;
            
            return (
              <Group
                clipFunc={(ctx) => {
                  if (radius > 0) {
                    // Rounded rectangle clip for compositor border radius
                    const r = Math.min(radius, clipW / 2, clipH / 2);
                    ctx.beginPath();
                    ctx.moveTo(clipX + r, clipY);
                    ctx.lineTo(clipX + clipW - r, clipY);
                    ctx.quadraticCurveTo(clipX + clipW, clipY, clipX + clipW, clipY + r);
                    ctx.lineTo(clipX + clipW, clipY + clipH - r);
                    ctx.quadraticCurveTo(clipX + clipW, clipY + clipH, clipX + clipW - r, clipY + clipH);
                    ctx.lineTo(clipX + r, clipY + clipH);
                    ctx.quadraticCurveTo(clipX, clipY + clipH, clipX, clipY + clipH - r);
                    ctx.lineTo(clipX, clipY + r);
                    ctx.quadraticCurveTo(clipX, clipY, clipX + r, clipY);
                    ctx.closePath();
                  } else {
                    // Simple rect clip - no antialiasing artifacts
                    ctx.rect(clipX, clipY, clipW, clipH);
                  }
                }}
              >
                {/* Checkerboard pattern for transparency - only when compositor disabled */}
                {/* When compositor enabled, the CSS background shows through instead */}
                {checkerPatternImage && !compositorSettings.enabled && (
                  <Rect
                    name="checkerboard"
                    x={clipX}
                    y={clipY}
                    width={clipW}
                    height={clipH}
                    fillPatternImage={checkerPatternImage}
                    fillPatternRepeat="repeat"
                    listening={false}
                  />
                )}
                {/* Inner clip background - prevents dark fringe from anti-aliased clip edges */}
                {/* This ensures edge pixels blend with compositor color, not transparency */}
                {compositorSettings.enabled && (
                  <CompositorBackground
                    settings={compositorSettings}
                    bounds={{
                      x: clipX,
                      y: clipY,
                      width: clipW,
                      height: clipH,
                    }}
                    borderRadius={0}
                  />
                )}
                <Image
                  image={image}
                  x={0}
                  y={0}
                  width={canvasSize.width}
                  height={canvasSize.height}
                  name="background"
                />
                {renderedShapes}
              </Group>
            );
          })()}

          {/* Marquee selection rectangle */}
          {isMarqueeSelecting && (
            <Rect
              x={Math.min(marqueeStart.x, marqueeEnd.x)}
              y={Math.min(marqueeStart.y, marqueeEnd.y)}
              width={Math.abs(marqueeEnd.x - marqueeStart.x)}
              height={Math.abs(marqueeEnd.y - marqueeStart.y)}
              fill="rgba(251, 191, 36, 0.1)"
              stroke="#fbbf24"
              strokeWidth={1 / zoom}
              dash={[4 / zoom, 4 / zoom]}
              listening={false}
            />
          )}

          {/* Crop tool overlay and handles */}
          {selectedTool === 'crop' && canvasBounds && (() => {
            const handleLength = 40 / zoom;
            const handleThickness = 6 / zoom;
            const cornerSize = 12 / zoom;
            
            // Base bounds from store (used for handle initial positions)
            const baseBounds = {
              x: -canvasBounds.imageOffsetX,
              y: -canvasBounds.imageOffsetY,
              width: canvasBounds.width,
              height: canvasBounds.height,
            };
            
            // Use preview during drag for the outline rect only
            const displayBounds = cropPreview || baseBounds;
            
            // Helper to calculate preview from handle drag position
            // Uses displayBounds as base so all handles stay in sync during drag
            const calcPreviewFromDrag = (handleId: string, nodeX: number, nodeY: number) => {
              const left = displayBounds.x;
              const top = displayBounds.y;
              const right = left + displayBounds.width;
              const bottom = top + displayBounds.height;
              
              let newLeft = left, newTop = top, newRight = right, newBottom = bottom;
              
              // Edge handles (account for handle thickness offset)
              if (handleId === 't') newTop = nodeY + handleThickness / 2;
              else if (handleId === 'b') newBottom = nodeY + handleThickness / 2;
              else if (handleId === 'l') newLeft = nodeX + handleThickness / 2;
              else if (handleId === 'r') newRight = nodeX + handleThickness / 2;
              // Corner handles (direct position)
              else {
                if (handleId.includes('l')) newLeft = nodeX;
                if (handleId.includes('r')) newRight = nodeX;
                if (handleId.includes('t')) newTop = nodeY;
                if (handleId.includes('b')) newBottom = nodeY;
              }
              
              // Ensure minimum size
              if (newRight - newLeft < 50) {
                if (handleId.includes('l') || handleId === 'l') newLeft = newRight - 50;
                else newRight = newLeft + 50;
              }
              if (newBottom - newTop < 50) {
                if (handleId.includes('t') || handleId === 't') newTop = newBottom - 50;
                else newBottom = newTop + 50;
              }
              
              return { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop };
            };
            
            // Commit preview to actual bounds on drag end
            const commitBounds = (preview: { x: number; y: number; width: number; height: number }) => {
              // Round to integers to avoid sub-pixel artifacts in export
              setCanvasBounds({
                width: Math.round(preview.width),
                height: Math.round(preview.height),
                imageOffsetX: Math.round(-preview.x),
                imageOffsetY: Math.round(-preview.y),
              });
              setCropPreview(null);
            };
            
            // Edge handles use displayBounds so they move during center/corner drag
            const edgeHandles = [
              { id: 't', x: displayBounds.x + displayBounds.width / 2 - handleLength / 2, y: displayBounds.y - handleThickness / 2, width: handleLength, height: handleThickness, cursor: 'ns-resize' },
              { id: 'b', x: displayBounds.x + displayBounds.width / 2 - handleLength / 2, y: displayBounds.y + displayBounds.height - handleThickness / 2, width: handleLength, height: handleThickness, cursor: 'ns-resize' },
              { id: 'l', x: displayBounds.x - handleThickness / 2, y: displayBounds.y + displayBounds.height / 2 - handleLength / 2, width: handleThickness, height: handleLength, cursor: 'ew-resize' },
              { id: 'r', x: displayBounds.x + displayBounds.width - handleThickness / 2, y: displayBounds.y + displayBounds.height / 2 - handleLength / 2, width: handleThickness, height: handleLength, cursor: 'ew-resize' },
            ];
            
            // Corner handles use displayBounds so they move during edge/center drag
            const cornerHandles = [
              { id: 'tl', x: displayBounds.x, y: displayBounds.y, cursor: 'nwse-resize' },
              { id: 'tr', x: displayBounds.x + displayBounds.width, y: displayBounds.y, cursor: 'nesw-resize' },
              { id: 'bl', x: displayBounds.x, y: displayBounds.y + displayBounds.height, cursor: 'nesw-resize' },
              { id: 'br', x: displayBounds.x + displayBounds.width, y: displayBounds.y + displayBounds.height, cursor: 'nwse-resize' },
            ];
            
            return (
              <>
                {/* Dim area outside crop (Photoshop-style) */}
                <Rect x={-10000} y={-10000} width={20000} height={displayBounds.y + 10000} fill="rgba(0,0,0,0.5)" listening={false} />
                <Rect x={-10000} y={displayBounds.y + displayBounds.height} width={20000} height={10000} fill="rgba(0,0,0,0.5)" listening={false} />
                <Rect x={-10000} y={displayBounds.y} width={displayBounds.x + 10000} height={displayBounds.height} fill="rgba(0,0,0,0.5)" listening={false} />
                <Rect x={displayBounds.x + displayBounds.width} y={displayBounds.y} width={10000} height={displayBounds.height} fill="rgba(0,0,0,0.5)" listening={false} />
                
                {/* Crop bounds outline (updates during drag via preview) */}
                <Rect
                  x={displayBounds.x}
                  y={displayBounds.y}
                  width={displayBounds.width}
                  height={displayBounds.height}
                  stroke="#fbbf24"
                  strokeWidth={2 / zoom}
                  fill="transparent"
                  listening={false}
                />

                {/* Draggable center area - pan the crop region */}
                {/* Hold Shift to constrain to horizontal or vertical axis */}
                <Rect
                  x={baseBounds.x}
                  y={baseBounds.y}
                  width={baseBounds.width}
                  height={baseBounds.height}
                  fill="transparent"
                  draggable
                  onDragStart={(e) => {
                    const node = e.target;
                    setCropDragStart({ x: node.x(), y: node.y() });
                    setCropLockedAxis(null);
                    pauseHistory();
                  }}
                  onDragMove={(e) => {
                    const node = e.target;
                    let newX = node.x();
                    let newY = node.y();
                    
                    // Shift+drag: constrain to axis
                    if (isShiftHeld && cropDragStart) {
                      const dx = Math.abs(newX - cropDragStart.x);
                      const dy = Math.abs(newY - cropDragStart.y);
                      
                      // Lock to axis once movement exceeds threshold (prevents jitter)
                      if (!cropLockedAxis && (dx > 5 || dy > 5)) {
                        setCropLockedAxis(dx > dy ? 'x' : 'y');
                      }
                      
                      // Apply constraint
                      if (cropLockedAxis === 'x') {
                        newY = cropDragStart.y;
                        node.y(newY);
                      } else if (cropLockedAxis === 'y') {
                        newX = cropDragStart.x;
                        node.x(newX);
                      }
                    }
                    
                    setCropPreview({
                      x: newX,
                      y: newY,
                      width: baseBounds.width,
                      height: baseBounds.height,
                    });
                  }}
                  onDragEnd={(e) => {
                    const node = e.target;
                    let finalX = node.x();
                    let finalY = node.y();
                    
                    // Apply final constraint if Shift was held
                    if (isShiftHeld && cropDragStart && cropLockedAxis) {
                      if (cropLockedAxis === 'x') {
                        finalY = cropDragStart.y;
                      } else if (cropLockedAxis === 'y') {
                        finalX = cropDragStart.x;
                      }
                    }
                    
                    commitBounds({
                      x: finalX,
                      y: finalY,
                      width: baseBounds.width,
                      height: baseBounds.height,
                    });
                    setCropDragStart(null);
                    setCropLockedAxis(null);
                    resumeHistory();
                  }}
                  onMouseEnter={(e) => {
                    const container = e.target.getStage()?.container();
                    if (container) container.style.cursor = 'move';
                  }}
                  onMouseLeave={(e) => {
                    const container = e.target.getStage()?.container();
                    if (container) container.style.cursor = 'default';
                  }}
                />

                {/* Edge handles - position from store, Konva controls during drag */}
                {edgeHandles.map(handle => (
                  <Rect
                    key={handle.id}
                    x={handle.x}
                    y={handle.y}
                    width={handle.width}
                    height={handle.height}
                    fill="#fbbf24"
                    cornerRadius={2 / zoom}
                    draggable
                    dragBoundFunc={(pos) => {
                      // Constrain to single axis
                      if (handle.id === 't' || handle.id === 'b') {
                        return { x: handle.x * zoom + position.x, y: pos.y };
                      } else {
                        return { x: pos.x, y: handle.y * zoom + position.y };
                      }
                    }}
                    onDragStart={() => pauseHistory()}
                    onDragMove={(e) => {
                      // Update preview for visual feedback (outline follows)
                      setCropPreview(calcPreviewFromDrag(handle.id, e.target.x(), e.target.y()));
                    }}
                    onDragEnd={(e) => {
                      // Commit to store on release
                      const preview = calcPreviewFromDrag(handle.id, e.target.x(), e.target.y());
                      commitBounds(preview);
                      resumeHistory();
                    }}
                    onMouseEnter={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = handle.cursor;
                    }}
                    onMouseLeave={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'default';
                    }}
                  />
                ))}
                
                {/* Corner handles */}
                {cornerHandles.map(handle => (
                  <Circle
                    key={handle.id}
                    x={handle.x}
                    y={handle.y}
                    radius={cornerSize / 2}
                    fill="#fbbf24"
                    stroke="#000"
                    strokeWidth={1 / zoom}
                    draggable
                    onDragStart={() => pauseHistory()}
                    onDragMove={(e) => {
                      setCropPreview(calcPreviewFromDrag(handle.id, e.target.x(), e.target.y()));
                    }}
                    onDragEnd={(e) => {
                      const preview = calcPreviewFromDrag(handle.id, e.target.x(), e.target.y());
                      commitBounds(preview);
                      resumeHistory();
                    }}
                    onMouseEnter={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = handle.cursor;
                    }}
                    onMouseLeave={(e) => {
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'default';
                    }}
                  />
                ))}
              </>
            );
          })()}

          {/* Transparent background for multi-select group dragging (enables drag from empty space) */}
          {selectionBounds && selectedTool === 'select' && (
            <Rect
              x={selectionBounds.x}
              y={selectionBounds.y}
              width={selectionBounds.width}
              height={selectionBounds.height}
              fill="transparent"
              draggable
              onDragStart={() => pauseHistory()}
              onDragEnd={(e) => {
                const dx = e.target.x() - selectionBounds.x;
                const dy = e.target.y() - selectionBounds.y;
                e.target.position({ x: selectionBounds.x, y: selectionBounds.y });

                const updatedShapes = shapes.map((shape) => {
                  if (!selectedIds.includes(shape.id)) return shape;

                  if (shape.type === 'pen' && shape.points && shape.points.length >= 2) {
                    const newPoints = shape.points.map((val, i) =>
                      i % 2 === 0 ? val + dx : val + dy
                    );
                    return { ...shape, points: newPoints };
                  }

                  return {
                    ...shape,
                    x: (shape.x ?? 0) + dx,
                    y: (shape.y ?? 0) + dy,
                  };
                });
                onShapesChange(updatedShapes);
                resumeHistory();
              }}
            />
          )}

          <Transformer
            ref={transformerRef}
            keepRatio={isShiftHeld}
            enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'middle-left', 'middle-right']}
            boundBoxFunc={(oldBox, newBox) => {
              if (newBox.width < 5 || newBox.height < 5) {
                return oldBox;
              }
              return newBox;
            }}
            onTransformStart={() => pauseHistory()}
          />
        </Layer>
      </Stage>

      {/* Crop Controls - bottom left */}
      {selectedTool === 'crop' && canvasBounds && (
        <div className="absolute bottom-4 left-4 flex items-center gap-2 glass rounded-lg p-1.5 animate-fade-in">
          {/* Cancel */}
          <button
            onClick={() => {
              resetCanvasBounds();
              onToolChange('select');
            }}
            className="tool-button h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/20"
            title="Cancel crop (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
          
          {/* Dimensions */}
          <span className="px-2 text-sm font-mono text-[var(--text-primary)]">
            {Math.round(cropPreview?.width ?? canvasBounds.width)} × {Math.round(cropPreview?.height ?? canvasBounds.height)}
          </span>
          
          {/* Reset - only if modified */}
          {originalImageSize && (
            canvasBounds.width !== originalImageSize.width ||
            canvasBounds.height !== originalImageSize.height ||
            canvasBounds.imageOffsetX !== 0 ||
            canvasBounds.imageOffsetY !== 0
          ) && (
            <button
              onClick={resetCanvasBounds}
              className="px-2 py-1 text-xs rounded bg-[var(--obsidian-hover)] hover:bg-[var(--obsidian-active)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title="Reset to original"
            >
              Reset
            </button>
          )}
          
          {/* Commit */}
          <button
            onClick={() => onToolChange('select')}
            className="tool-button h-8 w-8 text-green-400 hover:text-green-300 hover:bg-green-500/20"
            title="Apply crop (Enter)"
          >
            <Check className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Inline Text Editor Overlay */}
      {editingTextId && (() => {
        const pos = getTextareaPosition();
        if (!pos) return null;
        
        return (
          <textarea
            ref={textareaRef}
            autoFocus
            value={editingTextValue}
            onChange={(e) => setEditingTextValue(e.target.value)}
            onBlur={handleSaveTextEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSaveTextEdit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleCancelTextEdit();
              }
            }}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              fontSize: pos.fontSize,
              color: pos.color,
              fontFamily: 'sans-serif',
              border: 'none',
              background: 'transparent',
              outline: 'none',
              resize: 'none',
              overflow: 'hidden',
              padding: 0,
              margin: 0,
              minWidth: '100px',
              minHeight: '1.5em',
              zIndex: 1000,
              lineHeight: 1.2,
            }}
          />
        );
      })()}

      {/* Zoom Controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 glass rounded-lg p-1.5 animate-fade-in">
        <button
          onClick={handleZoomOut}
          className="tool-button h-8 w-8"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <button
          onClick={handleFitToSize}
          className="px-2 h-8 rounded-md text-xs font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)] transition-colors min-w-[52px]"
          title="Fit to Size"
        >
          {Math.round(zoom * 100)}%
        </button>

        <button
          onClick={handleZoomIn}
          className="tool-button h-8 w-8"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-[var(--border-default)] mx-1" />

        <button
          onClick={handleActualSize}
          className={`tool-button h-8 w-8 ${zoom === 1 ? 'active' : ''}`}
          title="Actual Size (100%)"
        >
          <Square className="w-4 h-4" />
        </button>

        <button
          onClick={handleFitToSize}
          className="tool-button h-8 w-8"
          title="Fit to Window"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
