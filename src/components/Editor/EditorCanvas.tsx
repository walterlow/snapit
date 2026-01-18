import React, { useRef, useMemo, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { Stage, Layer, Image, Rect, Group, Transformer } from 'react-konva';
import Konva from 'konva';
import useImage from 'use-image';
import { Loader2 } from 'lucide-react';
import { useFastImage } from '../../hooks/useFastImage';
import type { Tool, CanvasShape } from '../../types';
import { useEditorStore } from '../../stores/editorStore';
import { useEditorHistory } from '../../hooks/useEditorHistory';
import { CompositorBackground } from './CompositorBackground';
import { CompositorCssPreview } from './CompositorCssPreview';
import { KonvaBackgroundLayer } from './KonvaBackgroundLayer';

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
// Direct imports avoid barrel file bundling overhead
import { MarqueeSelection } from './overlays/MarqueeSelection';
import { SelectionBoundsRect } from './overlays/SelectionBoundsRect';
import { ZoomControls } from './overlays/ZoomControls';
import { CropControls } from './overlays/CropControls';
import { TextEditorOverlay } from './overlays/TextEditorOverlay';
import { CropOverlay } from './overlays/CropOverlay';

// Utility functions
import { getSelectionBounds, getVisibleBounds, createCheckerPattern } from '../../utils/canvasGeometry';

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

/** Ref handle exposed by EditorCanvas for imperative operations */
export interface EditorCanvasRef {
  /** Force-finalize any in-progress drawing and return the current shapes.
   *  Call this before saving to ensure no shapes are lost to race conditions. */
  finalizeAndGetShapes: () => CanvasShape[];
}

export const EditorCanvas = forwardRef<EditorCanvasRef, EditorCanvasProps>(({
  imageData,
  selectedTool,
  onToolChange,
  strokeColor,
  fillColor,
  strokeWidth,
  shapes,
  onShapesChange,
  stageRef,
}, ref) => {
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

  // Context-aware history actions for undo/redo
  const history = useEditorHistory();

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
    recordAction: history.recordAction,
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
    history,
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
    history,
  });

  // Expose imperative methods via ref
  useImperativeHandle(ref, () => ({
    finalizeAndGetShapes: drawing.finalizeAndGetShapes,
  }), [drawing.finalizeAndGetShapes]);

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
    history,
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

  // Disable image smoothing for crisp 1:1 pixel rendering at 100% zoom
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    const handleBeforeDraw = () => {
      const ctx = layer.getCanvas().getContext()._context;
      // Disable smoothing when at or near 100% zoom for pixel-perfect rendering
      ctx.imageSmoothingEnabled = navigation.zoom < 0.95 || navigation.zoom > 1.05;
    };

    layer.on('beforeDraw', handleBeforeDraw);
    return () => {
      layer.off('beforeDraw', handleBeforeDraw);
    };
  }, [navigation.zoom]);

  // Attach transformer to selected shapes
  useEffect(() => {
    if (!transformerRef.current || !layerRef.current) return;

    // Hide transformer while drawing, editing text, or not in select mode
    if (drawing.isDrawing || textEditing.editingTextId || selectedTool !== 'select') {
      transformerRef.current.nodes([]);
      transformerRef.current.getLayer()?.batchDraw();
      return;
    }

    // Exclude arrows and lines (they use custom endpoint handles)
    const nodes = selectedIds
      .filter((id) => {
        const shape = shapes.find((s) => s.id === id);
        return shape && shape.type !== 'arrow' && shape.type !== 'line';
      })
      .map((id) => layerRef.current!.findOne(`#${id}`))
      .filter((node): node is Konva.Node => node !== null && node !== undefined);

    transformerRef.current.nodes(nodes);
    transformerRef.current.getLayer()?.batchDraw();
  }, [selectedIds, shapes, drawing.isDrawing, textEditing.editingTextId, selectedTool]);

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
      {compositionBox && visibleBounds && (
        <CompositorCssPreview
          previewRef={compositorBgRef}
          settings={compositorSettings}
          compositionBox={compositionBox}
          contentBounds={visibleBounds}
          zoom={navigation.zoom}
          position={navigation.position}
          backgroundStyle={compositionBackgroundStyle}
        />
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
          {/* Background layer: shadow (disabled compositor) or full compositor background */}
          <KonvaBackgroundLayer
            settings={compositorSettings}
            visibleBounds={visibleBounds}
            baseCompositionSize={baseCompositionSize}
          />

          {/* Cropped canvas content - only render when visibleBounds is ready */}
          {image && visibleBounds && (() => {
            const clipX = Math.round(visibleBounds.x);
            const clipY = Math.round(visibleBounds.y);
            const clipW = Math.round(visibleBounds.width);
            const clipH = Math.round(visibleBounds.height);
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
                {/* Checkerboard pattern - only when canvas extends beyond image (shows transparent areas) */}
                {checkerPatternImage && !compositorSettings.enabled && canvasBounds && originalImageSize && (
                  canvasBounds.imageOffsetX !== 0 || 
                  canvasBounds.imageOffsetY !== 0 ||
                  canvasBounds.width > originalImageSize.width ||
                  canvasBounds.height > originalImageSize.height
                ) && (
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
                  takeSnapshot={history.takeSnapshot}
                  commitSnapshot={history.commitSnapshot}
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
              onDragStart={() => history.takeSnapshot()}
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
                history.commitSnapshot();
              }}
            />
          )}

          <Transformer
            ref={transformerRef}
            name="transformer"
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
            onTransformStart={() => history.takeSnapshot()}
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
});
