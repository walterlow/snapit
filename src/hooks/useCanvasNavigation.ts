import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import Konva from 'konva';
import type { CompositorSettings, Tool } from '../types';

const MIN_ZOOM = 0.5;  // 50%
const MAX_ZOOM = 2;    // 200%
const ZOOM_STEP = 0.05; // 5% per wheel tick
const VIEW_PADDING = 48;

// Momentum zoom settings
const ZOOM_MOMENTUM_FRICTION = 0.6; // Decay per frame (lower = stops faster)
const ZOOM_MOMENTUM_MIN = 0.002; // Velocity threshold to stop animation

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
  // Ready state - true after initial fit is complete
  isReady: boolean;
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
  const fitRequestRef = useRef<number | null>(null);

  // Refs for smooth zoom - CSS transform approach
  const renderedZoomRef = useRef(1);
  const renderedPositionRef = useRef({ x: 0, y: 0 });
  const zoomSyncTimeoutRef = useRef<number | null>(null);
  // Transform coefficients: compositor position = position + K * zoom
  const transformCoeffsRef = useRef({ kx: 0, ky: 0 });
  
  // Momentum zoom refs
  const zoomVelocityRef = useRef(0);
  const momentumRAFRef = useRef<number | null>(null);
  const lastAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);

  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isInitialFit, setIsInitialFit] = useState(true);
  const [isReady, setIsReady] = useState(false);

  // Reset initial fit when image changes
  useEffect(() => {
    setIsInitialFit(true);
    setIsReady(false);
  }, [imageData]);

  // Calculate transform coefficients when compositor settings or bounds change
  // Formula: compositor left = position.x + Kx * zoom, where Kx = visibleBounds.x - padding
  useEffect(() => {
    if (!image || !canvasBounds || !compositorSettings.enabled) {
      transformCoeffsRef.current = { kx: 0, ky: 0 };
      return;
    }

    // Calculate visible bounds (same logic as getVisibleBounds)
    const isCropMode = selectedTool === 'crop';
    let visibleX: number, visibleY: number;

    if (isCropMode) {
      visibleX = 0;
      visibleY = 0;
    } else {
      visibleX = -canvasBounds.imageOffsetX;
      visibleY = -canvasBounds.imageOffsetY;
    }

    // Padding is now in pixels
    const padding = compositorSettings.padding;

    // Kx and Ky: the coefficients that relate zoom to compositor position offset
    transformCoeffsRef.current = {
      kx: visibleX - padding,
      ky: visibleY - padding,
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

  // Cleanup RAF handles on unmount
  useEffect(() => {
    return () => {
      if (zoomSyncTimeoutRef.current) {
        cancelAnimationFrame(zoomSyncTimeoutRef.current);
      }
      if (fitRequestRef.current) {
        cancelAnimationFrame(fitRequestRef.current);
      }
      if (momentumRAFRef.current) {
        cancelAnimationFrame(momentumRAFRef.current);
      }
    };
  }, []);

  // Calculate composition size (with compositor padding)
  const getCompositionSize = useCallback((contentWidth: number, contentHeight: number) => {
    if (!compositorSettings.enabled) {
      return { width: contentWidth, height: contentHeight };
    }
    const padding = compositorSettings.padding;
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

  // Throttled container size update - limits updates during resize drag
  useEffect(() => {
    let lastUpdateTime = 0;
    const THROTTLE_MS = 100; // Update at most every 100ms during resize

    const updateContainerSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    const throttledUpdate = () => {
      const now = performance.now();
      const timeSinceLastUpdate = now - lastUpdateTime;

      if (resizeTimeoutRef.current) {
        cancelAnimationFrame(resizeTimeoutRef.current);
      }

      if (timeSinceLastUpdate >= THROTTLE_MS) {
        // Enough time passed, update immediately on next frame
        resizeTimeoutRef.current = requestAnimationFrame(() => {
          updateContainerSize();
          lastUpdateTime = performance.now();
        });
      } else {
        // Schedule update after throttle period
        resizeTimeoutRef.current = requestAnimationFrame(() => {
          setTimeout(() => {
            updateContainerSize();
            lastUpdateTime = performance.now();
          }, THROTTLE_MS - timeSinceLastUpdate);
        });
      }
    };

    updateContainerSize();

    const resizeObserver = new ResizeObserver(throttledUpdate);
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

  // Core fit calculation (no state updates)
  const calculateFitToSize = useCallback(() => {
    if (!image) return null;

    const { width, height, cropX, cropY } = getContentDimensions();
    const availableWidth = containerSize.width - VIEW_PADDING * 2;
    const availableHeight = containerSize.height - VIEW_PADDING * 2;

    const compositionSize = getCompositionSize(width, height);
    const scaleX = availableWidth / compositionSize.width;
    const scaleY = availableHeight / compositionSize.height;
    const fitZoom = Math.min(scaleX, scaleY, 1) * 0.9;

    const x = (containerSize.width - width * fitZoom) / 2 - cropX * fitZoom;
    const y = (containerSize.height - height * fitZoom) / 2 - cropY * fitZoom;

    return { zoom: fitZoom, position: { x, y } };
  }, [image, containerSize, getCompositionSize, getContentDimensions]);

  // Fit to size handler - debounced to prevent multiple fits per frame
  const handleFitToSize = useCallback(() => {
    if (fitRequestRef.current) {
      cancelAnimationFrame(fitRequestRef.current);
    }
    fitRequestRef.current = requestAnimationFrame(() => {
      const fit = calculateFitToSize();
      if (fit) {
        setZoom(fit.zoom);
        setPosition(fit.position);
      }
      fitRequestRef.current = null;
    });
  }, [calculateFitToSize]);

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
        // Initial load - calculate and apply fit synchronously to avoid flash
        const fit = calculateFitToSize();
        if (fit) {
          setZoom(fit.zoom);
          setPosition(fit.position);
          // Mark as ready after position is set (will render in next frame)
          requestAnimationFrame(() => setIsReady(true));
        }
        setIsInitialFit(false);
      } else if (hasChanged) {
        // On resize - just recenter, keep current zoom
        recenterCanvas();
      }

      prevContainerSizeRef.current = containerSize;
    }
  }, [image, containerSize, isInitialFit, calculateFitToSize, recenterCanvas, canvasBounds, setCanvasBounds, setOriginalImageSize]);

  // Fit when exiting crop mode
  useEffect(() => {
    if (prevToolRef.current === 'crop' && selectedTool !== 'crop') {
      handleFitToSize();
    }
    prevToolRef.current = selectedTool;
  }, [selectedTool, handleFitToSize]);

  // Track padding changes without auto-refitting (keeps view stable)
  useEffect(() => {
    prevPaddingRef.current = compositorSettings.padding;
  }, [compositorSettings.padding]);

  // Listen for fit-to-center event (F key)
  useEffect(() => {
    const handleFitEvent = () => handleFitToSize();
    window.addEventListener('fit-to-center', handleFitEvent);
    return () => window.removeEventListener('fit-to-center', handleFitEvent);
  }, [handleFitToSize]);

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

  // Apply zoom at anchor point - shared by wheel handler and momentum animation (DRY)
  const applyZoomAtAnchor = useCallback((
    stage: Konva.Stage,
    targetZoom: number,
    anchor: { x: number; y: number }
  ) => {
    const currentZoom = stage.scaleX();
    const currentPos = stage.position();
    const newZoom = Math.min(Math.max(targetZoom, MIN_ZOOM), MAX_ZOOM);

    // Skip if zoom didn't change or hit limits
    if (newZoom === currentZoom) return null;

    // Calculate anchor position in canvas coordinates
    const anchorCanvasX = (anchor.x - currentPos.x) / currentZoom;
    const anchorCanvasY = (anchor.y - currentPos.y) / currentZoom;

    // Calculate new position so the same canvas point stays under the anchor
    const newX = anchor.x - anchorCanvasX * newZoom;
    const newY = anchor.y - anchorCanvasY * newZoom;

    // Update Stage directly (immediate visual feedback)
    stage.scale({ x: newZoom, y: newZoom });
    stage.position({ x: newX, y: newY });
    stage.batchDraw();

    // Apply CSS transform to compositor background for instant visual sync
    if (compositorBgRef?.current && compositorSettings.enabled) {
      const renderedZoom = renderedZoomRef.current;
      const renderedPos = renderedPositionRef.current;
      const { kx, ky } = transformCoeffsRef.current;

      const scaleRatio = newZoom / renderedZoom;
      const dx = (newX - renderedPos.x) + kx * (newZoom - renderedZoom);
      const dy = (newY - renderedPos.y) + ky * (newZoom - renderedZoom);

      compositorBgRef.current.style.transformOrigin = '0 0';
      compositorBgRef.current.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleRatio})`;
    }

    return { zoom: newZoom, position: { x: newX, y: newY } };
  }, [compositorBgRef, compositorSettings.enabled]);

  // Momentum animation loop
  const runMomentum = useCallback(() => {
    const stage = stageRef.current;
    const anchor = lastAnchorRef.current;
    
    if (!stage || !anchor) {
      zoomVelocityRef.current = 0;
      return;
    }

    const velocity = zoomVelocityRef.current;
    
    // Stop if velocity is negligible
    if (Math.abs(velocity) < ZOOM_MOMENTUM_MIN) {
      zoomVelocityRef.current = 0;
      momentumRAFRef.current = null;
      
      // Final sync to React state
      const finalZoom = stage.scaleX();
      const finalPos = stage.position();
      syncZoomState(finalZoom, { x: finalPos.x, y: finalPos.y });
      return;
    }

    // Apply velocity to zoom
    const currentZoom = stage.scaleX();
    const targetZoom = currentZoom + velocity;
    const result = applyZoomAtAnchor(stage, targetZoom, anchor);

    // Apply friction
    zoomVelocityRef.current *= ZOOM_MOMENTUM_FRICTION;

    // Stop if we hit zoom limits
    if (!result) {
      zoomVelocityRef.current = 0;
      momentumRAFRef.current = null;
      
      const finalZoom = stage.scaleX();
      const finalPos = stage.position();
      syncZoomState(finalZoom, { x: finalPos.x, y: finalPos.y });
      return;
    }

    // Continue animation
    momentumRAFRef.current = requestAnimationFrame(runMomentum);
  }, [applyZoomAtAnchor, syncZoomState]);

  // Mouse wheel zoom handler (mouse-anchored with slight momentum)
  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      if (!image) return;

      const stage = e.target.getStage();
      if (!stage) return;

      // Get mouse position relative to the stage container
      const pointerPos = stage.getPointerPosition();
      if (!pointerPos) return;

      // Store stage and anchor for momentum animation
      stageRef.current = stage;
      lastAnchorRef.current = pointerPos;

      // Calculate zoom direction
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      
      // Apply immediate zoom step
      const currentZoom = stage.scaleX();
      const result = applyZoomAtAnchor(stage, currentZoom + direction * ZOOM_STEP, pointerPos);

      // Set small residual velocity for subtle momentum tail (doesn't accumulate)
      if (result) {
        zoomVelocityRef.current = direction * ZOOM_STEP * 0.5;
      }

      // Start momentum animation if not running
      if (!momentumRAFRef.current) {
        momentumRAFRef.current = requestAnimationFrame(runMomentum);
      }
    },
    [image, applyZoomAtAnchor, runMomentum]
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
    // Ready state - true after initial fit is complete
    isReady,
  };
};
