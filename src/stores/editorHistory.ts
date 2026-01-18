/**
 * Editor history management utilities.
 * Provides structural sharing and memory estimation for undo/redo snapshots.
 */

import type { CanvasShape, CanvasBounds } from '../types';

/** Snapshot of undoable state */
export interface HistorySnapshot {
  shapes: CanvasShape[];
  canvasBounds: CanvasBounds | null;
  estimatedBytes: number;
}

/** History state managed within Zustand store */
export interface HistoryState {
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  pendingSnapshot: HistorySnapshot | null;
}

/** Cache for shape hashes to detect changes efficiently */
const shapeHashCache = new WeakMap<CanvasShape, string>();

/**
 * Compute a lightweight hash for a shape to detect changes.
 * Uses JSON.stringify for reliable comparison but caches results.
 */
export function getShapeHash(shape: CanvasShape): string {
  let hash = shapeHashCache.get(shape);
  if (!hash) {
    // Create hash from all mutable properties
    hash = JSON.stringify({
      // Position & dimensions
      x: shape.x,
      y: shape.y,
      width: shape.width,
      height: shape.height,
      rotation: shape.rotation,
      points: shape.points,
      // Circle/ellipse radius
      radius: shape.radius,
      radiusX: shape.radiusX,
      radiusY: shape.radiusY,
      // Text properties
      text: shape.text,
      fontSize: shape.fontSize,
      fontFamily: shape.fontFamily,
      fontStyle: shape.fontStyle,
      textDecoration: shape.textDecoration,
      align: shape.align,
      verticalAlign: shape.verticalAlign,
      wrap: shape.wrap,
      lineHeight: shape.lineHeight,
      // Style properties
      fill: shape.fill,
      stroke: shape.stroke,
      strokeWidth: shape.strokeWidth,
      // Step number
      number: shape.number,
      // Blur properties
      blurType: shape.blurType,
      blurAmount: shape.blurAmount,
      pixelSize: shape.pixelSize,
    });
    shapeHashCache.set(shape, hash);
  }
  return hash;
}

/**
 * Create a snapshot of shapes with structural sharing.
 * Only clones shapes that have actually changed, reuses references otherwise.
 * This significantly reduces memory usage when only a few shapes change.
 */
export function createShapesSnapshot(
  currentShapes: CanvasShape[],
  previousSnapshot: CanvasShape[] | null
): CanvasShape[] {
  if (!previousSnapshot) {
    // First snapshot - need to clone everything
    return currentShapes.map(shape => ({ ...shape }));
  }

  // Build a map of previous shapes by ID for O(1) lookup
  const prevShapeMap = new Map<string, CanvasShape>();
  for (const shape of previousSnapshot) {
    prevShapeMap.set(shape.id, shape);
  }

  // Create new array, reusing unchanged shape references
  return currentShapes.map(shape => {
    const prevShape = prevShapeMap.get(shape.id);
    if (prevShape && getShapeHash(shape) === getShapeHash(prevShape)) {
      // Shape unchanged - reuse the previous reference
      return prevShape;
    }
    // Shape is new or changed - create shallow clone
    return { ...shape };
  });
}

/**
 * Estimate the memory size of a snapshot in bytes.
 * This is an approximation based on typical object overhead and string sizes.
 */
export function estimateSnapshotSize(snapshot: Omit<HistorySnapshot, 'estimatedBytes'>): number {
  let bytes = 0;

  // Base object overhead
  bytes += 64;

  // Estimate shapes array
  for (const shape of snapshot.shapes) {
    // Base shape overhead
    bytes += 200;

    // Points array (pen strokes, lines, arrows)
    if (shape.points) {
      bytes += shape.points.length * 8; // 8 bytes per number
    }

    // Text content
    if (shape.text) {
      bytes += shape.text.length * 2; // 2 bytes per char (UTF-16)
    }
  }

  // Canvas bounds (if present)
  if (snapshot.canvasBounds) {
    bytes += 64;
  }

  return bytes;
}

/**
 * Check if canvas bounds have changed.
 */
export function haveBoundsChanged(
  prev: CanvasBounds | null,
  current: CanvasBounds | null
): boolean {
  if ((prev === null) !== (current === null)) return true;
  if (!prev || !current) return false;
  return (
    prev.width !== current.width ||
    prev.height !== current.height ||
    prev.imageOffsetX !== current.imageOffsetX ||
    prev.imageOffsetY !== current.imageOffsetY
  );
}

/**
 * Check if shapes have changed (by ID, count, and properties).
 */
export function haveShapesChanged(
  prevShapes: CanvasShape[],
  currentShapes: CanvasShape[]
): boolean {
  if (prevShapes.length !== currentShapes.length) return true;
  return prevShapes.some((s, i) =>
    s.id !== currentShapes[i]?.id ||
    getShapeHash(s) !== getShapeHash(currentShapes[i])
  );
}
