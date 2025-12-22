/**
 * Canvas geometry utilities for coordinate transformations and bounds calculations
 */

import type { CanvasShape } from '../types';

/**
 * Transform screen position to canvas position (accounting for zoom and pan)
 */
export const screenToCanvas = (
  screenPos: { x: number; y: number },
  position: { x: number; y: number },
  zoom: number
): { x: number; y: number } => {
  return {
    x: (screenPos.x - position.x) / zoom,
    y: (screenPos.y - position.y) / zoom,
  };
};

/**
 * Get the bounding box for any shape type
 * Handles rectangles, circles, arrows, pen strokes, etc.
 */
export const getShapeBounds = (
  shape: CanvasShape
): { x: number; y: number; width: number; height: number } => {
  let x = shape.x ?? 0;
  let y = shape.y ?? 0;
  let width = shape.width ?? 0;
  let height = shape.height ?? 0;

  // Handle circles/ellipses
  const radiusX = shape.radiusX ?? shape.radius ?? 0;
  const radiusY = shape.radiusY ?? shape.radius ?? 0;
  if (radiusX || radiusY) {
    x -= radiusX;
    y -= radiusY;
    width = radiusX * 2;
    height = radiusY * 2;
  }

  // Handle arrows (point-based)
  if (shape.type === 'arrow' && shape.points && shape.points.length >= 4) {
    const [px1, py1, px2, py2] = shape.points;
    x = Math.min(px1, px2);
    y = Math.min(py1, py2);
    width = Math.abs(px2 - px1);
    height = Math.abs(py2 - py1);
  }

  // Handle pen strokes (point-based)
  if (shape.type === 'pen' && shape.points && shape.points.length >= 2) {
    const xs = shape.points.filter((_, i) => i % 2 === 0);
    const ys = shape.points.filter((_, i) => i % 2 === 1);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    x = minX;
    y = minY;
    width = maxX - minX;
    height = maxY - minY;
  }

  return { x, y, width, height };
};

/**
 * Compute bounding box of multiple shapes for group selection
 * @param shapes - All shapes in the canvas
 * @param selectedIds - IDs of selected shapes
 * @param padding - Padding around the bounding box (default: 4)
 * @returns Bounding box or null if fewer than 2 shapes selected
 */
export const getSelectionBounds = (
  shapes: CanvasShape[],
  selectedIds: string[],
  padding = 4
): { x: number; y: number; width: number; height: number } | null => {
  if (selectedIds.length < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of selectedIds) {
    const shape = shapes.find(s => s.id === id);
    if (!shape) continue;

    const bounds = getShapeBounds(shape);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  if (!isFinite(minX)) return null;

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
};

/**
 * Compute visible content bounds based on crop settings
 * @param image - The source image
 * @param canvasBounds - Current canvas bounds (crop settings)
 * @param isCropMode - Whether crop tool is currently active
 * @returns Visible bounds or null if no image
 */
export const getVisibleBounds = (
  image: HTMLImageElement | undefined,
  canvasBounds: { width: number; height: number; imageOffsetX: number; imageOffsetY: number } | null,
  isCropMode: boolean
): { x: number; y: number; width: number; height: number } | null => {
  if (!image || !canvasBounds) return null;

  // In crop mode, show full image (dark overlay handles showing crop region)
  if (isCropMode) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }

  // Check if crop is actually applied
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
};

/**
 * Calculate composition size with padding for compositor
 */
export const getCompositionSize = (
  contentWidth: number,
  contentHeight: number,
  paddingPx: number,
  compositorEnabled: boolean
): { width: number; height: number } => {
  if (!compositorEnabled) {
    return { width: contentWidth, height: contentHeight };
  }

  return {
    width: contentWidth + paddingPx * 2,
    height: contentHeight + paddingPx * 2,
  };
};

/**
 * Check if two rectangles intersect (for marquee selection)
 */
export const rectsIntersect = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean => {
  return !(
    a.x > b.x + b.width ||
    a.x + a.width < b.x ||
    a.y > b.y + b.height ||
    a.y + a.height < b.y
  );
};
