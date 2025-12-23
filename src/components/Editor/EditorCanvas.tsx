import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Stage, Layer, Image, Rect, Group, Transformer } from 'react-konva';
import Konva from 'konva';
import useImage from 'use-image';
import { Loader2 } from 'lucide-react';
import { useFastImage } from '../../hooks/useFastImage';
import type { Tool, CanvasShape } from '../../types';
import { useEditorStore, takeSnapshot, commitSnapshot } from '../../stores/editorStore';
import { CompositorBackground } from './CompositorBackground';

// Hooks
import { useCanvasNavigation } from '../../hooks/useCanvasNavigation';
import { useShapeDrawing } from '../../hooks/useShapeDrawing';
import { useShapeTransform } from '../../hooks/useShapeTransform';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useMarqueeSelection } from '../../hooks/useMarqueeSelection';
import { useCropTool } from '../../hooks/useCropTool';
import { useTextEditing } from '../../hooks/useTextEditing';
import { useMiddleMousePan } from '../../hooks/useMiddleMousePan';

// Components
import { ShapeRenderer } from './shapes';
import {
  MarqueeSelection,
  SelectionBoundsRect,
  ZoomControls,
  CropControls,
  TextEditorOverlay,
  CropOverlay,
} from './overlays';

// Utility functions
import { getSelectionBounds, getVisibleBounds } from '../../utils/canvasGeometry';

// Checkerboard pattern for transparency (softer for light theme)
const CHECKER_SIZE = 10;
const CHECKER_LIGHT = '#f5f5f5';
const CHECKER_DARK = '#e8e8e8';

const createCheckerPattern = (): HTMLImageElement => {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_SIZE * 2;
  canvas.height = CHECKER_SIZE * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = CHECKER_LIGHT;
  ctx.fillRect(0, 0, CHECKER_SIZE * 2, CHECKER_SIZE * 2);
  ctx.fillStyle = CHECKER_DARK;
  ctx.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  ctx.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  const img = new window.Image();
  img.src = canvas.toDataURL();
  return img;
};

interface EditorCanvasProps {
  imageData: string;
  selectedTool: Tool;
  onToolChange: (tool: Tool) => void;
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  shapes: CanvasShape[];
  onShapesChange: (shapes: CanvasShape[]) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
}

