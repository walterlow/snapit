import { useState, useCallback } from 'react';
import { takeSnapshot, commitSnapshot } from '../stores/editorStore';

interface CropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasBounds {
  width: number;
  height: number;
  imageOffsetX: number;
  imageOffsetY: number;
}

interface UseCropToolProps {
  canvasBounds: CanvasBounds | null;
  setCanvasBounds: (bounds: CanvasBounds) => void;
  isShiftHeld: boolean;
}

interface UseCropToolReturn {
  cropPreview: CropBounds | null;
  cropDragStart: { x: number; y: number } | null;
  cropLockedAxis: 'x' | 'y' | null;
  setCropPreview: (preview: CropBounds | null) => void;
  getDisplayBounds: () => CropBounds;
  getBaseBounds: () => CropBounds;
  handleCenterDragStart: (x: number, y: number) => void;
  handleCenterDragMove: (x: number, y: number) => { x: number; y: number };
  handleCenterDragEnd: (x: number, y: number) => void;
  handleEdgeDragStart: () => void;
  handleEdgeDragMove: (handleId: string, nodeX: number, nodeY: number) => void;
  handleEdgeDragEnd: (handleId: string, nodeX: number, nodeY: number) => void;
  handleCornerDragStart: () => void;
  handleCornerDragMove: (handleId: string, nodeX: number, nodeY: number) => void;
  handleCornerDragEnd: (handleId: string, nodeX: number, nodeY: number) => void;
  commitBounds: (preview: CropBounds) => void;
}

const HANDLE_THICKNESS = 6;
const MIN_CROP_SIZE = 50;

/**
 * Hook for crop tool state management
 * Handles crop preview, axis locking, and bounds updates
 */
