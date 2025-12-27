import { useState, useCallback } from 'react';
import type { CanvasShape } from '../types';
import { shapeIntersectsRect } from '../utils/canvasGeometry';

interface UseMarqueeSelectionProps {
  shapes: CanvasShape[];
  setSelectedIds: (ids: string[]) => void;
}

interface UseMarqueeSelectionReturn {
  isMarqueeSelecting: boolean;
  marqueeStart: { x: number; y: number };
  marqueeEnd: { x: number; y: number };
  startMarquee: (pos: { x: number; y: number }) => void;
  updateMarquee: (pos: { x: number; y: number }) => void;
  finishMarquee: () => void;
  cancelMarquee: () => void;
}

/**
 * Hook for marquee (rectangular) selection of shapes
 * Allows selecting multiple shapes by dragging a selection rectangle
 */
export const useMarqueeSelection = ({
  shapes,
  setSelectedIds,
}: UseMarqueeSelectionProps): UseMarqueeSelectionReturn => {
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeStart, setMarqueeStart] = useState({ x: 0, y: 0 });
  const [marqueeEnd, setMarqueeEnd] = useState({ x: 0, y: 0 });

  // Start marquee selection
  const startMarquee = useCallback((pos: { x: number; y: number }) => {
    setIsMarqueeSelecting(true);
    setMarqueeStart(pos);
    setMarqueeEnd(pos);
  }, []);

  // Update marquee selection during drag
  const updateMarquee = useCallback((pos: { x: number; y: number }) => {
    if (!isMarqueeSelecting) return;
    setMarqueeEnd(pos);
  }, [isMarqueeSelecting]);

  // Finish marquee selection and select intersecting shapes
  const finishMarquee = useCallback(() => {
    if (!isMarqueeSelecting) return;

    // Calculate marquee bounds (normalized for any drag direction)
    const marqueeBounds = {
      x: Math.min(marqueeStart.x, marqueeEnd.x),
      y: Math.min(marqueeStart.y, marqueeEnd.y),
      width: Math.abs(marqueeEnd.x - marqueeStart.x),
      height: Math.abs(marqueeEnd.y - marqueeStart.y),
    };

    // Find shapes that intersect with marquee (uses line intersection for lines/arrows)
    const selectedShapeIds = shapes
      .filter(shape => shapeIntersectsRect(shape, marqueeBounds))
      .map(shape => shape.id);

    if (selectedShapeIds.length > 0) {
      setSelectedIds(selectedShapeIds);
    }

    setIsMarqueeSelecting(false);
  }, [isMarqueeSelecting, marqueeStart, marqueeEnd, shapes, setSelectedIds]);

  // Cancel marquee without selecting
  const cancelMarquee = useCallback(() => {
    setIsMarqueeSelecting(false);
  }, []);

  return {
    isMarqueeSelecting,
    marqueeStart,
    marqueeEnd,
    startMarquee,
    updateMarquee,
    finishMarquee,
    cancelMarquee,
  };
};
