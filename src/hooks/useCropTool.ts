import { useState, useCallback, useMemo } from 'react';
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

interface ImageSize {
  width: number;
  height: number;
}

export interface SnapGuide {
  type: 'vertical' | 'horizontal';
  position: number; // x for vertical, y for horizontal
  label?: 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';
}

interface UseCropToolProps {
  canvasBounds: CanvasBounds | null;
  setCanvasBounds: (bounds: CanvasBounds) => void;
  isShiftHeld: boolean;
  originalImageSize: ImageSize | null;
}

interface UseCropToolReturn {
  cropPreview: CropBounds | null;
  cropDragStart: { x: number; y: number } | null;
  cropLockedAxis: 'x' | 'y' | null;
  snapGuides: SnapGuide[];
  setCropPreview: (preview: CropBounds | null) => void;
  getDisplayBounds: () => CropBounds;
  getBaseBounds: () => CropBounds;
  handleCenterDragStart: (x: number, y: number) => void;
  handleCenterDragMove: (x: number, y: number) => { x: number; y: number };
  handleCenterDragEnd: (x: number, y: number) => void;
  handleEdgeDragStart: (handleId: string) => void;
  handleEdgeDragMove: (handleId: string, nodeX: number, nodeY: number) => void;
  handleEdgeDragEnd: (handleId: string, nodeX: number, nodeY: number) => void;
  handleCornerDragStart: (handleId: string) => void;
  handleCornerDragMove: (handleId: string, nodeX: number, nodeY: number) => void;
  handleCornerDragEnd: (handleId: string, nodeX: number, nodeY: number) => void;
  commitBounds: (preview: CropBounds) => void;
}

const HANDLE_THICKNESS = 6;
const MIN_CROP_SIZE = 50;
const SNAP_THRESHOLD = 8; // pixels threshold for snap detection

/**
 * Hook for crop tool state management
 * Handles crop preview, axis locking, and bounds updates
 */
