import { create, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { CanvasShape, CompositorSettings, BlurType, CanvasBounds } from '../types';
import { DEFAULT_COMPOSITOR_SETTINGS } from '../types';
import { STORAGE } from '../constants';
import {
  type HistoryState,
  createShapesSnapshot,
  estimateSnapshotSize,
  haveBoundsChanged,
  haveShapesChanged,
} from './editorHistory';
import { useEditorStoreContext } from './EditorStoreProvider';

// Re-export CanvasBounds for backward compatibility
export type { CanvasBounds } from '../types';

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

  // Drawing tool settings
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;

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
  setStrokeColor: (color: string) => void;
  setFillColor: (color: string) => void;
  setStrokeWidth: (width: number) => void;
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

// ============================================================================
// Store Factory
// ============================================================================

/**
 * Create an editor store instance.
 * Used for window-based editors where each window has its own store.
 */
export const createEditorStore = () => create<EditorState>()(
  devtools(
    (set, get) => ({
  shapes: [],
  selectedIds: [],
  stepCount: 1,
  compositorSettings: { ...DEFAULT_COMPOSITOR_SETTINGS },
  showCompositor: false,
  compositorPreview: null,
  blurType: 'pixelate' as BlurType,
  blurAmount: 15,
  fontSize: 36,
  strokeColor: '#ef4444',
  fillColor: 'transparent',
  strokeWidth: 3,
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
  setStrokeColor: (color) => set({ strokeColor: color }),
  setFillColor: (color) => set({ fillColor: color }),
  setStrokeWidth: (width) => set({ strokeWidth: width }),
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

    // Use structural sharing to reduce memory usage
    // Get the most recent snapshot's shapes for reference comparison
    const lastSnapshotShapes = history.undoStack.length > 0
      ? history.undoStack[history.undoStack.length - 1].shapes
      : null;

    const snapshot = {
      shapes: createShapesSnapshot(shapes, lastSnapshotShapes),
      canvasBounds: canvasBounds ? { ...canvasBounds } : null,
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
    const shapesChanged = haveShapesChanged(prev.shapes, shapes);
    const boundsChanged = haveBoundsChanged(prev.canvasBounds, canvasBounds);

    if (shapesChanged || boundsChanged) {
      const newUndoStack = [...history.undoStack, prev];

      // Enforce entry count limit
      while (newUndoStack.length > STORAGE.HISTORY_LIMIT) {
        newUndoStack.shift();
      }

      // Enforce memory limit - remove oldest entries until under limit
      let totalBytes = newUndoStack.reduce((sum, s) => sum + s.estimatedBytes, 0);
      while (totalBytes > STORAGE.HISTORY_MEMORY_LIMIT_BYTES && newUndoStack.length > 1) {
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

    // Save current state to redo stack with structural sharing
    const lastSnapshot = history.undoStack[history.undoStack.length - 1];
    const currentSnapshot = {
      shapes: createShapesSnapshot(shapes, lastSnapshot?.shapes ?? null),
      canvasBounds: canvasBounds ? { ...canvasBounds } : null,
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

    // Save current state to undo stack with structural sharing
    const lastSnapshot = history.undoStack.length > 0
      ? history.undoStack[history.undoStack.length - 1]
      : null;
    const currentSnapshot = {
      shapes: createShapesSnapshot(shapes, lastSnapshot?.shapes ?? null),
      canvasBounds: canvasBounds ? { ...canvasBounds } : null,
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
}),
    { name: 'EditorStore', enabled: process.env.NODE_ENV === 'development' }
  )
);

// ============================================================================
// Store Types
// ============================================================================

export type EditorStore = ReturnType<typeof createEditorStore>;

// Re-export provider from separate file (JSX requires .tsx)
export { EditorStoreProvider } from './EditorStoreProvider';

// ============================================================================
// Store Hook
// ============================================================================

/**
 * Hook to access the editor store from context.
 * Must be used within an EditorStoreProvider.
 */
export function useEditorStore(): EditorState;
export function useEditorStore<T>(selector: (state: EditorState) => T): T;
export function useEditorStore<T>(selector?: (state: EditorState) => T): T | EditorState {
  const store = useEditorStoreContext();

  if (!store) {
    throw new Error('useEditorStore must be used within an EditorStoreProvider');
  }

  // useStore must be called unconditionally to satisfy React hooks rules
  // Type assertion is safe because overloads guarantee correct usage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useStore(store, (selector ?? ((state: EditorState) => state)) as any);
}
