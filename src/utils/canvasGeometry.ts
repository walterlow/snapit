/**
 * Canvas geometry utilities for coordinate transformations and bounds calculations
 */

import type { CanvasShape } from '../types';
import { editorLogger } from './logger';

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
    editorLogger.error('Failed to get 2D canvas context for checker pattern');
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
 * Transform screen position to canvas position (accounting for zoom and pan).
 * Converts mouse/pointer coordinates from screen space to canvas space,
 * factoring in the current pan offset and zoom level.
 *
 * @param screenPos - The position in screen/viewport coordinates
 * @param position - The current canvas pan offset (top-left origin)
 * @param zoom - The current zoom level (1.0 = 100%)
 * @returns The corresponding position in canvas coordinates
 *
 * @example
 * // Convert mouse event coordinates to canvas position
 * const canvasPos = screenToCanvas(
 *   { x: event.clientX, y: event.clientY },
 *   { x: canvasOffsetX, y: canvasOffsetY },
 *   currentZoom
 * );
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
 * Get the bounding box for any shape type.
 * Calculates the axis-aligned bounding box (AABB) for rectangles, circles,
 * ellipses, arrows, lines, pen strokes, and other shape types.
 *
 * @param shape - The canvas shape to calculate bounds for
 * @returns The bounding box with x, y (top-left corner), width, and height
 *
 * @example
 * // Get bounds for hit testing
 * const bounds = getShapeBounds(selectedShape);
 * if (pointInBounds(mouseX, mouseY, bounds)) {
 *   // Shape was clicked
 * }
 *
 * @example
 * // Get bounds for a circle (uses radiusX/radiusY or radius)
 * const circleBounds = getShapeBounds({
 *   type: 'circle',
 *   x: 100, y: 100,
 *   radius: 50
 * });
 * // Returns: { x: 50, y: 50, width: 100, height: 100 }
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
 * Compute the combined bounding box of multiple shapes for group selection.
 * Calculates the smallest rectangle that contains all selected shapes,
 * with optional padding around the edges.
 *
 * @param shapes - All shapes in the canvas
 * @param selectedIds - Array of IDs for the selected shapes
 * @param padding - Padding in pixels around the bounding box (default: 4)
 * @returns The combined bounding box, or null if fewer than 2 shapes are selected
 *
 * @example
 * // Draw selection rectangle around multiple selected shapes
 * const bounds = getSelectionBounds(allShapes, ['shape1', 'shape2', 'shape3']);
 * if (bounds) {
 *   ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
 * }
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
 * Compute visible content bounds based on crop settings.
 * Determines what portion of the source image should be displayed,
 * accounting for active crop regions and crop mode state.
 *
 * @param image - The source image element (may be undefined if not loaded)
 * @param canvasBounds - Current canvas bounds including crop offsets and dimensions
 * @param isCropMode - Whether the crop tool is currently active
 * @returns The visible bounds rectangle, or null if no image is available
 *
 * @example
 * // Get visible area for rendering
 * const visible = getVisibleBounds(imageElement, cropBounds, isEditing);
 * if (visible) {
 *   ctx.drawImage(image,
 *     visible.x, visible.y, visible.width, visible.height,
 *     0, 0, visible.width, visible.height
 *   );
 * }
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
 * Calculate composition size with padding for the compositor.
 * Adds padding around the content when compositor effects are enabled
 * (e.g., background gradients, shadows, rounded corners).
 *
 * @param contentWidth - The width of the actual content in pixels
 * @param contentHeight - The height of the actual content in pixels
 * @param paddingPx - The padding to add on each side in pixels
 * @param compositorEnabled - Whether compositor effects are active
 * @returns The total composition dimensions (width and height)
 *
 * @example
 * // Calculate canvas size for export with compositor padding
 * const size = getCompositionSize(imageWidth, imageHeight, 48, true);
 * // If compositorEnabled: { width: imageWidth + 96, height: imageHeight + 96 }
 * // If not enabled: { width: imageWidth, height: imageHeight }
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
 * Check if two rectangles intersect (overlap).
 * Used for marquee selection to determine which shapes fall within the selection area.
 * Uses axis-aligned bounding box (AABB) intersection test.
 *
 * @param a - First rectangle with x, y (top-left), width, and height
 * @param b - Second rectangle with x, y (top-left), width, and height
 * @returns True if the rectangles overlap, false otherwise
 *
 * @example
 * // Check if marquee selection overlaps a shape's bounds
 * const marquee = { x: 100, y: 100, width: 200, height: 150 };
 * const shapeBounds = getShapeBounds(shape);
 * if (rectsIntersect(marquee, shapeBounds)) {
 *   selectShape(shape.id);
 * }
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
 * Check if a point is inside a rectangle.
 * Tests if the given coordinates fall within the rectangle's bounds (inclusive).
 *
 * @param px - The x-coordinate of the point
 * @param py - The y-coordinate of the point
 * @param rect - The rectangle to test against
 * @returns True if the point is inside or on the edge of the rectangle
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
 * Check if two line segments intersect.
 * Uses cross product orientation tests to determine if segments cross,
 * including handling collinear edge cases.
 *
 * @param x1 - X-coordinate of first segment's start point
 * @param y1 - Y-coordinate of first segment's start point
 * @param x2 - X-coordinate of first segment's end point
 * @param y2 - Y-coordinate of first segment's end point
 * @param x3 - X-coordinate of second segment's start point
 * @param y3 - Y-coordinate of second segment's start point
 * @param x4 - X-coordinate of second segment's end point
 * @param y4 - Y-coordinate of second segment's end point
 * @returns True if the line segments intersect
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