export const useCropTool = ({
  canvasBounds,
  setCanvasBounds,
  isShiftHeld,
  originalImageSize,
}: UseCropToolProps): UseCropToolReturn => {
  const [cropPreview, setCropPreview] = useState<CropBounds | null>(null);
  const [cropDragStart, setCropDragStart] = useState<{ x: number; y: number } | null>(null);
  const [cropLockedAxis, setCropLockedAxis] = useState<'x' | 'y' | null>(null);
  const [activeHandle, setActiveHandle] = useState<string | null>(null); // Track which handle is being dragged

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

  // Apply snapping to bounds based on active handle
  const applySnapping = useCallback(
    (bounds: CropBounds, handle: string | null): CropBounds => {
      if (!originalImageSize || !handle) return bounds;

      const result = { ...bounds };

      // Image snap targets
      const imageLeft = 0;
      const imageRight = originalImageSize.width;
      const imageTop = 0;
      const imageBottom = originalImageSize.height;
      const imageCenterX = originalImageSize.width / 2;
      const imageCenterY = originalImageSize.height / 2;

      // Crop edges
      const cropLeft = bounds.x;
      const cropRight = bounds.x + bounds.width;
      const cropTop = bounds.y;
      const cropBottom = bounds.y + bounds.height;
      const cropCenterX = bounds.x + bounds.width / 2;
      const cropCenterY = bounds.y + bounds.height / 2;

      // Determine which edges to snap based on handle
      const snapLeft = handle === 'l' || handle === 'tl' || handle === 'bl';
      const snapRight = handle === 'r' || handle === 'tr' || handle === 'br';
      const snapTop = handle === 't' || handle === 'tl' || handle === 'tr';
      const snapBottom = handle === 'b' || handle === 'bl' || handle === 'br';
      const snapCenter = handle === 'center';

      // Snap left edge
      if (snapLeft) {
        if (Math.abs(cropLeft - imageLeft) < SNAP_THRESHOLD) {
          result.width += result.x - imageLeft;
          result.x = imageLeft;
        } else if (Math.abs(cropLeft - imageCenterX) < SNAP_THRESHOLD) {
          result.width += result.x - imageCenterX;
          result.x = imageCenterX;
        } else if (Math.abs(cropLeft - imageRight) < SNAP_THRESHOLD) {
          result.width += result.x - imageRight;
          result.x = imageRight;
        }
      }

      // Snap right edge
      if (snapRight) {
        if (Math.abs(cropRight - imageRight) < SNAP_THRESHOLD) {
          result.width = imageRight - result.x;
        } else if (Math.abs(cropRight - imageCenterX) < SNAP_THRESHOLD) {
          result.width = imageCenterX - result.x;
        } else if (Math.abs(cropRight - imageLeft) < SNAP_THRESHOLD) {
          result.width = imageLeft - result.x;
        }
      }

      // Snap top edge
      if (snapTop) {
        if (Math.abs(cropTop - imageTop) < SNAP_THRESHOLD) {
          result.height += result.y - imageTop;
          result.y = imageTop;
        } else if (Math.abs(cropTop - imageCenterY) < SNAP_THRESHOLD) {
          result.height += result.y - imageCenterY;
          result.y = imageCenterY;
        } else if (Math.abs(cropTop - imageBottom) < SNAP_THRESHOLD) {
          result.height += result.y - imageBottom;
          result.y = imageBottom;
        }
      }

      // Snap bottom edge
      if (snapBottom) {
        if (Math.abs(cropBottom - imageBottom) < SNAP_THRESHOLD) {
          result.height = imageBottom - result.y;
        } else if (Math.abs(cropBottom - imageCenterY) < SNAP_THRESHOLD) {
          result.height = imageCenterY - result.y;
        } else if (Math.abs(cropBottom - imageTop) < SNAP_THRESHOLD) {
          result.height = imageTop - result.y;
        }
      }

      // Snap center (moves entire crop box)
      if (snapCenter) {
        // Horizontal center snap
        if (Math.abs(cropCenterX - imageCenterX) < SNAP_THRESHOLD) {
          result.x = imageCenterX - result.width / 2;
        }
        // Vertical center snap
        if (Math.abs(cropCenterY - imageCenterY) < SNAP_THRESHOLD) {
          result.y = imageCenterY - result.height / 2;
        }
        // Edge snaps for center drag
        if (Math.abs(cropLeft - imageLeft) < SNAP_THRESHOLD) {
          result.x = imageLeft;
        } else if (Math.abs(cropRight - imageRight) < SNAP_THRESHOLD) {
          result.x = imageRight - result.width;
        }
        if (Math.abs(cropTop - imageTop) < SNAP_THRESHOLD) {
          result.y = imageTop;
        } else if (Math.abs(cropBottom - imageBottom) < SNAP_THRESHOLD) {
          result.y = imageBottom - result.height;
        }
      }

      return result;
    },
    [originalImageSize]
  );

  // Commit preview to actual bounds
  const commitBounds = useCallback(
    (preview: CropBounds, handle: string | null = null) => {
      const snappedBounds = applySnapping(preview, handle);
      setCanvasBounds({
        width: Math.round(snappedBounds.width),
        height: Math.round(snappedBounds.height),
        imageOffsetX: Math.round(-snappedBounds.x),
        imageOffsetY: Math.round(-snappedBounds.y),
      });
      setCropPreview(null);
    },
    [setCanvasBounds, applySnapping]
  );

  // Center drag handlers (with Shift axis locking)
  const handleCenterDragStart = useCallback((x: number, y: number) => {
    setCropDragStart({ x, y });
    setCropLockedAxis(null);
    setActiveHandle('center');
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
      }, 'center');
      setCropDragStart(null);
      setCropLockedAxis(null);
      setActiveHandle(null);
      commitSnapshot();
    },
    [isShiftHeld, cropDragStart, cropLockedAxis, getBaseBounds, commitBounds]
  );

  // Edge drag handlers
  const handleEdgeDragStart = useCallback((handleId: string) => {
    setActiveHandle(handleId);
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
      commitBounds(preview, handleId);
      setActiveHandle(null);
      commitSnapshot();
    },
    [calcPreviewFromDrag, commitBounds]
  );

  // Corner drag handlers
  const handleCornerDragStart = useCallback((handleId: string) => {
    setActiveHandle(handleId);
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
      commitBounds(preview, handleId);
      setActiveHandle(null);
      commitSnapshot();
    },
    [calcPreviewFromDrag, commitBounds]
  );

  // Calculate active snap guides based on crop bounds alignment with image bounds
  // Only shows guides relevant to the handle being dragged
  const snapGuides = useMemo((): SnapGuide[] => {
    if (!originalImageSize || !cropPreview || !activeHandle) return [];

    const guides: SnapGuide[] = [];
    const bounds = cropPreview;

    // Image snap targets
    const imageLeft = 0;
    const imageRight = originalImageSize.width;
    const imageTop = 0;
    const imageBottom = originalImageSize.height;
    const imageCenterX = originalImageSize.width / 2;
    const imageCenterY = originalImageSize.height / 2;

    // Crop bounds edges and center
    const cropLeft = bounds.x;
    const cropRight = bounds.x + bounds.width;
    const cropTop = bounds.y;
    const cropBottom = bounds.y + bounds.height;
    const cropCenterX = bounds.x + bounds.width / 2;
    const cropCenterY = bounds.y + bounds.height / 2;

    // Determine which edges to check based on active handle
    const checkLeft = activeHandle === 'l' || activeHandle === 'tl' || activeHandle === 'bl' || activeHandle === 'center';
    const checkRight = activeHandle === 'r' || activeHandle === 'tr' || activeHandle === 'br' || activeHandle === 'center';
    const checkTop = activeHandle === 't' || activeHandle === 'tl' || activeHandle === 'tr' || activeHandle === 'center';
    const checkBottom = activeHandle === 'b' || activeHandle === 'bl' || activeHandle === 'br' || activeHandle === 'center';
    const checkCenterX = activeHandle === 'center';
    const checkCenterY = activeHandle === 'center';

    // Check left edge alignment
    if (checkLeft) {
      if (Math.abs(cropLeft - imageLeft) < SNAP_THRESHOLD) {
        guides.push({ type: 'vertical', position: imageLeft, label: 'left' });
      } else if (Math.abs(cropLeft - imageCenterX) < SNAP_THRESHOLD) {
        guides.push({ type: 'vertical', position: imageCenterX, label: 'centerX' });
      } else if (Math.abs(cropLeft - imageRight) < SNAP_THRESHOLD) {
        guides.push({ type: 'vertical', position: imageRight, label: 'right' });
      }
    }

    // Check right edge alignment
    if (checkRight) {
      if (Math.abs(cropRight - imageRight) < SNAP_THRESHOLD) {
        guides.push({ type: 'vertical', position: imageRight, label: 'right' });
      } else if (Math.abs(cropRight - imageCenterX) < SNAP_THRESHOLD) {
        guides.push({ type: 'vertical', position: imageCenterX, label: 'centerX' });
      } else if (Math.abs(cropRight - imageLeft) < SNAP_THRESHOLD) {
        guides.push({ type: 'vertical', position: imageLeft, label: 'left' });
      }
    }

    // Check center X alignment (only when dragging center)
    if (checkCenterX && Math.abs(cropCenterX - imageCenterX) < SNAP_THRESHOLD) {
      guides.push({ type: 'vertical', position: imageCenterX, label: 'centerX' });
    }

    // Check top edge alignment
    if (checkTop) {
      if (Math.abs(cropTop - imageTop) < SNAP_THRESHOLD) {
        guides.push({ type: 'horizontal', position: imageTop, label: 'top' });
      } else if (Math.abs(cropTop - imageCenterY) < SNAP_THRESHOLD) {
        guides.push({ type: 'horizontal', position: imageCenterY, label: 'centerY' });
      } else if (Math.abs(cropTop - imageBottom) < SNAP_THRESHOLD) {
        guides.push({ type: 'horizontal', position: imageBottom, label: 'bottom' });
      }
    }

    // Check bottom edge alignment
    if (checkBottom) {
      if (Math.abs(cropBottom - imageBottom) < SNAP_THRESHOLD) {
        guides.push({ type: 'horizontal', position: imageBottom, label: 'bottom' });
      } else if (Math.abs(cropBottom - imageCenterY) < SNAP_THRESHOLD) {
        guides.push({ type: 'horizontal', position: imageCenterY, label: 'centerY' });
      } else if (Math.abs(cropBottom - imageTop) < SNAP_THRESHOLD) {
        guides.push({ type: 'horizontal', position: imageTop, label: 'top' });
      }
    }

    // Check center Y alignment (only when dragging center)
    if (checkCenterY && Math.abs(cropCenterY - imageCenterY) < SNAP_THRESHOLD) {
      guides.push({ type: 'horizontal', position: imageCenterY, label: 'centerY' });
    }

    // Deduplicate guides by type and position
    const uniqueGuides = guides.filter((guide, index, self) =>
      index === self.findIndex(g => g.type === guide.type && g.position === guide.position)
    );

    return uniqueGuides;
  }, [originalImageSize, cropPreview, activeHandle]);

  return {
    cropPreview,
    cropDragStart,
    cropLockedAxis,
    snapGuides,
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
