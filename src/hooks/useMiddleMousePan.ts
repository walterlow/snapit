import { useState, useCallback, useEffect, useRef } from 'react';
import Konva from 'konva';

interface UseMiddleMousePanProps {
  position: { x: number; y: number };
  setPosition: (pos: { x: number; y: number }) => void;
  containerRef: React.RefObject<HTMLDivElement>;
  stageRef: React.RefObject<Konva.Stage | null>;
  compositorBgRef?: React.RefObject<HTMLDivElement | null>;
  // Refs for syncing with zoom - both use same baseline for CSS transforms
  renderedPositionRef?: React.RefObject<{ x: number; y: number }>;
  renderedZoomRef?: React.RefObject<number>;
  transformCoeffsRef?: React.RefObject<{ kx: number; ky: number }>;
}

interface UseMiddleMousePanReturn {
  isPanning: boolean;
  handleMiddleMouseDown: (e: React.MouseEvent) => void;
  handleMiddleMouseMove: (e: React.MouseEvent) => void;
  handleMiddleMouseUp: () => void;
}

/**
 * Hook for middle mouse button panning in the editor canvas
 * Allows users to pan the canvas view by holding middle mouse button and dragging
 * Updates Konva Stage directly during pan for smooth performance
 */
export const useMiddleMousePan = ({
  position,
  setPosition,
  containerRef,
  stageRef,
  compositorBgRef,
  renderedPositionRef,
  renderedZoomRef,
  transformCoeffsRef,
}: UseMiddleMousePanProps): UseMiddleMousePanReturn => {
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const positionStartRef = useRef(position);

  // Update position start ref when position changes while not panning
  useEffect(() => {
    if (!isPanning) {
      positionStartRef.current = position;
    }
  }, [position, isPanning]);

  const handleMiddleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) { // Middle mouse button
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY };
      positionStartRef.current = position;
    }
  }, [position]);

  const handleMiddleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;

    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    const newX = positionStartRef.current.x + dx;
    const newY = positionStartRef.current.y + dy;

    // Update Konva Stage directly (no React re-render)
    const stage = stageRef.current;
    if (stage) {
      stage.position({ x: newX, y: newY });
      stage.batchDraw();
    }

    // Update compositor background div using same baseline as zoom handler
    // This ensures pan + zoom together don't conflict
    if (compositorBgRef?.current && renderedPositionRef && renderedZoomRef && transformCoeffsRef) {
      const renderedPos = renderedPositionRef.current;
      const renderedZoom = renderedZoomRef.current;
      const currentZoom = stage?.scaleX() ?? 1;
      const { kx, ky } = transformCoeffsRef.current;

      // Same formula as zoom: delta from rendered position + zoom-dependent offset
      const compositorDx = (newX - renderedPos.x) + kx * (currentZoom - renderedZoom);
      const compositorDy = (newY - renderedPos.y) + ky * (currentZoom - renderedZoom);
      const scaleRatio = currentZoom / renderedZoom;

      compositorBgRef.current.style.transformOrigin = '0 0';
      compositorBgRef.current.style.transform = `translate(${compositorDx}px, ${compositorDy}px) scale(${scaleRatio})`;
    } else if (compositorBgRef?.current) {
      // Fallback: simple translate if refs not provided
      compositorBgRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }, [isPanning, stageRef, compositorBgRef, renderedPositionRef, renderedZoomRef, transformCoeffsRef]);

  const handleMiddleMouseUp = useCallback(() => {
    if (isPanning) {
      // Reset compositor background transform (React state will update position)
      if (compositorBgRef?.current) {
        compositorBgRef.current.style.transform = '';
      }
      // Sync final position back to React state
      const stage = stageRef.current;
      if (stage) {
        setPosition({ x: stage.x(), y: stage.y() });
      }
    }
    setIsPanning(false);
  }, [isPanning, stageRef, compositorBgRef, setPosition]);

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
  }, [containerRef]);

  return {
    isPanning,
    handleMiddleMouseDown,
    handleMiddleMouseMove,
    handleMiddleMouseUp,
  };
};
