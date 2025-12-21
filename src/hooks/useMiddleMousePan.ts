import { useState, useCallback, useEffect, useRef } from 'react';

interface UseMiddleMousePanProps {
  position: { x: number; y: number };
  setPosition: (pos: { x: number; y: number }) => void;
  containerRef: React.RefObject<HTMLDivElement>;
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
 */
export const useMiddleMousePan = ({
  position,
  setPosition,
  containerRef,
}: UseMiddleMousePanProps): UseMiddleMousePanReturn => {
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
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
      setPanStart({ x: e.clientX, y: e.clientY });
      positionStartRef.current = position;
    }
  }, [position]);

  const handleMiddleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    setPosition({
      x: positionStartRef.current.x + dx,
      y: positionStartRef.current.y + dy,
    });
  }, [isPanning, panStart, setPosition]);

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
  }, [containerRef]);

  return {
    isPanning,
    handleMiddleMouseDown,
    handleMiddleMouseMove,
    handleMiddleMouseUp,
  };
};
