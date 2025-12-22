import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import Konva from 'konva';
import type { CompositorSettings, Tool } from '../types';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;
const VIEW_PADDING = 48;

interface CanvasBounds {
  width: number;
  height: number;
  imageOffsetX: number;
  imageOffsetY: number;
}

interface UseCanvasNavigationProps {
  image: HTMLImageElement | undefined;
  imageData: string;
  compositorSettings: CompositorSettings;
  canvasBounds: CanvasBounds | null;
  setCanvasBounds: (bounds: CanvasBounds) => void;
  setOriginalImageSize: (size: { width: number; height: number }) => void;
  selectedTool: Tool;
  compositorBgRef?: React.RefObject<HTMLDivElement | null>;
}

interface UseCanvasNavigationReturn {
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  position: { x: number; y: number };
  setPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  containerSize: { width: number; height: number };
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasSize: { width: number; height: number };
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleFitToSize: () => void;
  handleActualSize: () => void;
  handleWheel: (e: Konva.KonvaEventObject<WheelEvent>) => void;
  getCanvasPosition: (screenPos: { x: number; y: number }) => { x: number; y: number };
  // Refs for coordinating with pan hook (same baseline for CSS transforms)
  renderedPositionRef: React.RefObject<{ x: number; y: number }>;
  renderedZoomRef: React.RefObject<number>;
  transformCoeffsRef: React.RefObject<{ kx: number; ky: number }>;
}

/**
 * Hook for canvas navigation - zoom, pan, and fit controls
 */
