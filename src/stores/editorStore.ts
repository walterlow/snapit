import { create } from 'zustand';
import type { CanvasShape, CompositorSettings, BlurType } from '../types';
import { DEFAULT_COMPOSITOR_SETTINGS } from '../types';

// Canvas bounds for non-destructive crop/expand
export interface CanvasBounds {
  width: number;
  height: number;
  imageOffsetX: number;
  imageOffsetY: number;
}

// Snapshot of undoable state
interface HistorySnapshot {
  shapes: CanvasShape[];
  canvasBounds: CanvasBounds | null;
  estimatedBytes: number; // Memory estimate for this snapshot
}

// History configuration
const HISTORY_LIMIT = 50; // Max number of entries
const HISTORY_MEMORY_LIMIT = 50 * 1024 * 1024; // 50MB max memory for history

/**
 * Estimate the memory size of a snapshot in bytes.
 * This is an approximation based on typical object overhead and string sizes.
 */
function estimateSnapshotSize(snapshot: Omit<HistorySnapshot, 'estimatedBytes'>): number {
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

// History state managed within Zustand store
interface HistoryState {
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  pendingSnapshot: HistorySnapshot | null;
}

// Preview state for smooth slider interactions (only affects CSS preview, not Konva)
export interface CompositorPreview {
  padding?: number;
  borderRadius?: number;
  shadowIntensity?: number;
  gradientAngle?: number;
}

interface EditorState {
  shapes: CanvasShape[];
  selectedIds: string[];
  stepCount: number;
  compositorSettings: CompositorSettings;
  showCompositor: boolean;

  // Preview state for smooth slider updates (CSS-only, no Konva re-render)
  compositorPreview: CompositorPreview | null;

  // Blur tool settings
  blurType: BlurType;
  blurAmount: number;

  // Text tool settings
  fontSize: number;

  // Canvas bounds (null = use image size, no crop/expand)
  canvasBounds: CanvasBounds | null;
  originalImageSize: { width: number; height: number } | null;

  // History state (now part of store for better observability)
  history: HistoryState;
  canUndo: boolean;
  canRedo: boolean;

  // Actions
  setShapes: (shapes: CanvasShape[]) => void;
  setSelectedIds: (ids: string[]) => void;
  updateShape: (id: string, updates: Partial<CanvasShape>) => void;
  incrementStepCount: () => void;
  resetStepCount: () => void;
  clearEditor: () => void;
  setCompositorSettings: (settings: Partial<CompositorSettings>) => void;
  setCompositorPreview: (preview: CompositorPreview | null) => void;
  toggleCompositor: () => void;
  setShowCompositor: (show: boolean) => void;
  setBlurType: (type: BlurType) => void;
  setBlurAmount: (amount: number) => void;
  setFontSize: (size: number) => void;
  setCanvasBounds: (bounds: CanvasBounds | null) => void;
  setOriginalImageSize: (size: { width: number; height: number }) => void;
  resetCanvasBounds: () => void;

  // History actions (internal, called via exported functions)
  _takeSnapshot: () => void;
  _commitSnapshot: () => void;
  _discardSnapshot: () => void;
  _undo: () => boolean;
  _redo: () => boolean;
  _clearHistory: () => void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  shapes: [],
  selectedIds: [],
  stepCount: 1,
  compositorSettings: { ...DEFAULT_COMPOSITOR_SETTINGS },
  showCompositor: false,
  compositorPreview: null,
  blurType: 'pixelate' as BlurType,
  blurAmount: 15,
  fontSize: 36,
  canvasBounds: null,
  originalImageSize: null,

  // History state - now part of Zustand for better observability
  history: {
    undoStack: [],
    redoStack: [],
    pendingSnapshot: null,
  },
  canUndo: false,
  canRedo: false,

  setShapes: (shapes) => set({ shapes }),
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  updateShape: (id, updates) => set((state) => ({
    shapes: state.shapes.map(shape =>
      shape.id === id ? { ...shape, ...updates } : shape
    ),
  })),
  incrementStepCount: () => set((state) => ({ stepCount: state.stepCount + 1 })),
  resetStepCount: () => set({ stepCount: 1 }),
  clearEditor: () => set({
    shapes: [],
    selectedIds: [],
    stepCount: 1,
    compositorSettings: { ...DEFAULT_COMPOSITOR_SETTINGS },
    showCompositor: false,
    compositorPreview: null,
    blurType: 'pixelate' as BlurType,
    blurAmount: 15,
    fontSize: 36,
    canvasBounds: null,
    originalImageSize: null,
  }),
  setCompositorSettings: (settings) => {
    set((state) => ({
      compositorSettings: { ...state.compositorSettings, ...settings },
      // Clear preview when settings are committed
      compositorPreview: null,
    }));
  },
  setCompositorPreview: (preview) => set({ compositorPreview: preview }),
  toggleCompositor: () => {
    set((state) => ({
      compositorSettings: {
        ...state.compositorSettings,
        enabled: !state.compositorSettings.enabled
      },
    }));
  },
  setShowCompositor: (show) => set({ showCompositor: show }),
  setBlurType: (type) => set({ blurType: type }),
  setBlurAmount: (amount) => set({ blurAmount: amount }),
  setFontSize: (size) => set({ fontSize: size }),
  setCanvasBounds: (bounds) => set({ canvasBounds: bounds }),
  setOriginalImageSize: (size) => set({ originalImageSize: size }),
  resetCanvasBounds: () => {
    const { originalImageSize } = get();
    if (originalImageSize) {
      set({
        canvasBounds: {
          width: originalImageSize.width,
          height: originalImageSize.height,
          imageOffsetX: 0,
          imageOffsetY: 0,
        },
      });
    } else {
      set({ canvasBounds: null });
    }
  },

  // History actions
  _takeSnapshot: () => {
    const { history, shapes, canvasBounds } = get();
    if (history.pendingSnapshot) return; // Already have a pending snapshot

    const snapshot = {
      shapes: structuredClone(shapes),
      canvasBounds: canvasBounds ? structuredClone(canvasBounds) : null,
    };

    set({
      history: {
        ...history,
        pendingSnapshot: {
          ...snapshot,
          estimatedBytes: estimateSnapshotSize(snapshot),
        },
      },
    });
  },

  _commitSnapshot: () => {
    const { history, shapes, canvasBounds } = get();
    if (!history.pendingSnapshot) return;

    const prev = history.pendingSnapshot;

    // Quick change detection: compare array lengths first, then do shallow checks
    const shapesChanged =
      prev.shapes.length !== shapes.length ||
      prev.shapes.some((s, i) => s.id !== shapes[i]?.id);
    const boundsChanged =
      (prev.canvasBounds === null) !== (canvasBounds === null) ||
      (prev.canvasBounds &&
        canvasBounds &&
        (prev.canvasBounds.width !== canvasBounds.width ||
          prev.canvasBounds.height !== canvasBounds.height ||
          prev.canvasBounds.imageOffsetX !== canvasBounds.imageOffsetX ||
          prev.canvasBounds.imageOffsetY !== canvasBounds.imageOffsetY));

    if (shapesChanged || boundsChanged) {
      let newUndoStack = [...history.undoStack, prev];

      // Enforce entry count limit
      while (newUndoStack.length > HISTORY_LIMIT) {
        newUndoStack.shift();
      }

      // Enforce memory limit - remove oldest entries until under limit
      let totalBytes = newUndoStack.reduce((sum, s) => sum + s.estimatedBytes, 0);
      while (totalBytes > HISTORY_MEMORY_LIMIT && newUndoStack.length > 1) {
        const removed = newUndoStack.shift();
        if (removed) {
          totalBytes -= removed.estimatedBytes;
        }
      }

      set({
        history: {
          undoStack: newUndoStack,
          redoStack: [], // Clear redo on new action
          pendingSnapshot: null,
        },
        canUndo: true,
        canRedo: false,
      });
    } else {
      set({
        history: { ...history, pendingSnapshot: null },
      });
    }
  },

  _discardSnapshot: () => {
    set((state) => ({
      history: { ...state.history, pendingSnapshot: null },
    }));
  },

  _undo: () => {
    const { history, shapes, canvasBounds } = get();
    if (history.undoStack.length === 0) return false;

    // Save current state to redo stack
    const currentSnapshot = {
      shapes: structuredClone(shapes),
      canvasBounds: canvasBounds ? structuredClone(canvasBounds) : null,
    };
    const newRedoStack = [
      ...history.redoStack,
      {
        ...currentSnapshot,
        estimatedBytes: estimateSnapshotSize(currentSnapshot),
      },
    ];

    // Get and remove last undo state
    const newUndoStack = [...history.undoStack];
    const snapshot = newUndoStack.pop()!;

    set({
      shapes: snapshot.shapes,
      canvasBounds: snapshot.canvasBounds,
      history: {
        undoStack: newUndoStack,
        redoStack: newRedoStack,
        pendingSnapshot: null,
      },
      canUndo: newUndoStack.length > 0,
      canRedo: true,
    });

    return true;
  },

  _redo: () => {
    const { history, shapes, canvasBounds } = get();
    if (history.redoStack.length === 0) return false;

    // Save current state to undo stack
    const currentSnapshot = {
      shapes: structuredClone(shapes),
      canvasBounds: canvasBounds ? structuredClone(canvasBounds) : null,
    };
    const newUndoStack = [
      ...history.undoStack,
      {
        ...currentSnapshot,
        estimatedBytes: estimateSnapshotSize(currentSnapshot),
      },
    ];

    // Get and remove last redo state
    const newRedoStack = [...history.redoStack];
    const snapshot = newRedoStack.pop()!;

    set({
      shapes: snapshot.shapes,
      canvasBounds: snapshot.canvasBounds,
      history: {
        undoStack: newUndoStack,
        redoStack: newRedoStack,
        pendingSnapshot: null,
      },
      canUndo: true,
      canRedo: newRedoStack.length > 0,
    });

    return true;
  },

  _clearHistory: () => {
    set({
      history: {
        undoStack: [],
        redoStack: [],
        pendingSnapshot: null,
      },
      canUndo: false,
      canRedo: false,
    });
  },
}));

