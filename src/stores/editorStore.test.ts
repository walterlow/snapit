import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, takeSnapshot, commitSnapshot, undo, redo, clearHistory, recordAction } from './editorStore';
import type { CanvasShape } from '../types';

// Helper to create a test shape
function createTestShape(overrides: Partial<CanvasShape> = {}): CanvasShape {
  return {
    id: `shape_${Date.now()}_${Math.random()}`,
    type: 'rectangle',
    x: 100,
    y: 100,
    width: 50,
    height: 50,
    rotation: 0,
    color: '#ff0000',
    strokeWidth: 2,
    ...overrides,
  };
}

describe('editorStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useEditorStore.setState({
      shapes: [],
      selectedIds: [],
      stepCount: 1,
      canvasBounds: null,
      originalImageSize: null,
      history: {
        undoStack: [],
        redoStack: [],
        pendingSnapshot: null,
      },
      canUndo: false,
      canRedo: false,
    });
  });

  describe('shapes management', () => {
    it('should set shapes', () => {
      const shapes = [createTestShape(), createTestShape()];
      useEditorStore.getState().setShapes(shapes);
      expect(useEditorStore.getState().shapes).toEqual(shapes);
    });

    it('should update a specific shape', () => {
      const shape1 = createTestShape({ id: 'shape1', x: 0 });
      const shape2 = createTestShape({ id: 'shape2', x: 100 });
      useEditorStore.getState().setShapes([shape1, shape2]);

      useEditorStore.getState().updateShape('shape1', { x: 50 });

      const shapes = useEditorStore.getState().shapes;
      expect(shapes[0].x).toBe(50);
      expect(shapes[1].x).toBe(100);
    });

    it('should handle updating non-existent shape gracefully', () => {
      const shape = createTestShape({ id: 'shape1' });
      useEditorStore.getState().setShapes([shape]);

      useEditorStore.getState().updateShape('nonexistent', { x: 50 });

      // Original shape unchanged
      expect(useEditorStore.getState().shapes[0]).toEqual(shape);
    });
  });

  describe('selection', () => {
    it('should set selected ids', () => {
      useEditorStore.getState().setSelectedIds(['id1', 'id2']);
      expect(useEditorStore.getState().selectedIds).toEqual(['id1', 'id2']);
    });

    it('should clear selection', () => {
      useEditorStore.getState().setSelectedIds(['id1']);
      useEditorStore.getState().setSelectedIds([]);
      expect(useEditorStore.getState().selectedIds).toEqual([]);
    });
  });

  describe('step count', () => {
    it('should increment step count', () => {
      expect(useEditorStore.getState().stepCount).toBe(1);
      useEditorStore.getState().incrementStepCount();
      expect(useEditorStore.getState().stepCount).toBe(2);
    });

    it('should reset step count', () => {
      useEditorStore.getState().incrementStepCount();
      useEditorStore.getState().incrementStepCount();
      useEditorStore.getState().resetStepCount();
      expect(useEditorStore.getState().stepCount).toBe(1);
    });
  });

  describe('undo/redo history', () => {
    it('should track canUndo and canRedo state', () => {
      expect(useEditorStore.getState().canUndo).toBe(false);
      expect(useEditorStore.getState().canRedo).toBe(false);

      // Make a change
      takeSnapshot();
      useEditorStore.getState().setShapes([createTestShape()]);
      commitSnapshot();

      expect(useEditorStore.getState().canUndo).toBe(true);
      expect(useEditorStore.getState().canRedo).toBe(false);
    });

    it('should undo a shape addition', () => {
      // Start with empty
      takeSnapshot();
      const shape = createTestShape();
      useEditorStore.getState().setShapes([shape]);
      commitSnapshot();

      expect(useEditorStore.getState().shapes).toHaveLength(1);

      // Undo
      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(0);
      expect(useEditorStore.getState().canRedo).toBe(true);
    });

    it('should redo an undone action', () => {
      takeSnapshot();
      const shape = createTestShape();
      useEditorStore.getState().setShapes([shape]);
      commitSnapshot();

      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(0);

      redo();
      expect(useEditorStore.getState().shapes).toHaveLength(1);
    });

    it('should clear redo stack on new action', () => {
      takeSnapshot();
      useEditorStore.getState().setShapes([createTestShape()]);
      commitSnapshot();

      undo();
      expect(useEditorStore.getState().canRedo).toBe(true);

      // New action
      takeSnapshot();
      useEditorStore.getState().setShapes([createTestShape(), createTestShape()]);
      commitSnapshot();

      expect(useEditorStore.getState().canRedo).toBe(false);
    });

    it('should not commit if no changes were made', () => {
      const shape = createTestShape();
      useEditorStore.getState().setShapes([shape]);

      takeSnapshot();
      // No changes
      commitSnapshot();

      expect(useEditorStore.getState().canUndo).toBe(false);
    });

    it('should clear history', () => {
      takeSnapshot();
      useEditorStore.getState().setShapes([createTestShape()]);
      commitSnapshot();

      expect(useEditorStore.getState().canUndo).toBe(true);

      clearHistory();

      expect(useEditorStore.getState().canUndo).toBe(false);
      expect(useEditorStore.getState().canRedo).toBe(false);
    });

    it('should support recordAction helper', () => {
      recordAction(() => {
        useEditorStore.getState().setShapes([createTestShape()]);
      });

      expect(useEditorStore.getState().shapes).toHaveLength(1);
      expect(useEditorStore.getState().canUndo).toBe(true);

      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(0);
    });
  });

  describe('history memory limits', () => {
    it('should limit history to 50 entries', () => {
      // Add 60 actions
      for (let i = 0; i < 60; i++) {
        takeSnapshot();
        useEditorStore.getState().setShapes([createTestShape({ id: `shape_${i}` })]);
        commitSnapshot();
      }

      // History should be capped at 50
      const { undoStack } = useEditorStore.getState().history;
      expect(undoStack.length).toBeLessThanOrEqual(50);
    });

    it('should estimate memory for shapes with points', () => {
      // Create a pen stroke with many points
      const penShape: CanvasShape = {
        id: 'pen1',
        type: 'pen',
        x: 0,
        y: 0,
        points: Array(1000).fill(0).map((_, i) => i), // 1000 points
        rotation: 0,
        color: '#000',
        strokeWidth: 2,
      };

      useEditorStore.getState().setShapes([penShape]);

      takeSnapshot();
      // Add another shape to trigger the change detection
      useEditorStore.getState().setShapes([
        penShape,
        createTestShape({ id: 'extra' }),
      ]);
      commitSnapshot();

      const { undoStack } = useEditorStore.getState().history;
      // The snapshot saved the state with the pen shape (1000 points * 8 bytes = 8000 bytes for points alone)
      expect(undoStack[0].estimatedBytes).toBeGreaterThan(8000);
    });
  });

  describe('canvas bounds', () => {
    it('should set canvas bounds', () => {
      const bounds = {
        width: 800,
        height: 600,
        imageOffsetX: 0,
        imageOffsetY: 0,
      };
      useEditorStore.getState().setCanvasBounds(bounds);
      expect(useEditorStore.getState().canvasBounds).toEqual(bounds);
    });

    it('should reset canvas bounds to original size', () => {
      useEditorStore.getState().setOriginalImageSize({ width: 1920, height: 1080 });
      useEditorStore.getState().setCanvasBounds({
        width: 500,
        height: 500,
        imageOffsetX: 50,
        imageOffsetY: 50,
      });

      useEditorStore.getState().resetCanvasBounds();

      expect(useEditorStore.getState().canvasBounds).toEqual({
        width: 1920,
        height: 1080,
        imageOffsetX: 0,
        imageOffsetY: 0,
      });
    });

    it('should include canvas bounds in undo history', () => {
      useEditorStore.getState().setOriginalImageSize({ width: 1000, height: 1000 });

      takeSnapshot();
      useEditorStore.getState().setCanvasBounds({
        width: 500,
        height: 500,
        imageOffsetX: 100,
        imageOffsetY: 100,
      });
      commitSnapshot();

      expect(useEditorStore.getState().canvasBounds?.width).toBe(500);
      expect(useEditorStore.getState().canUndo).toBe(true);

      undo();

      expect(useEditorStore.getState().canvasBounds).toBeNull();
    });
  });

  describe('compositor settings', () => {
    it('should set compositor settings', () => {
      useEditorStore.getState().setCompositorSettings({ padding: 50 });
      expect(useEditorStore.getState().compositorSettings.padding).toBe(50);
    });

    it('should toggle compositor', () => {
      const initial = useEditorStore.getState().compositorSettings.enabled;
      useEditorStore.getState().toggleCompositor();
      expect(useEditorStore.getState().compositorSettings.enabled).toBe(!initial);
    });

    it('should clear preview when settings are committed', () => {
      useEditorStore.getState().setCompositorPreview({ padding: 100 });
      expect(useEditorStore.getState().compositorPreview).not.toBeNull();

      useEditorStore.getState().setCompositorSettings({ padding: 100 });
      expect(useEditorStore.getState().compositorPreview).toBeNull();
    });
  });

  describe('clearEditor', () => {
    it('should reset all editor state', () => {
      // Set up some state
      useEditorStore.getState().setShapes([createTestShape()]);
      useEditorStore.getState().setSelectedIds(['id1']);
      useEditorStore.getState().incrementStepCount();
      useEditorStore.getState().setCanvasBounds({
        width: 500, height: 500, imageOffsetX: 0, imageOffsetY: 0,
      });

      useEditorStore.getState().clearEditor();

      const state = useEditorStore.getState();
      expect(state.shapes).toEqual([]);
      expect(state.selectedIds).toEqual([]);
      expect(state.stepCount).toBe(1);
      expect(state.canvasBounds).toBeNull();
    });
  });

  describe('canvas dimension race condition fix', () => {
    /**
     * This test documents the fix for a race condition where stale canvas dimensions
     * would cause rendering issues when switching between captures.
     *
     * The fix: Set originalImageSize and canvasBounds BEFORE setting imageData,
     * ensuring dimensions are always in sync when the image loads.
     */

    it('should allow setting dimensions before image loads (simulating event-based flow)', () => {
      // Simulate the fixed flow from App.tsx onCaptureCompleteFast:
      // 1. clearEditor() - resets canvasBounds to null
      // 2. setOriginalImageSize() - set correct dimensions
      // 3. setCanvasBounds() - set correct dimensions
      // 4. setCurrentImageData() would be called next (not in store)

      // Start with old dimensions (simulating previous capture)
      useEditorStore.getState().setOriginalImageSize({ width: 1920, height: 1080 });
      useEditorStore.getState().setCanvasBounds({
        width: 1920, height: 1080, imageOffsetX: 0, imageOffsetY: 0,
      });

      // Step 1: clearEditor resets everything
      useEditorStore.getState().clearEditor();
      expect(useEditorStore.getState().canvasBounds).toBeNull();
      expect(useEditorStore.getState().originalImageSize).toBeNull();

      // Step 2 & 3: Set NEW dimensions synchronously BEFORE image loads
      const newWidth = 800;
      const newHeight = 600;
      useEditorStore.getState().setOriginalImageSize({ width: newWidth, height: newHeight });
      useEditorStore.getState().setCanvasBounds({
        width: newWidth,
        height: newHeight,
        imageOffsetX: 0,
        imageOffsetY: 0,
      });

      // Verify dimensions are correctly set BEFORE any async image loading would occur
      const state = useEditorStore.getState();
      expect(state.originalImageSize).toEqual({ width: 800, height: 600 });
      expect(state.canvasBounds).toEqual({
        width: 800,
        height: 600,
        imageOffsetX: 0,
        imageOffsetY: 0,
      });
    });

    it('should not have stale dimensions after clearEditor + set new dimensions', () => {
      // Set initial "old" capture dimensions
      useEditorStore.getState().setOriginalImageSize({ width: 3840, height: 2160 });
      useEditorStore.getState().setCanvasBounds({
        width: 3840, height: 2160, imageOffsetX: 0, imageOffsetY: 0,
      });

      // Simulate new capture with different dimensions
      useEditorStore.getState().clearEditor();
      useEditorStore.getState().setOriginalImageSize({ width: 640, height: 480 });
      useEditorStore.getState().setCanvasBounds({
        width: 640, height: 480, imageOffsetX: 0, imageOffsetY: 0,
      });

      // The bug was: old dimensions (3840x2160) would persist and cause
      // the canvas to render with wrong clip bounds
      const state = useEditorStore.getState();
      expect(state.canvasBounds?.width).not.toBe(3840);
      expect(state.canvasBounds?.height).not.toBe(2160);
      expect(state.canvasBounds?.width).toBe(640);
      expect(state.canvasBounds?.height).toBe(480);
    });

    it('should preserve canvasBounds when set explicitly (not reset by effects)', () => {
      // This tests that once dimensions are set, they stay set
      // Previously, an effect in useCanvasNavigation would reset canvasBounds to null
      // when imageData changed, undoing the explicit set

      useEditorStore.getState().setOriginalImageSize({ width: 1024, height: 768 });
      useEditorStore.getState().setCanvasBounds({
        width: 1024, height: 768, imageOffsetX: 0, imageOffsetY: 0,
      });

      // Simulate multiple state reads (as would happen during React renders)
      for (let i = 0; i < 5; i++) {
        const bounds = useEditorStore.getState().canvasBounds;
        expect(bounds).not.toBeNull();
        expect(bounds?.width).toBe(1024);
        expect(bounds?.height).toBe(768);
      }
    });
  });
});
