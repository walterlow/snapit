/**
 * Canvas geometry utilities for coordinate transformations and bounds calculations
 */

import type { CanvasShape } from '../types';

// Checkerboard pattern constants for transparency indication
const CHECKER_SIZE = 10;
const CHECKER_LIGHT = '#f5f5f5';
const CHECKER_DARK = '#e8e8e8';

/**
 * Create a checkerboard pattern image for transparency indication.
 * Uses softer colors for light theme compatibility.
 * @returns HTMLImageElement with checkerboard pattern, or null on failure
 */
export const createCheckerPattern = (): HTMLImageElement | null => {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_SIZE * 2;
  canvas.height = CHECKER_SIZE * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.error('Failed to get 2D canvas context for checker pattern');
    return null;
  }
  ctx.fillStyle = CHECKER_LIGHT;
  ctx.fillRect(0, 0, CHECKER_SIZE * 2, CHECKER_SIZE * 2);
  ctx.fillStyle = CHECKER_DARK;
  ctx.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  ctx.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  const img = new window.Image();
  img.src = canvas.toDataURL();
  return img;
};

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

  // Handle arrows and lines (point-based)
  if ((shape.type === 'arrow' || shape.type === 'line') && shape.points && shape.points.length >= 4) {
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

/**
 * Check if a point is inside a rectangle
 */
const pointInRect = (
  px: number,
  py: number,
  rect: { x: number; y: number; width: number; height: number }
): boolean => {
  return px >= rect.x && px <= rect.x + rect.width &&
         py >= rect.y && py <= rect.y + rect.height;
};

/**
 * Check if two line segments intersect
 * Uses cross product to determine if segments cross
 */
const segmentsIntersect = (
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): boolean => {
  const d1 = direction(x3, y3, x4, y4, x1, y1);
  const d2 = direction(x3, y3, x4, y4, x2, y2);
  const d3 = direction(x1, y1, x2, y2, x3, y3);
  const d4 = direction(x1, y1, x2, y2, x4, y4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  // Check for collinear cases
  if (d1 === 0 && onSegment(x3, y3, x4, y4, x1, y1)) return true;
  if (d2 === 0 && onSegment(x3, y3, x4, y4, x2, y2)) return true;
  if (d3 === 0 && onSegment(x1, y1, x2, y2, x3, y3)) return true;
  if (d4 === 0 && onSegment(x1, y1, x2, y2, x4, y4)) return true;

  return false;
};

const direction = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number => {
  return (x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1);
};

const onSegment = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): boolean => {
  return Math.min(x1, x2) <= x3 && x3 <= Math.max(x1, x2) &&
         Math.min(y1, y2) <= y3 && y3 <= Math.max(y1, y2);
};

/**
 * Check if a line segment intersects with a rectangle
 * Used for marquee selection of lines/arrows
 */
export const lineIntersectsRect = (
  x1: number, y1: number, x2: number, y2: number,
  rect: { x: number; y: number; width: number; height: number }
): boolean => {
  // Check if either endpoint is inside the rectangle
  if (pointInRect(x1, y1, rect) || pointInRect(x2, y2, rect)) {
    return true;
  }

  // Check if line crosses any edge of the rectangle
  const rx1 = rect.x;
  const ry1 = rect.y;
  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;

  // Top edge
  if (segmentsIntersect(x1, y1, x2, y2, rx1, ry1, rx2, ry1)) return true;
  // Bottom edge
  if (segmentsIntersect(x1, y1, x2, y2, rx1, ry2, rx2, ry2)) return true;
  // Left edge
  if (segmentsIntersect(x1, y1, x2, y2, rx1, ry1, rx1, ry2)) return true;
  // Right edge
  if (segmentsIntersect(x1, y1, x2, y2, rx2, ry1, rx2, ry2)) return true;

  return false;
};

/**
 * Check if a shape intersects with a rectangle (for marquee selection)
 * Handles special cases for lines/arrows that need line-rect intersection
 */
export const shapeIntersectsRect = (
  shape: CanvasShape,
  rect: { x: number; y: number; width: number; height: number }
): boolean => {
  // For lines and arrows, use line-rectangle intersection
  if ((shape.type === 'line' || shape.type === 'arrow') && shape.points && shape.points.length >= 4) {
    const [x1, y1, x2, y2] = shape.points;
    return lineIntersectsRect(x1, y1, x2, y2, rect);
  }

  // For all other shapes, use bounding box intersection
  const shapeBounds = getShapeBounds(shape);
  return rectsIntersect(rect, shapeBounds);
};
