import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditorStore, undo, redo, clearHistory, recordAction } from '../../stores/editorStore';
import { useCaptureStore } from '../../stores/captureStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { CanvasShape, CaptureListItem } from '../../types';
import { setInvokeResponse } from '../mocks/tauri';

// Mock nanoid
vi.mock('nanoid', () => ({
  nanoid: () => `mock_id_${Date.now()}_${Math.random()}`,
}));

// Helper to create test shapes
function createTestShape(overrides: Partial<CanvasShape> = {}): CanvasShape {
  return {
    id: `shape_${Date.now()}_${Math.random()}`,
    type: 'rectangle',
    x: 100,
    y: 100,
    width: 50,
    height: 50,
    rotation: 0,
    stroke: '#ff0000',
    strokeWidth: 2,
    ...overrides,
  };
}

// Helper to create test capture
function createTestCapture(overrides: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    id: `capture_${Date.now()}`,
    image_path: '/path/to/capture.png',
    thumbnail_path: '/path/to/thumb.png',
    dimensions: { width: 1920, height: 1080 },
    capture_type: 'region',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    favorite: false,
    tags: [],
    has_annotations: false,
    is_missing: false,
    ...overrides,
  };
}

describe('Editor Integration', () => {
  beforeEach(() => {
    // Reset editor store
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
      strokeColor: '#FF0000',
      fillColor: '',
      strokeWidth: 3,
    });
    clearHistory();

    // Reset capture store to default state
    useCaptureStore.setState({
      captures: [],
      view: 'library',
      currentProject: null,
      currentImageData: null,
      loading: false,
      initialized: false,
      error: null,
      isFromCache: false,
      isCacheStale: false,
      isRefreshing: false,
      loadingProjectId: null,
      skipStagger: false,
      searchQuery: '',
      filterFavorites: false,
      filterTags: [],
      hasUnsavedChanges: false,
    });
  });

  describe('Shape manipulation with undo/redo', () => {
    it('should support full undo/redo cycle for adding shapes', () => {
      const store = useEditorStore.getState();
      
      // Add first shape
      recordAction(() => {
        store.setShapes([createTestShape({ id: 'shape1', x: 0 })]);
      });
      expect(useEditorStore.getState().shapes).toHaveLength(1);
      expect(useEditorStore.getState().canUndo).toBe(true);
      expect(useEditorStore.getState().canRedo).toBe(false);

      // Add second shape
      recordAction(() => {
        const current = useEditorStore.getState().shapes;
        useEditorStore.getState().setShapes([...current, createTestShape({ id: 'shape2', x: 100 })]);
      });
      expect(useEditorStore.getState().shapes).toHaveLength(2);

      // Undo second shape
      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(1);
      expect(useEditorStore.getState().shapes[0].id).toBe('shape1');
      expect(useEditorStore.getState().canRedo).toBe(true);

      // Redo second shape
      redo();
      expect(useEditorStore.getState().shapes).toHaveLength(2);

      // Undo both
      undo();
      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(0);

      // Redo all
      redo();
      redo();
      expect(useEditorStore.getState().shapes).toHaveLength(2);
    });

    it('should clear redo stack when new action is performed after undo', () => {
      const store = useEditorStore.getState();
      
      // Add two shapes
      recordAction(() => {
        store.setShapes([createTestShape({ id: 'shape1' })]);
      });
      recordAction(() => {
        const current = useEditorStore.getState().shapes;
        useEditorStore.getState().setShapes([...current, createTestShape({ id: 'shape2' })]);
      });

      // Undo to remove second shape
      undo();
      expect(useEditorStore.getState().canRedo).toBe(true);

      // Add a new shape (should clear redo stack)
      recordAction(() => {
        const current = useEditorStore.getState().shapes;
        useEditorStore.getState().setShapes([...current, createTestShape({ id: 'shape3' })]);
      });
      
      expect(useEditorStore.getState().canRedo).toBe(false);
      expect(useEditorStore.getState().shapes).toHaveLength(2);
      expect(useEditorStore.getState().shapes[1].id).toBe('shape3');
    });
  });

  describe('Keyboard shortcuts with shape operations', () => {
    it('should delete shapes via keyboard and support undo', () => {
      const mockSetSelectedIds = vi.fn((ids: string[]) => {
        useEditorStore.getState().setSelectedIds(ids);
      });
      
      const mockOnShapesChange = vi.fn((shapes: CanvasShape[]) => {
        recordAction(() => {
          useEditorStore.getState().setShapes(shapes);
        });
      });

      // Setup initial shapes
      const shape1 = createTestShape({ id: 'shape1' });
      const shape2 = createTestShape({ id: 'shape2' });
      useEditorStore.getState().setShapes([shape1, shape2]);
      useEditorStore.getState().setSelectedIds(['shape1']);

      renderHook(() =>
        useKeyboardShortcuts({
          selectedIds: useEditorStore.getState().selectedIds,
          setSelectedIds: mockSetSelectedIds,
          shapes: useEditorStore.getState().shapes,
          onShapesChange: mockOnShapesChange,
        })
      );

      // Delete shape via keyboard
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
      });

      expect(mockOnShapesChange).toHaveBeenCalled();
      expect(useEditorStore.getState().shapes).toHaveLength(1);
      expect(useEditorStore.getState().shapes[0].id).toBe('shape2');

      // Undo the delete
      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(2);
    });

    it('should duplicate shapes with offset and support undo', () => {
      const mockSetSelectedIds = vi.fn((ids: string[]) => {
        useEditorStore.getState().setSelectedIds(ids);
      });
      
      const mockOnShapesChange = vi.fn((shapes: CanvasShape[]) => {
        recordAction(() => {
          useEditorStore.getState().setShapes(shapes);
        });
      });

      // Setup initial shape
      const shape1 = createTestShape({ id: 'shape1', x: 100, y: 100 });
      useEditorStore.getState().setShapes([shape1]);
      useEditorStore.getState().setSelectedIds(['shape1']);

      renderHook(() =>
        useKeyboardShortcuts({
          selectedIds: useEditorStore.getState().selectedIds,
          setSelectedIds: mockSetSelectedIds,
          shapes: useEditorStore.getState().shapes,
          onShapesChange: mockOnShapesChange,
        })
      );

      // Duplicate shape via Ctrl+D
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));
      });

      expect(useEditorStore.getState().shapes).toHaveLength(2);
      const duplicated = useEditorStore.getState().shapes[1];
      expect(duplicated.x).toBe(120); // Original + 20 offset
      expect(duplicated.y).toBe(120);

      // Undo should remove duplicated shape
      undo();
      expect(useEditorStore.getState().shapes).toHaveLength(1);
    });
  });

  describe('Canvas bounds with undo/redo', () => {
    it('should track canvas bounds changes in history', () => {
      const store = useEditorStore.getState();
      store.setOriginalImageSize({ width: 1920, height: 1080 });

      // Initial crop
      recordAction(() => {
        useEditorStore.getState().setCanvasBounds({
          width: 960,
          height: 540,
          imageOffsetX: 480,
          imageOffsetY: 270,
        });
      });

      expect(useEditorStore.getState().canvasBounds?.width).toBe(960);
      expect(useEditorStore.getState().canUndo).toBe(true);

      // Second crop
      recordAction(() => {
        useEditorStore.getState().setCanvasBounds({
          width: 480,
          height: 270,
          imageOffsetX: 720,
          imageOffsetY: 405,
        });
      });

      expect(useEditorStore.getState().canvasBounds?.width).toBe(480);

      // Undo second crop
      undo();
      expect(useEditorStore.getState().canvasBounds?.width).toBe(960);

      // Undo first crop
      undo();
      expect(useEditorStore.getState().canvasBounds).toBeNull();
    });
  });

  describe('Drawing settings persistence', () => {
    it('should preserve drawing settings across clearEditor calls', () => {
      const store = useEditorStore.getState();
      
      // Set custom drawing settings
      store.setStrokeColor('#00FF00');
      store.setFillColor('#0000FF');
      store.setStrokeWidth(5);

      // Add some shapes
      store.setShapes([createTestShape()]);
      store.setSelectedIds(['shape1']);

      // Clear editor (switching to new capture)
      store.clearEditor();

      // Drawing settings should be preserved
      const state = useEditorStore.getState();
      expect(state.strokeColor).toBe('#00FF00');
      expect(state.fillColor).toBe('#0000FF');
      expect(state.strokeWidth).toBe(5);

      // But shapes should be cleared
      expect(state.shapes).toHaveLength(0);
      expect(state.selectedIds).toHaveLength(0);
    });
  });

  describe('Step count with shapes', () => {
    it('should increment step count for numbered annotation tools', () => {
      const store = useEditorStore.getState();
      
      expect(store.stepCount).toBe(1);

      // Simulate adding step annotations
      store.incrementStepCount();
      expect(useEditorStore.getState().stepCount).toBe(2);

      store.incrementStepCount();
      expect(useEditorStore.getState().stepCount).toBe(3);

      // Clear should reset step count
      store.clearEditor();
      expect(useEditorStore.getState().stepCount).toBe(1);
    });
  });
});