// ============================================================================
// Exported convenience functions (maintain backwards compatibility)
// ============================================================================

/**
 * Take a snapshot BEFORE starting a user action (drag, transform, etc.)
 * Call this in onDragStart, onTransformStart, before shape creation, etc.
 */
export const takeSnapshot = () => useEditorStore.getState()._takeSnapshot();

/**
 * Commit the pending snapshot to history AFTER an action completes
 * Call this in onDragEnd, onTransformEnd, after shape creation, etc.
 */
export const commitSnapshot = () => useEditorStore.getState()._commitSnapshot();

/**
 * Discard pending snapshot without committing (e.g., action cancelled)
 */
export const discardSnapshot = () => useEditorStore.getState()._discardSnapshot();

/**
 * Undo last action
 */
export const undo = () => useEditorStore.getState()._undo();

/**
 * Redo last undone action
 */
export const redo = () => useEditorStore.getState()._redo();

/**
 * Clear all history (e.g., when loading new image)
 */
export const clearHistory = () => useEditorStore.getState()._clearHistory();

/**
 * Convenience: take snapshot + commit in one call for instant actions
 * Use for actions that don't have a drag phase (e.g., delete, paste)
 */
export const recordAction = (action: () => void) => {
  takeSnapshot();
  action();
  commitSnapshot();
};