export const EditorCanvas: React.FC<EditorCanvasProps> = ({
  imageData,
  selectedTool,
  onToolChange,
  strokeColor,
  fillColor,
  strokeWidth,
  shapes,
  onShapesChange,
  stageRef,
}) => {
  // Refs
  const layerRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const compositorBgRef = useRef<HTMLDivElement>(null);

  // Track device pixel ratio for crisp HiDPI rendering
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);

  // Update pixelRatio when DPI changes (e.g., window moved between monitors)
  useEffect(() => {
    const updatePixelRatio = () => {
      const newRatio = window.devicePixelRatio || 1;
      if (newRatio !== pixelRatio) {
        setPixelRatio(newRatio);
      }
    };

    // Listen for DPI changes
    const mediaQuery = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    mediaQuery.addEventListener('change', updatePixelRatio);

    return () => {
      mediaQuery.removeEventListener('change', updatePixelRatio);
    };
  }, [pixelRatio]);


  // Store state
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


  // Load image - use fast path for RGBA files, standard path for base64
  const isRgbaFile = imageData.endsWith('.rgba');
  const imageUrl = isRgbaFile ? null : `data:image/png;base64,${imageData}`;

  // Use fast image hook for RGBA files (skips PNG encoding entirely!)
  // Returns HTMLCanvasElement for RGBA, which Konva supports directly
  const [fastImage, fastImageStatus] = useFastImage(isRgbaFile ? imageData : null);
  // Use standard hook for base64 data
  const [standardImage, standardImageStatus] = useImage(imageUrl ?? '');

  // Use whichever image is loaded (Konva accepts both HTMLImageElement and HTMLCanvasElement)
  const image = (isRgbaFile ? fastImage : standardImage) as HTMLImageElement | undefined;
  const imageStatus = isRgbaFile ? fastImageStatus : standardImageStatus;
  const isImageLoading = imageStatus === 'loading';

  // Checkerboard pattern for transparency
  const [checkerPatternImage] = React.useState(() => createCheckerPattern());

  // Navigation hook
  const navigation = useCanvasNavigation({
    image,
    imageData,
    compositorSettings,
    canvasBounds,
    setCanvasBounds,
    setOriginalImageSize,
    selectedTool,
    compositorBgRef,
  });


  // Keyboard shortcuts hook
  const { isShiftHeld } = useKeyboardShortcuts({
    selectedIds,
    shapes,
    onShapesChange,
    setSelectedIds,
  });

  // Middle mouse panning hook
  const pan = useMiddleMousePan({
    position: navigation.position,
    setPosition: (pos) => navigation.setPosition(pos),
    containerRef: navigation.containerRef as React.RefObject<HTMLDivElement>,
    stageRef,
    compositorBgRef,
    // Pass refs for coordinated CSS transforms with zoom
    renderedPositionRef: navigation.renderedPositionRef,
    renderedZoomRef: navigation.renderedZoomRef,
    transformCoeffsRef: navigation.transformCoeffsRef,
  });

  // Text editing hook
  const textEditing = useTextEditing({
    shapes,
    onShapesChange,
    zoom: navigation.zoom,
    position: navigation.position,
    containerRef: navigation.containerRef,
  });

  // Shape transform hook
  const transform = useShapeTransform({
    shapes,
    onShapesChange,
    selectedIds,
    setSelectedIds,
  });

  // Font size state for text tool
  const fontSize = useEditorStore((state) => state.fontSize);

  // Shape drawing hook
  const drawing = useShapeDrawing({
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
    getCanvasPosition: navigation.getCanvasPosition,
    onTextShapeCreated: (shapeId) => {
      // Open text editor immediately after drawing text box
      const shape = shapes.find(s => s.id === shapeId);
      if (shape) {
        textEditing.startEditing(shapeId, shape.text || '');
      }
    },
  });

  // Marquee selection hook
  const marquee = useMarqueeSelection({
    shapes,
    setSelectedIds,
  });

  // Crop tool hook
  const crop = useCropTool({
    canvasBounds,
    setCanvasBounds,
    isShiftHeld,
    originalImageSize,
  });

  // Visible bounds for clipping
  const visibleBounds = useMemo(() => {
    if (!image) return null;
    return getVisibleBounds(
      image,
      canvasBounds,
      selectedTool === 'crop'
    );
  }, [canvasBounds, image, selectedTool]);

  // Selection bounds for group drag
  const selectionBounds = useMemo(() => {
    if (selectedIds.length <= 1) return null;
    return getSelectionBounds(shapes, selectedIds);
  }, [shapes, selectedIds]);

  // Check if any selected shape requires proportional scaling
  const hasProportionalShape = useMemo(() => {
    return selectedIds.some((id) => {
      const shape = shapes.find((s) => s.id === id);
      return shape?.type === 'step';
    });
  }, [selectedIds, shapes]);

  // Attach transformer to selected shapes
  useEffect(() => {
    if (!transformerRef.current || !layerRef.current) return;

    // Hide transformer while drawing or editing text
    if (drawing.isDrawing || textEditing.editingTextId) {
      transformerRef.current.nodes([]);
      transformerRef.current.getLayer()?.batchDraw();
      return;
    }

    // Exclude arrows (they use custom endpoint handles)
    const nodes = selectedIds
      .filter((id) => {
        const shape = shapes.find((s) => s.id === id);
        return shape && shape.type !== 'arrow';
      })
      .map((id) => layerRef.current!.findOne(`#${id}`))
      .filter((node): node is Konva.Node => node !== null && node !== undefined);

    transformerRef.current.nodes(nodes);
    transformerRef.current.getLayer()?.batchDraw();
  }, [selectedIds, shapes, drawing.isDrawing, textEditing.editingTextId]);

  // Handle mouse events
  const handleMouseDown = React.useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Ignore if middle mouse button
      if (e.evt.button === 1) return;

      // Handle drawing tools
      if (drawing.handleDrawingMouseDown(e)) {
        return;
      }

      // Handle crop tool
      if (selectedTool === 'crop') return;

      // Handle select tool - start marquee or click on stage/image
      if (selectedTool === 'select') {
        // Consider clicking on stage or background image as "empty"
        const clickedOnStage = e.target === e.target.getStage();
        const clickedOnBackground = e.target.name() === 'background';
        const clickedOnEmpty = clickedOnStage || clickedOnBackground;

        if (clickedOnEmpty) {
          setSelectedIds([]);
          const stage = stageRef.current;
          if (stage) {
            const screenPos = stage.getPointerPosition();
            if (screenPos) {
              const pos = navigation.getCanvasPosition(screenPos);
              marquee.startMarquee(pos);
            }
          }
        }
      }
    },
    [drawing, selectedTool, setSelectedIds, marquee, stageRef, navigation]
  );

  const handleMouseMove = React.useCallback(
    (_e: Konva.KonvaEventObject<MouseEvent>) => {
      const stage = stageRef.current;
      if (!stage) return;

      const screenPos = stage.getPointerPosition();
      if (!screenPos) return;

      const pos = navigation.getCanvasPosition(screenPos);

      // Drawing move
      if (drawing.isDrawing) {
        drawing.handleDrawingMouseMove(pos);
        return;
      }

      // Marquee move
      if (marquee.isMarqueeSelecting) {
        marquee.updateMarquee(pos);
      }
    },
    [drawing, marquee, navigation, stageRef]
  );

  const handleMouseUp = React.useCallback(() => {
    // Finish drawing
    if (drawing.isDrawing) {
      drawing.handleDrawingMouseUp();
      return;
    }

    // Finish marquee
    if (marquee.isMarqueeSelecting) {
      marquee.finishMarquee();
    }
  }, [drawing, marquee]);

  // Composition box dimensions (for CSS preview background)
  const compositionBox = useMemo(() => {
    if (!compositorSettings.enabled || !visibleBounds) return null;

    const contentWidth = visibleBounds.width;
    const contentHeight = visibleBounds.height;

    // Padding is now in pixels - just scale by zoom
    const padding = compositorSettings.padding * navigation.zoom;

    const left = navigation.position.x + visibleBounds.x * navigation.zoom - padding - 1;
    const top = navigation.position.y + visibleBounds.y * navigation.zoom - padding - 1;
    const width = contentWidth * navigation.zoom + padding * 2 + 2;
    const height = contentHeight * navigation.zoom + padding * 2 + 2;

    return { width, height, left, top };
  }, [compositorSettings.enabled, compositorSettings.padding, visibleBounds, navigation.zoom, navigation.position]);

  // Base composition size for consistent background scaling
  const baseCompositionSize = useMemo(() => {
    if (!visibleBounds) return { width: 0, height: 0 };

    const padding = compositorSettings.padding;

    return {
      width: visibleBounds.width + padding * 2,
      height: visibleBounds.height + padding * 2,
    };
  }, [visibleBounds, compositorSettings.padding]);

  // Background style for composition box
  const compositionBackgroundStyle = useMemo((): React.CSSProperties => {
    if (!compositorSettings.enabled) return {};

    let backgroundColor: string | undefined;
    let backgroundImage: string | undefined;
    let backgroundSize: string = 'cover';

    switch (compositorSettings.backgroundType) {
      case 'solid':
        backgroundColor = compositorSettings.backgroundColor;
        break;
      case 'gradient': {
        const gradientStops = compositorSettings.gradientStops
          .map((s) => `${s.color} ${s.position}%`)
          .join(', ');
        backgroundImage = `linear-gradient(${compositorSettings.gradientAngle}deg, ${gradientStops})`;
        break;
      }
      case 'image':
        backgroundImage = compositorSettings.backgroundImage
          ? `url(${compositorSettings.backgroundImage})`
          : undefined;
        backgroundColor = compositorSettings.backgroundImage ? undefined : '#1a1a2e';
        if (compositorSettings.backgroundImage && baseCompositionSize.width > 0) {
          const bgWidth = baseCompositionSize.width * navigation.zoom;
          const bgHeight = baseCompositionSize.height * navigation.zoom;
          backgroundSize = `${bgWidth}px ${bgHeight}px`;
        }
        break;
      default:
        backgroundColor = '#1a1a2e';
    }

    return {
      backgroundColor,
      backgroundImage,
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
    navigation.zoom,
  ]);

  return (
    <div
      ref={navigation.containerRef}
      className="h-full w-full overflow-hidden relative"
      style={{
        backgroundColor: 'var(--polar-mist)',
        cursor: pan.isPanning ? 'grabbing' : 'default',
      }}
      onMouseDown={pan.handleMiddleMouseDown}
      onMouseMove={pan.handleMiddleMouseMove}
      onMouseUp={pan.handleMiddleMouseUp}
      onMouseLeave={pan.handleMiddleMouseUp}
    >
      {/* Loading overlay - shown while image loads */}
      {isImageLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-50 bg-[var(--polar-mist)]">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-[var(--coral-400)] animate-spin" />
            <span className="text-sm text-[var(--ink-subtle)]">Loading image...</span>
          </div>
        </div>
      )}

      {/* Canvas content wrapper - fades in when ready to avoid position flash */}
      <div
        className="absolute inset-0 transition-opacity duration-150"
        style={{
          opacity: navigation.isReady && !isImageLoading ? 1 : 0,
          pointerEvents: navigation.isReady && !isImageLoading ? 'auto' : 'none',
        }}
      >
      {/* Composition Preview Background */}
      {compositorSettings.enabled && compositionBox && visibleBounds && (
        <div
          ref={compositorBgRef}
          className="absolute pointer-events-none"
          style={{
            left: compositionBox.left,
            top: compositionBox.top,
            width: compositionBox.width,
            height: compositionBox.height,
            zIndex: 0,
            willChange: 'transform',
            contain: 'layout style paint',
            ...compositionBackgroundStyle,
          }}
        >
          {compositorSettings.shadowEnabled && (() => {
            const intensity = compositorSettings.shadowIntensity;
            const contentLeft = navigation.position.x + visibleBounds.x * navigation.zoom - compositionBox.left;
            const contentTop = navigation.position.y + visibleBounds.y * navigation.zoom - compositionBox.top;
            const contentWidth = visibleBounds.width * navigation.zoom;
            const contentHeight = visibleBounds.height * navigation.zoom;

            return (
              <div
                style={{
                  position: 'absolute',
                  left: contentLeft,
                  top: contentTop,
                  width: contentWidth,
                  height: contentHeight,
                  borderRadius: compositorSettings.borderRadius * navigation.zoom,
                  boxShadow: [
                    `0 ${2 * intensity}px ${10 * intensity}px rgba(0,0,0,${0.15 * intensity})`,
                    `0 ${8 * intensity}px ${30 * intensity}px rgba(0,0,0,${0.25 * intensity})`,
                    `0 ${16 * intensity}px ${60 * intensity}px rgba(0,0,0,${0.35 * intensity})`,
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
        width={navigation.containerSize.width}
        height={navigation.containerSize.height}
        pixelRatio={pixelRatio}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={navigation.handleWheel}
        scaleX={navigation.zoom}
        scaleY={navigation.zoom}
        x={navigation.position.x}
        y={navigation.position.y}
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
              fill="rgba(0,0,0,0.15)"
              cornerRadius={4}
              shadowColor="black"
              shadowBlur={24}
              shadowOpacity={0.25}
              listening={false}
            />
          )}

          {/* Compositor background (with padding) */}
          {compositorSettings.enabled && visibleBounds && baseCompositionSize.width > 0 && (() => {
            // Padding is now in pixels - use directly
            const padding = compositorSettings.padding;

            const compBounds = {
              x: visibleBounds.x - padding - 1,
              y: visibleBounds.y - padding - 1,
              width: visibleBounds.width + padding * 2 + 2,
              height: visibleBounds.height + padding * 2 + 2,
            };

            return (
              <>
                <CompositorBackground
                  name="compositor-background"
                  settings={compositorSettings}
                  bounds={compBounds}
                  borderRadius={0}
                  includeShadow={false}
                />
                {compositorSettings.shadowEnabled && (() => {
                  const intensity = compositorSettings.shadowIntensity;
                  const shadowLayers = [
                    { blur: 10, opacity: 0.15 * intensity, offsetY: 2 },
                    { blur: 30, opacity: 0.25 * intensity, offsetY: 8 },
                    { blur: 60, opacity: 0.35 * intensity, offsetY: 16 },
                  ];
                  return shadowLayers.map((layer, i) => (
                    <Rect
                      key={`shadow-${i}`}
                      name={`content-shadow-${i}`}
                      x={visibleBounds.x}
                      y={visibleBounds.y}
                      width={visibleBounds.width}
                      height={visibleBounds.height}
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
                {compositorSettings.borderRadius > 0 && (
                  <CompositorBackground
                    settings={compositorSettings}
                    bounds={{
                      x: visibleBounds.x - 2,
                      y: visibleBounds.y - 2,
                      width: visibleBounds.width + 4,
                      height: visibleBounds.height + 4,
                    }}
                    borderRadius={compositorSettings.borderRadius + 2}
                  />
                )}
              </>
            );
          })()}

          {/* Cropped canvas content */}
          {image && (() => {
            const clipX = Math.round(visibleBounds?.x ?? 0);
            const clipY = Math.round(visibleBounds?.y ?? 0);
            const clipW = Math.round(visibleBounds?.width ?? navigation.canvasSize.width);
            const clipH = Math.round(visibleBounds?.height ?? navigation.canvasSize.height);
            const radius = compositorSettings.enabled ? compositorSettings.borderRadius : 0;

            return (
              <Group
                clipFunc={(ctx) => {
                  if (radius > 0) {
                    // Use arcTo for circular corners (matches Konva Rect cornerRadius)
                    const r = Math.min(radius, clipW / 2, clipH / 2);
                    ctx.beginPath();
                    ctx.moveTo(clipX + r, clipY);
                    ctx.arcTo(clipX + clipW, clipY, clipX + clipW, clipY + clipH, r);
                    ctx.arcTo(clipX + clipW, clipY + clipH, clipX, clipY + clipH, r);
                    ctx.arcTo(clipX, clipY + clipH, clipX, clipY, r);
                    ctx.arcTo(clipX, clipY, clipX + clipW, clipY, r);
                    ctx.closePath();
                  } else {
                    ctx.rect(clipX, clipY, clipW, clipH);
                  }
                }}
              >
                {/* Checkerboard pattern for transparency */}
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
                {/* Inner clip background */}
                {compositorSettings.enabled && (
                  <CompositorBackground
                    settings={compositorSettings}
                    bounds={{ x: clipX, y: clipY, width: clipW, height: clipH }}
                    borderRadius={0}
                  />
                )}
                <Image
                  image={image}
                  x={0}
                  y={0}
                  width={navigation.canvasSize.width}
                  height={navigation.canvasSize.height}
                  name="background"
                />

                {/* Render shapes */}
                <ShapeRenderer
                  shapes={shapes}
                  selectedIds={selectedIds}
                  selectedTool={selectedTool}
                  zoom={navigation.zoom}
                  sourceImage={image}
                  isDrawing={drawing.isDrawing}
                  isPanning={pan.isPanning}
                  editingTextId={textEditing.editingTextId}
                  onShapeClick={transform.handleShapeClick}
                  onShapeSelect={(id) => setSelectedIds([id])}
                  onDragStart={transform.handleShapeDragStart}
                  onDragEnd={transform.handleShapeDragEnd}
                  onArrowDragEnd={transform.handleArrowDragEnd}
                  onTransformStart={transform.handleTransformStart}
                  onTransformEnd={transform.handleTransformEnd}
                  onArrowEndpointDragEnd={transform.handleArrowEndpointDragEnd}
                  onTextStartEdit={textEditing.startEditing}
                />
              </Group>
            );
          })()}

          {/* Marquee selection rectangle */}
          <MarqueeSelection
            isActive={marquee.isMarqueeSelecting}
            start={marquee.marqueeStart}
            end={marquee.marqueeEnd}
            zoom={navigation.zoom}
          />

          {/* Crop tool overlay */}
          {selectedTool === 'crop' && canvasBounds && (
            <CropOverlay
              displayBounds={crop.getDisplayBounds()}
              baseBounds={crop.getBaseBounds()}
              zoom={navigation.zoom}
              position={navigation.position}
              isShiftHeld={isShiftHeld}
              isPanning={pan.isPanning}
              snapGuides={crop.snapGuides}
              onCenterDragStart={crop.handleCenterDragStart}
              onCenterDragMove={crop.handleCenterDragMove}
              onCenterDragEnd={crop.handleCenterDragEnd}
              onEdgeDragStart={crop.handleEdgeDragStart}
              onEdgeDragMove={crop.handleEdgeDragMove}
              onEdgeDragEnd={crop.handleEdgeDragEnd}
              onCornerDragStart={crop.handleCornerDragStart}
              onCornerDragMove={crop.handleCornerDragMove}
              onCornerDragEnd={crop.handleCornerDragEnd}
            />
          )}

          {/* Selection bounds rect for group drag */}
          {selectionBounds && selectedTool === 'select' && (
            <SelectionBoundsRect
              bounds={selectionBounds}
              isDraggable={true}
              selectedIds={selectedIds}
              layerRef={layerRef}
              onDragStart={() => takeSnapshot()}
              onDragEnd={(dx, dy) => {
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
                commitSnapshot();
              }}
            />
          )}

          <Transformer
            ref={transformerRef}
            keepRatio={isShiftHeld || hasProportionalShape}
            enabledAnchors={hasProportionalShape
              ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
              : ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'middle-left', 'middle-right']
            }
            boundBoxFunc={(oldBox, newBox) => {
              if (newBox.width < 5 || newBox.height < 5) {
                return oldBox;
              }
              return newBox;
            }}
            onTransformStart={() => takeSnapshot()}
            onTransform={() => {
              // For text shapes, convert scale to width/height in real-time to prevent stretching
              const nodes = transformerRef.current?.nodes() || [];
              nodes.forEach(node => {
                const shape = shapes.find(s => s.id === node.id());
                if (shape?.type === 'text') {
                  const scaleX = node.scaleX();
                  const scaleY = node.scaleY();

                  // Read current dimensions from node (not React state)
                  const currentWidth = node.width();
                  const currentHeight = node.height();

                  // Allow negative dimensions for crossover (like rect behavior)
                  // Don't clamp to minimum during drag - only at the end
                  const newWidth = currentWidth * scaleX;
                  const newHeight = currentHeight * scaleY;

                  // Update Group dimensions and reset scale
                  node.width(newWidth);
                  node.height(newHeight);
                  node.scaleX(1);
                  node.scaleY(1);

                  // Also update child elements with absolute values for rendering
                  const group = node as Konva.Group;
                  const border = group.findOne('.text-box-border');
                  const textContent = group.findOne('.text-content');
                  const absWidth = Math.abs(newWidth);
                  const absHeight = Math.abs(newHeight);
                  if (border) {
                    border.width(absWidth);
                    border.height(absHeight);
                    // Offset for negative dimensions
                    border.x(newWidth < 0 ? newWidth : 0);
                    border.y(newHeight < 0 ? newHeight : 0);
                  }
                  if (textContent) {
                    textContent.width(absWidth);
                    textContent.height(absHeight);
                    textContent.x(newWidth < 0 ? newWidth : 0);
                    textContent.y(newHeight < 0 ? newHeight : 0);
                  }
                }
              });
            }}
          />
        </Layer>
      </Stage>
      </div>

      {/* Crop Controls */}
      {selectedTool === 'crop' && canvasBounds && (() => {
        const displayBounds = crop.getDisplayBounds();
        return (
          <CropControls
            width={displayBounds.width}
            height={displayBounds.height}
            isModified={
              originalImageSize !== null && (
                canvasBounds.width !== originalImageSize.width ||
                canvasBounds.height !== originalImageSize.height ||
                canvasBounds.imageOffsetX !== 0 ||
                canvasBounds.imageOffsetY !== 0
              )
            }
            onCancel={() => {
              resetCanvasBounds();
              onToolChange('select');
            }}
            onReset={resetCanvasBounds}
            onCommit={() => onToolChange('select')}
          />
        );
      })()}

      {/* Inline Text Editor */}
      {textEditing.editingTextId && (
        <TextEditorOverlay
          position={textEditing.getTextareaPosition()}
          value={textEditing.editingTextValue}
          onChange={textEditing.handleTextChange}
          onSave={textEditing.handleSaveTextEdit}
          onCancel={textEditing.handleCancelTextEdit}
        />
      )}

      {/* Zoom Controls */}
      <ZoomControls
        zoom={navigation.zoom}
        onZoomIn={navigation.handleZoomIn}
        onZoomOut={navigation.handleZoomOut}
        onFitToSize={navigation.handleFitToSize}
        onActualSize={navigation.handleActualSize}
      />
    </div>
  );
};