describe('Capture Store Integration', () => {
  beforeEach(() => {
    // Reset stores
    useCaptureStore.setState({
      captures: [],
      view: 'library',
      currentProject: null,
      currentImageData: null,
      loading: false,
      initialized: false,
      error: null,
      isFromCache: false,
      isCacheStale: false,
      isRefreshing: false,
      loadingProjectId: null,
      skipStagger: false,
      searchQuery: '',
      filterFavorites: false,
      filterTags: [],
      hasUnsavedChanges: false,
    });

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

  describe('View transitions', () => {
    it('should transition from library to editor when loading a project', async () => {
      const capture = createTestCapture({ id: 'test-capture' });
      
      // Mock the backend responses
      setInvokeResponse('get_capture_list', [capture]);
      setInvokeResponse('get_project', {
        id: 'test-capture',
        imagePath: '/path/to/image.png',
        annotations: { shapes: [] },
      });

      // Load captures
      await useCaptureStore.getState().loadCaptures();
      expect(useCaptureStore.getState().captures).toHaveLength(1);

      // Transition to editor
      useCaptureStore.getState().setView('editor');
      expect(useCaptureStore.getState().view).toBe('editor');

      // Return to library
      useCaptureStore.getState().setView('library');
      expect(useCaptureStore.getState().view).toBe('library');
    });
  });

  describe('Filtering captures', () => {
    it('should filter captures by search query', () => {
      const capture1 = createTestCapture({ 
        id: 'capture1',
        image_path: '/path/to/screenshot.png',
      });
      const capture2 = createTestCapture({ 
        id: 'capture2',
        image_path: '/path/to/recording.mp4',
      });

      useCaptureStore.setState({ captures: [capture1, capture2] });
      
      // Search for 'screenshot'
      useCaptureStore.getState().setSearchQuery('screenshot');
      expect(useCaptureStore.getState().searchQuery).toBe('screenshot');
    });

    it('should filter favorites only', () => {
      const capture1 = createTestCapture({ id: 'capture1', favorite: true });
      const capture2 = createTestCapture({ id: 'capture2', favorite: false });

      useCaptureStore.setState({ captures: [capture1, capture2] });
      
      useCaptureStore.getState().setFilterFavorites(true);
      expect(useCaptureStore.getState().filterFavorites).toBe(true);
    });

    it('should filter by tags', () => {
      const capture1 = createTestCapture({ id: 'capture1', tags: ['work', 'bug'] });
      const capture2 = createTestCapture({ id: 'capture2', tags: ['personal'] });

      useCaptureStore.setState({ captures: [capture1, capture2] });
      
      useCaptureStore.getState().setFilterTags(['work']);
      expect(useCaptureStore.getState().filterTags).toEqual(['work']);
    });
  });

  describe('Optimistic updates', () => {
    it('should toggle favorite optimistically', async () => {
      const capture = createTestCapture({ id: 'test-capture', favorite: false });
      useCaptureStore.setState({ captures: [capture] });

      setInvokeResponse('update_project_metadata', undefined);

      await useCaptureStore.getState().toggleFavorite('test-capture');
      
      const updated = useCaptureStore.getState().captures.find(c => c.id === 'test-capture');
      expect(updated?.favorite).toBe(true);
    });
  });
});

describe('Editor + Capture Store Integration', () => {
  beforeEach(() => {
    // Reset both stores
    useCaptureStore.setState({
      captures: [],
      view: 'library',
      currentProject: null,
      currentImageData: null,
      loading: false,
      initialized: false,
      error: null,
      isFromCache: false,
      isCacheStale: false,
      isRefreshing: false,
      loadingProjectId: null,
      skipStagger: false,
      searchQuery: '',
      filterFavorites: false,
      filterTags: [],
      hasUnsavedChanges: false,
    });

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
    clearHistory();
  });

  it('should clear editor state when switching projects', () => {
    // Setup editor with shapes using recordAction to create history
    recordAction(() => {
      useEditorStore.getState().setShapes([createTestShape({ id: 'shape1' })]);
    });
    useEditorStore.getState().setSelectedIds(['shape1']);
    useEditorStore.getState().setCanvasBounds({
      width: 800,
      height: 600,
      imageOffsetX: 0,
      imageOffsetY: 0,
    });

    expect(useEditorStore.getState().shapes).toHaveLength(1);
    expect(useEditorStore.getState().canUndo).toBe(true);

    // Simulate switching to new project
    useEditorStore.getState().clearEditor();
    clearHistory();

    expect(useEditorStore.getState().shapes).toHaveLength(0);
    expect(useEditorStore.getState().selectedIds).toHaveLength(0);
    expect(useEditorStore.getState().canvasBounds).toBeNull();
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it('should set up canvas dimensions before image loads', () => {
    // Simulate the capture complete flow from App.tsx
    const editorStore = useEditorStore.getState();
    
    // 1. Clear editor
    editorStore.clearEditor();
    clearHistory();
    
    // 2. Set dimensions BEFORE image data
    editorStore.setOriginalImageSize({ width: 1920, height: 1080 });
    editorStore.setCanvasBounds({
      width: 1920,
      height: 1080,
      imageOffsetX: 0,
      imageOffsetY: 0,
    });

    // 3. Set image data (simulated)
    useCaptureStore.getState().setCurrentImageData('/path/to/capture.png');

    // 4. Transition to editor
    useCaptureStore.getState().setView('editor');

    // Verify dimensions are set correctly
    const state = useEditorStore.getState();
    expect(state.originalImageSize).toEqual({ width: 1920, height: 1080 });
    expect(state.canvasBounds).toEqual({
      width: 1920,
      height: 1080,
      imageOffsetX: 0,
      imageOffsetY: 0,
    });
    expect(useCaptureStore.getState().view).toBe('editor');
    expect(useCaptureStore.getState().currentImageData).toBe('/path/to/capture.png');
  });
});