export const useCropTool = ({
  canvasBounds,
  setCanvasBounds,
  isShiftHeld,
}: UseCropToolProps): UseCropToolReturn => {
  const [cropPreview, setCropPreview] = useState<CropBounds | null>(null);
  const [cropDragStart, setCropDragStart] = useState<{ x: number; y: number } | null>(null);
  const [cropLockedAxis, setCropLockedAxis] = useState<'x' | 'y' | null>(null);

  // Get base bounds from canvas bounds (without preview)
  const getBaseBounds = useCallback((): CropBounds => {
    if (!canvasBounds) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return {
      x: -canvasBounds.imageOffsetX,
      y: -canvasBounds.imageOffsetY,
      width: canvasBounds.width,
      height: canvasBounds.height,
    };
  }, [canvasBounds]);

  // Get display bounds (preview or base)
  const getDisplayBounds = useCallback((): CropBounds => {
    return cropPreview || getBaseBounds();
  }, [cropPreview, getBaseBounds]);

  // Calculate preview from handle drag position
  const calcPreviewFromDrag = useCallback(
    (handleId: string, nodeX: number, nodeY: number): CropBounds => {
      const displayBounds = getDisplayBounds();
      const left = displayBounds.x;
      const top = displayBounds.y;
      const right = left + displayBounds.width;
      const bottom = top + displayBounds.height;

      let newLeft = left, newTop = top, newRight = right, newBottom = bottom;

      // Edge handles (account for handle thickness offset)
      if (handleId === 't') newTop = nodeY + HANDLE_THICKNESS / 2;
      else if (handleId === 'b') newBottom = nodeY + HANDLE_THICKNESS / 2;
      else if (handleId === 'l') newLeft = nodeX + HANDLE_THICKNESS / 2;
      else if (handleId === 'r') newRight = nodeX + HANDLE_THICKNESS / 2;
      // Corner handles (direct position)
      else {
        if (handleId.includes('l')) newLeft = nodeX;
        if (handleId.includes('r')) newRight = nodeX;
        if (handleId.includes('t')) newTop = nodeY;
        if (handleId.includes('b')) newBottom = nodeY;
      }

      // Ensure minimum size
      if (newRight - newLeft < MIN_CROP_SIZE) {
        if (handleId.includes('l') || handleId === 'l') newLeft = newRight - MIN_CROP_SIZE;
        else newRight = newLeft + MIN_CROP_SIZE;
      }
      if (newBottom - newTop < MIN_CROP_SIZE) {
        if (handleId.includes('t') || handleId === 't') newTop = newBottom - MIN_CROP_SIZE;
        else newBottom = newTop + MIN_CROP_SIZE;
      }

      return {
        x: newLeft,
        y: newTop,
        width: newRight - newLeft,
        height: newBottom - newTop,
      };
    },
    [getDisplayBounds]
  );

  // Commit preview to actual bounds
  const commitBounds = useCallback(
    (preview: CropBounds) => {
      setCanvasBounds({
        width: Math.round(preview.width),
        height: Math.round(preview.height),
        imageOffsetX: Math.round(-preview.x),
        imageOffsetY: Math.round(-preview.y),
      });
      setCropPreview(null);
    },
    [setCanvasBounds]
  );

  // Center drag handlers (with Shift axis locking)
  const handleCenterDragStart = useCallback((x: number, y: number) => {
    setCropDragStart({ x, y });
    setCropLockedAxis(null);
    takeSnapshot();
  }, []);

  const handleCenterDragMove = useCallback(
    (newX: number, newY: number) => {
      let x = newX;
      let y = newY;

      // Shift+drag: constrain to axis
      if (isShiftHeld && cropDragStart) {
        const dx = Math.abs(x - cropDragStart.x);
        const dy = Math.abs(y - cropDragStart.y);

        // Lock to axis once movement exceeds threshold
        if (!cropLockedAxis && (dx > 5 || dy > 5)) {
          setCropLockedAxis(dx > dy ? 'x' : 'y');
        }

        // Apply constraint
        if (cropLockedAxis === 'x') {
          y = cropDragStart.y;
        } else if (cropLockedAxis === 'y') {
          x = cropDragStart.x;
        }
      }

      const baseBounds = getBaseBounds();
      setCropPreview({
        x,
        y,
        width: baseBounds.width,
        height: baseBounds.height,
      });

      return { x, y }; // Return constrained values for caller
    },
    [isShiftHeld, cropDragStart, cropLockedAxis, getBaseBounds]
  );

  const handleCenterDragEnd = useCallback(
    (x: number, y: number) => {
      let finalX = x;
      let finalY = y;

      // Apply final constraint if Shift was held
      if (isShiftHeld && cropDragStart && cropLockedAxis) {
        if (cropLockedAxis === 'x') {
          finalY = cropDragStart.y;
        } else if (cropLockedAxis === 'y') {
          finalX = cropDragStart.x;
        }
      }

      const baseBounds = getBaseBounds();
      commitBounds({
        x: finalX,
        y: finalY,
        width: baseBounds.width,
        height: baseBounds.height,
      });
      setCropDragStart(null);
      setCropLockedAxis(null);
      commitSnapshot();
    },
    [isShiftHeld, cropDragStart, cropLockedAxis, getBaseBounds, commitBounds]
  );

  // Edge drag handlers
  const handleEdgeDragStart = useCallback(() => {
    takeSnapshot();
  }, []);

  const handleEdgeDragMove = useCallback(
    (handleId: string, nodeX: number, nodeY: number) => {
      setCropPreview(calcPreviewFromDrag(handleId, nodeX, nodeY));
    },
    [calcPreviewFromDrag]
  );

  const handleEdgeDragEnd = useCallback(
    (handleId: string, nodeX: number, nodeY: number) => {
      const preview = calcPreviewFromDrag(handleId, nodeX, nodeY);
      commitBounds(preview);
      commitSnapshot();
    },
    [calcPreviewFromDrag, commitBounds]
  );

  // Corner drag handlers
  const handleCornerDragStart = useCallback(() => {
    takeSnapshot();
  }, []);

  const handleCornerDragMove = useCallback(
    (handleId: string, nodeX: number, nodeY: number) => {
      setCropPreview(calcPreviewFromDrag(handleId, nodeX, nodeY));
    },
    [calcPreviewFromDrag]
  );

  const handleCornerDragEnd = useCallback(
    (handleId: string, nodeX: number, nodeY: number) => {
      const preview = calcPreviewFromDrag(handleId, nodeX, nodeY);
      commitBounds(preview);
      commitSnapshot();
    },
    [calcPreviewFromDrag, commitBounds]
  );

  return {
    cropPreview,
    cropDragStart,
    cropLockedAxis,
    setCropPreview,
    getDisplayBounds,
    getBaseBounds,
    handleCenterDragStart,
    handleCenterDragMove,
    handleCenterDragEnd,
    handleEdgeDragStart,
    handleEdgeDragMove,
    handleEdgeDragEnd,
    handleCornerDragStart,
    handleCornerDragMove,
    handleCornerDragEnd,
    commitBounds,
  };
};
