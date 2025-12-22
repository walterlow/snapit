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
}

// Manual history management - explicit snapshots only
// No automatic tracking, no fighting with continuous updates
const HISTORY_LIMIT = 50;
let undoStack: HistorySnapshot[] = [];
let redoStack: HistorySnapshot[] = [];
let pendingSnapshot: HistorySnapshot | null = null;

// Helper to update reactive history state in the store
const updateHistoryState = () => {
  useEditorStore.setState({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });
};

// Take a snapshot BEFORE starting a user action (drag, transform, etc.)
// Call this in onDragStart, onTransformStart, before shape creation, etc.
export const takeSnapshot = () => {
  if (pendingSnapshot) return; // Already have a pending snapshot

  const state = useEditorStore.getState();
  pendingSnapshot = {
    shapes: structuredClone(state.shapes),
    canvasBounds: state.canvasBounds ? structuredClone(state.canvasBounds) : null,
  };
};

// Commit the pending snapshot to history AFTER an action completes
// Call this in onDragEnd, onTransformEnd, after shape creation, etc.
export const commitSnapshot = () => {
  if (!pendingSnapshot) return;
  
  const state = useEditorStore.getState();
  const currentSnapshot: HistorySnapshot = {
    shapes: state.shapes,
    canvasBounds: state.canvasBounds,
  };
  
  // Only commit if state actually changed
  const shapesChanged = JSON.stringify(pendingSnapshot.shapes) !== JSON.stringify(currentSnapshot.shapes);
  const boundsChanged = JSON.stringify(pendingSnapshot.canvasBounds) !== JSON.stringify(currentSnapshot.canvasBounds);
  
  if (shapesChanged || boundsChanged) {
    undoStack.push(pendingSnapshot);
    if (undoStack.length > HISTORY_LIMIT) {
      undoStack.shift();
    }
    redoStack = []; // Clear redo on new action
    updateHistoryState();
  }
  
  pendingSnapshot = null;
};

// Discard pending snapshot without committing (e.g., action cancelled)
export const discardSnapshot = () => {
  pendingSnapshot = null;
};

// Undo last action
export const undo = () => {
  if (undoStack.length === 0) return false;

  const state = useEditorStore.getState();

  // Save current state to redo stack
  redoStack.push({
    shapes: structuredClone(state.shapes),
    canvasBounds: state.canvasBounds ? structuredClone(state.canvasBounds) : null,
  });
  
  // Restore previous state
  const snapshot = undoStack.pop()!;
  state.setShapes(snapshot.shapes);
  state.setCanvasBounds(snapshot.canvasBounds);
  updateHistoryState();
  
  return true;
};

// Redo last undone action
export const redo = () => {
  if (redoStack.length === 0) return false;

  const state = useEditorStore.getState();

  // Save current state to undo stack
  undoStack.push({
    shapes: structuredClone(state.shapes),
    canvasBounds: state.canvasBounds ? structuredClone(state.canvasBounds) : null,
  });
  
  // Restore redo state
  const snapshot = redoStack.pop()!;
  state.setShapes(snapshot.shapes);
  state.setCanvasBounds(snapshot.canvasBounds);
  updateHistoryState();
  
  return true;
};

// Clear all history (e.g., when loading new image)
export const clearHistory = () => {
  undoStack = [];
  redoStack = [];
  pendingSnapshot = null;
  updateHistoryState();
};

// Convenience: take snapshot + commit in one call for instant actions
// Use for actions that don't have a drag phase (e.g., delete, paste)
export const recordAction = (action: () => void) => {
  takeSnapshot();
  action();
  commitSnapshot();
};

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

  // History state (reactive for UI)
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
}));