/**
 * Calculate the cross product direction for three points.
 * Used to determine the orientation (clockwise, counterclockwise, or collinear)
 * of three points for line segment intersection tests.
 *
 * @param x1 - X-coordinate of first point
 * @param y1 - Y-coordinate of first point
 * @param x2 - X-coordinate of second point
 * @param y2 - Y-coordinate of second point
 * @param x3 - X-coordinate of third point
 * @param y3 - Y-coordinate of third point
 * @returns Positive for counterclockwise, negative for clockwise, 0 for collinear
 */
const direction = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number => {
  return (x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1);
};

/**
 * Check if a point lies on a line segment (for collinear case).
 * Used when three points are collinear to verify the third point
 * falls within the segment bounds.
 *
 * @param x1 - X-coordinate of segment start
 * @param y1 - Y-coordinate of segment start
 * @param x2 - X-coordinate of segment end
 * @param y2 - Y-coordinate of segment end
 * @param x3 - X-coordinate of point to test
 * @param y3 - Y-coordinate of point to test
 * @returns True if point (x3, y3) lies on the segment from (x1, y1) to (x2, y2)
 */
const onSegment = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): boolean => {
  return Math.min(x1, x2) <= x3 && x3 <= Math.max(x1, x2) &&
         Math.min(y1, y2) <= y3 && y3 <= Math.max(y1, y2);
};

/**
 * Check if a line segment intersects with a rectangle.
 * Used for marquee selection of line-based shapes like arrows and lines.
 * Returns true if the line passes through or has endpoints inside the rectangle.
 *
 * @param x1 - X-coordinate of line segment start
 * @param y1 - Y-coordinate of line segment start
 * @param x2 - X-coordinate of line segment end
 * @param y2 - Y-coordinate of line segment end
 * @param rect - The rectangle to test against
 * @returns True if the line segment intersects or is contained within the rectangle
 *
 * @example
 * // Check if an arrow is within marquee selection
 * const [startX, startY, endX, endY] = arrow.points;
 * if (lineIntersectsRect(startX, startY, endX, endY, marqueeRect)) {
 *   selectShape(arrow.id);
 * }
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
 * Check if a shape intersects with a rectangle (for marquee selection).
 * Handles different shape types appropriately:
 * - Lines and arrows use line-rectangle intersection
 * - All other shapes use bounding box intersection
 *
 * @param shape - The canvas shape to test
 * @param rect - The rectangle to test against (typically the marquee selection area)
 * @returns True if the shape intersects with the rectangle
 *
 * @example
 * // Select all shapes within marquee
 * const selectedIds = shapes
 *   .filter(shape => shapeIntersectsRect(shape, marqueeRect))
 *   .map(shape => shape.id);
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
