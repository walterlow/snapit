import { create } from 'zustand';
import { temporal, type TemporalState } from 'zundo';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { CanvasShape, CompositorSettings, BlurType } from '../types';
import { DEFAULT_COMPOSITOR_SETTINGS } from '../types';

// Canvas bounds for non-destructive crop/expand
// Image is positioned at (imageOffset.x, imageOffset.y) within the canvas
export interface CanvasBounds {
  width: number;
  height: number;
  imageOffsetX: number; // Where the image sits on canvas (positive = space before image)
  imageOffsetY: number;
}

interface EditorState {
  shapes: CanvasShape[];
  selectedIds: string[];
  stepCount: number;
  compositorSettings: CompositorSettings;
  showCompositor: boolean;
  
  // Blur tool settings
  blurType: BlurType;
  blurAmount: number;

  // Canvas bounds (null = use image size, no crop/expand)
  canvasBounds: CanvasBounds | null;
  originalImageSize: { width: number; height: number } | null;

  // Actions
  setShapes: (shapes: CanvasShape[]) => void;
  setSelectedIds: (ids: string[]) => void;
  updateShape: (id: string, updates: Partial<CanvasShape>) => void;
  incrementStepCount: () => void;
  resetStepCount: () => void;
  clearEditor: () => void;
  setCompositorSettings: (settings: Partial<CompositorSettings>) => void;
  toggleCompositor: () => void;
  setShowCompositor: (show: boolean) => void;
  setBlurType: (type: BlurType) => void;
  setBlurAmount: (amount: number) => void;
  setCanvasBounds: (bounds: CanvasBounds | null) => void;
  setOriginalImageSize: (size: { width: number; height: number }) => void;
  resetCanvasBounds: () => void; // Reset to original image size
}

export const useEditorStore = create<EditorState>()(
  temporal(
    (set, get) => ({
      shapes: [],
      selectedIds: [],
      stepCount: 1,
      compositorSettings: { ...DEFAULT_COMPOSITOR_SETTINGS },
      showCompositor: false,
      blurType: 'pixelate' as BlurType,
      blurAmount: 10,
      canvasBounds: null,
      originalImageSize: null,

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
        blurType: 'pixelate' as BlurType,
        blurAmount: 10,
        canvasBounds: null,
        originalImageSize: null,
      }),
      setCompositorSettings: (settings) => set((state) => ({
        compositorSettings: { ...state.compositorSettings, ...settings },
      })),
      toggleCompositor: () => set((state) => ({
        compositorSettings: {
          ...state.compositorSettings,
          enabled: !state.compositorSettings.enabled
        },
      })),
      setShowCompositor: (show) => set({ showCompositor: show }),
      setBlurType: (type) => set({ blurType: type }),
      setBlurAmount: (amount) => set({ blurAmount: amount }),
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
    }),
    {
      limit: 50, // Max 50 undo states
      equality: (pastState, currentState) =>
        JSON.stringify(pastState.shapes) === JSON.stringify(currentState.shapes) &&
        JSON.stringify(pastState.canvasBounds) === JSON.stringify(currentState.canvasBounds),
    }
  )
);

// Hook to access temporal state reactively
export const useTemporalStore = <T>(
  selector: (state: TemporalState<EditorState>) => T
): T => {
  return useStoreWithEqualityFn(useEditorStore.temporal, selector);
};