export const useCanvasNavigation = ({
  image,
  imageData,
  compositorSettings,
  canvasBounds,
  setCanvasBounds,
  setOriginalImageSize,
  selectedTool,
  compositorBgRef,
}: UseCanvasNavigationProps): UseCanvasNavigationReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const prevContainerSizeRef = useRef({ width: 0, height: 0 });
  const prevToolRef = useRef(selectedTool);
  const prevPaddingRef = useRef(compositorSettings.padding);
  const prevBoundsRef = useRef<CanvasBounds | null>(null);

  // Refs for smooth zoom - CSS transform approach
  const renderedZoomRef = useRef(1);
  const renderedPositionRef = useRef({ x: 0, y: 0 });
  const zoomSyncTimeoutRef = useRef<number | null>(null);
  // Transform coefficients: compositor position = position + K * zoom
  const transformCoeffsRef = useRef({ kx: 0, ky: 0 });

  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isInitialFit, setIsInitialFit] = useState(true);

  // Reset initial fit when image changes
  useEffect(() => {
    setIsInitialFit(true);
  }, [imageData]);

  // Calculate transform coefficients when compositor settings or bounds change
  // Formula: compositor left = position.x + Kx * zoom, where Kx = visibleBounds.x - avgDimension * paddingPercent
  useEffect(() => {
    if (!image || !canvasBounds || !compositorSettings.enabled) {
      transformCoeffsRef.current = { kx: 0, ky: 0 };
      return;
    }

    // Calculate visible bounds (same logic as getVisibleBounds)
    const isCropMode = selectedTool === 'crop';
    let visibleX: number, visibleY: number, visibleWidth: number, visibleHeight: number;

    if (isCropMode) {
      visibleX = 0;
      visibleY = 0;
      visibleWidth = image.width;
      visibleHeight = image.height;
    } else {
      visibleX = -canvasBounds.imageOffsetX;
      visibleY = -canvasBounds.imageOffsetY;
      visibleWidth = canvasBounds.width;
      visibleHeight = canvasBounds.height;
    }

    const avgDimension = (visibleWidth + visibleHeight) / 2;
    const paddingPercent = compositorSettings.padding / 100;

    // Kx and Ky: the coefficients that relate zoom to compositor position offset
    transformCoeffsRef.current = {
      kx: visibleX - avgDimension * paddingPercent,
      ky: visibleY - avgDimension * paddingPercent,
    };
  }, [image, canvasBounds, compositorSettings.enabled, compositorSettings.padding, selectedTool]);

  // Clear CSS transform AFTER React has rendered the new position
  // useLayoutEffect runs synchronously after DOM mutations but before paint
  useLayoutEffect(() => {
    if (compositorBgRef?.current) {
      compositorBgRef.current.style.transform = '';
      compositorBgRef.current.style.transformOrigin = '';
    }
    // Sync refs with rendered state
    renderedZoomRef.current = zoom;
    renderedPositionRef.current = position;
  }, [zoom, position, compositorBgRef]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (zoomSyncTimeoutRef.current) {
        clearTimeout(zoomSyncTimeoutRef.current);
      }
    };
  }, []);

  // Calculate composition size (with compositor padding)
  const getCompositionSize = useCallback((contentWidth: number, contentHeight: number) => {
    if (!compositorSettings.enabled) {
      return { width: contentWidth, height: contentHeight };
    }
    const avgDimension = (contentWidth + contentHeight) / 2;
    const padding = avgDimension * (compositorSettings.padding / 100);
    return {
      width: contentWidth + padding * 2,
      height: contentHeight + padding * 2,
    };
  }, [compositorSettings.enabled, compositorSettings.padding]);

  // Helper to check if crop is applied
  const isCropApplied = useCallback(() => {
    if (!canvasBounds || !image) return false;
    return (
      canvasBounds.imageOffsetX !== 0 ||
      canvasBounds.imageOffsetY !== 0 ||
      canvasBounds.width !== image.width ||
      canvasBounds.height !== image.height
    );
  }, [canvasBounds, image]);

  // Get content dimensions (respects crop bounds)
  const getContentDimensions = useCallback(() => {
    if (!image) return { width: 0, height: 0, cropX: 0, cropY: 0 };

    const hasCrop = isCropApplied();
    return {
      width: hasCrop ? canvasBounds!.width : image.width,
      height: hasCrop ? canvasBounds!.height : image.height,
      cropX: hasCrop ? -canvasBounds!.imageOffsetX : 0,
      cropY: hasCrop ? -canvasBounds!.imageOffsetY : 0,
    };
  }, [image, canvasBounds, isCropApplied]);

  // Transform screen position to canvas position
  const getCanvasPosition = useCallback(
    (screenPos: { x: number; y: number }) => ({
      x: (screenPos.x - position.x) / zoom,
      y: (screenPos.y - position.y) / zoom,
    }),
    [zoom, position]
  );

  // Debounced container size update
  useEffect(() => {
    const updateContainerSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    const debouncedUpdate = () => {
      if (resizeTimeoutRef.current) {
        cancelAnimationFrame(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = requestAnimationFrame(updateContainerSize);
    };

    updateContainerSize();

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

  // Fit to size handler
  const handleFitToSize = useCallback(() => {
    if (!image) return;

    const { width, height, cropX, cropY } = getContentDimensions();
    const availableWidth = containerSize.width - VIEW_PADDING * 2;
    const availableHeight = containerSize.height - VIEW_PADDING * 2;

    const compositionSize = getCompositionSize(width, height);
    const scaleX = availableWidth / compositionSize.width;
    const scaleY = availableHeight / compositionSize.height;
    const fitZoom = Math.min(scaleX, scaleY, 1) * 0.9;

    const x = (containerSize.width - width * fitZoom) / 2 - cropX * fitZoom;
    const y = (containerSize.height - height * fitZoom) / 2 - cropY * fitZoom;

    setZoom(fitZoom);
    setPosition({ x, y });
  }, [image, containerSize, getCompositionSize, getContentDimensions]);

  // Recenter canvas (keeps current zoom, just updates position)
  const recenterCanvas = useCallback(() => {
    if (!image) return;

    const { width, height, cropX, cropY } = getContentDimensions();
    const x = (containerSize.width - width * zoom) / 2 - cropX * zoom;
    const y = (containerSize.height - height * zoom) / 2 - cropY * zoom;
    setPosition({ x, y });
  }, [image, containerSize, zoom, getContentDimensions]);

  // Initial fit and resize handling
  useEffect(() => {
    if (image && containerSize.width > 0 && containerSize.height > 0) {
      setCanvasSize({ width: image.width, height: image.height });
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
      const hasChanged = prevSize.width !== containerSize.width || prevSize.height !== containerSize.height;

      if (isInitialFit) {
        // Initial load - fit to size
        handleFitToSize();
        setIsInitialFit(false);
      } else if (hasChanged) {
        // On resize - just recenter, keep current zoom
        recenterCanvas();
      }

      prevContainerSizeRef.current = containerSize;
    }
  }, [image, containerSize, isInitialFit, handleFitToSize, recenterCanvas, canvasBounds, setCanvasBounds, setOriginalImageSize]);

  // Fit when exiting crop mode
  useEffect(() => {
    if (prevToolRef.current === 'crop' && selectedTool !== 'crop') {
      handleFitToSize();
    }
    prevToolRef.current = selectedTool;
  }, [selectedTool, handleFitToSize]);

  // Auto-refit on compositor padding change
  useEffect(() => {
    if (compositorSettings.enabled && compositorSettings.padding !== prevPaddingRef.current) {
      prevPaddingRef.current = compositorSettings.padding;
      handleFitToSize();
    }
  }, [compositorSettings.enabled, compositorSettings.padding, handleFitToSize]);

  // Auto-refit on canvas bounds change (skip during crop mode)
  useEffect(() => {
    if (!canvasBounds) {
      prevBoundsRef.current = canvasBounds;
      return;
    }

    if (selectedTool === 'crop') {
      prevBoundsRef.current = canvasBounds;
      return;
    }

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

  // Zoom in handler
  const handleZoomIn = useCallback(() => {
    setZoom((prevZoom) => {
      const newZoom = Math.min(prevZoom + ZOOM_STEP, MAX_ZOOM);
      if (image) {
        const { width, height, cropX, cropY } = getContentDimensions();
        const x = (containerSize.width - width * newZoom) / 2 - cropX * newZoom;
        const y = (containerSize.height - height * newZoom) / 2 - cropY * newZoom;
        setPosition({ x, y });
      }
      return newZoom;
    });
  }, [image, containerSize, getContentDimensions]);

  // Zoom out handler
  const handleZoomOut = useCallback(() => {
    setZoom((prevZoom) => {
      const newZoom = Math.max(prevZoom - ZOOM_STEP, MIN_ZOOM);
      if (image) {
        const { width, height, cropX, cropY } = getContentDimensions();
        const x = (containerSize.width - width * newZoom) / 2 - cropX * newZoom;
        const y = (containerSize.height - height * newZoom) / 2 - cropY * newZoom;
        setPosition({ x, y });
      }
      return newZoom;
    });
  }, [image, containerSize, getContentDimensions]);

  // Actual size (100% zoom) handler
  const handleActualSize = useCallback(() => {
    if (!image) return;

    const { width, height, cropX, cropY } = getContentDimensions();
    const x = (containerSize.width - width) / 2 - cropX;
    const y = (containerSize.height - height) / 2 - cropY;

    setZoom(1);
    setPosition({ x, y });
  }, [image, containerSize, getContentDimensions]);

  // Sync zoom state to React (called after zoom gesture ends)
  // Note: useLayoutEffect will clear the CSS transform after React renders
  const syncZoomState = useCallback((newZoom: number, newPosition: { x: number; y: number }) => {
    setZoom(newZoom);
    setPosition(newPosition);
  }, []);

  // Mouse wheel zoom handler (mouse-anchored)
  // Updates Stage directly + CSS transform for compositor bg (no React re-renders during zoom)
  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      if (!image) return;

      const stage = e.target.getStage();
      if (!stage) return;

      // Use current stage values for smooth continuous zooming
      const currentZoom = stage.scaleX();
      const currentPos = stage.position();

      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newZoom = Math.min(Math.max(currentZoom + direction * ZOOM_STEP, MIN_ZOOM), MAX_ZOOM);

      // Skip if zoom didn't change
      if (newZoom === currentZoom) return;

      // Get mouse position relative to the stage container
      const pointerPos = stage.getPointerPosition();
      if (!pointerPos) return;

      // Calculate mouse position in canvas coordinates (before zoom)
      const mouseCanvasX = (pointerPos.x - currentPos.x) / currentZoom;
      const mouseCanvasY = (pointerPos.y - currentPos.y) / currentZoom;

      // Calculate new position so the same canvas point stays under the mouse
      const newX = pointerPos.x - mouseCanvasX * newZoom;
      const newY = pointerPos.y - mouseCanvasY * newZoom;

      // Update Stage directly (immediate visual feedback)
      stage.scale({ x: newZoom, y: newZoom });
      stage.position({ x: newX, y: newY });
      stage.batchDraw();

      // Apply CSS transform to compositor background for instant visual sync
      // This avoids React re-renders during zoom gesture
      if (compositorBgRef?.current && compositorSettings.enabled) {
        const renderedZoom = renderedZoomRef.current;
        const renderedPos = renderedPositionRef.current;
        const { kx, ky } = transformCoeffsRef.current;

        // Scale ratio
        const scaleRatio = newZoom / renderedZoom;

        // Calculate correct translation delta accounting for zoom-dependent offset
        // Compositor position formula: left = position.x + Kx * zoom
        // So: dx = (newPos.x - renderedPos.x) + Kx * (newZoom - renderedZoom)
        const dx = (newX - renderedPos.x) + kx * (newZoom - renderedZoom);
        const dy = (newY - renderedPos.y) + ky * (newZoom - renderedZoom);

        // Apply transform: translate then scale from top-left
        compositorBgRef.current.style.transformOrigin = '0 0';
        compositorBgRef.current.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleRatio})`;
      }

      // Debounce React state sync - only sync after zooming stops
      if (zoomSyncTimeoutRef.current) {
        clearTimeout(zoomSyncTimeoutRef.current);
      }
      zoomSyncTimeoutRef.current = window.setTimeout(() => {
        syncZoomState(newZoom, { x: newX, y: newY });
        zoomSyncTimeoutRef.current = null;
      }, 100);
    },
    [image, compositorBgRef, compositorSettings.enabled, syncZoomState]
  );

  return {
    zoom,
    setZoom,
    position,
    setPosition,
    containerSize,
    containerRef,
    canvasSize,
    handleZoomIn,
    handleZoomOut,
    handleFitToSize,
    handleActualSize,
    handleWheel,
    getCanvasPosition,
    // Expose refs for pan hook coordination
    renderedPositionRef,
    renderedZoomRef,
    transformCoeffsRef,
  };
};
