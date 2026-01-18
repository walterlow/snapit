/**
 * ImageEditorWindow - Dedicated window for image editing.
 *
 * Each image opens in its own window for faster switching between projects.
 * Receives capture path via URL query params and loads the project independently.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Loader2 } from 'lucide-react';
import { Titlebar } from '@/components/Titlebar/Titlebar';
import { EditorStoreProvider, createEditorStore, useEditorStore, type EditorStore } from '@/stores/editorStore';
import { useTheme } from '@/hooks/useTheme';
import { editorLogger } from '@/utils/logger';

// Lazy load editor components
const EditorCanvas = React.lazy(() =>
  import('@/components/Editor/EditorCanvas').then(m => ({ default: m.EditorCanvas }))
);
const Toolbar = React.lazy(() =>
  import('@/components/Editor/Toolbar').then(m => ({ default: m.Toolbar }))
);
const PropertiesPanel = React.lazy(() =>
  import('@/components/Editor/PropertiesPanel').then(m => ({ default: m.PropertiesPanel }))
);

import type Konva from 'konva';
import type { EditorCanvasRef } from '@/components/Editor/EditorCanvas';
import type { Tool, CanvasShape, Annotation, CropBoundsAnnotation, CompositorSettingsAnnotation } from '@/types';
import { isCropBoundsAnnotation, isCompositorSettingsAnnotation, DEFAULT_COMPOSITOR_SETTINGS } from '@/types';
import { toast } from 'sonner';
import { reportError } from '@/utils/errorReporting';
import { useEditorActions } from '@/hooks/useEditorActions';
import { useEditorKeyboardShortcuts } from '@/hooks/useEditorKeyboardShortcuts';
import { DeleteDialog } from '@/components/Library/components/DeleteDialog';

/**
 * Inner component that uses the editor store context
 */
const ImageEditorContent: React.FC<{
  imageData: string;
  projectId: string | null;
  store: EditorStore;
  onClose: () => void;
}> = ({ imageData, projectId, store, onClose }) => {
  const stageRef = useRef<Konva.Stage>(null);
  const editorCanvasRef = useRef<EditorCanvasRef>(null);

  const {
    shapes,
    setShapes,
    compositorSettings,
    setCompositorSettings,
    selectedIds,
    setSelectedIds,
    strokeColor,
    setStrokeColor,
    fillColor,
    setFillColor,
    strokeWidth,
    setStrokeWidth,
  } = useEditorStore();

  const [selectedTool, setSelectedTool] = useState<Tool>('select');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const { isCopying, isSaving, handleCopy, handleSave, handleSaveAs } = useEditorActions({ stageRef, imageData });

  // Fit to center handler - dispatch custom event that EditorCanvas listens for
  const handleFitToCenter = useCallback(() => {
    window.dispatchEvent(new CustomEvent('fit-to-center'));
  }, []);

  // Show shortcuts handler (no-op for now, could add modal later)
  const handleShowShortcuts = useCallback(() => {
    // TODO: Add keyboard shortcuts help modal
  }, []);

  // Deselect handler
  const handleDeselect = useCallback(() => {
    setSelectedIds([]);
  }, [setSelectedIds]);

  // Toggle compositor handler
  const handleToggleCompositor = useCallback(() => {
    setCompositorSettings({ enabled: !compositorSettings.enabled });
  }, [compositorSettings.enabled, setCompositorSettings]);

  // Handle tool change
  const handleToolChange = useCallback((newTool: Tool) => {
    if (newTool !== selectedTool && selectedTool === 'select') {
      setSelectedIds([]);
    }
    // Set default yellow color when switching to highlight tool
    if (newTool === 'highlight') {
      setStrokeColor('#FFEB3B'); // Yellow - highlight uses strokeColor with opacity
    }
    setSelectedTool(newTool);
  }, [selectedTool, setSelectedIds, setStrokeColor]);

  // Handle shapes change
  const handleShapesChange = useCallback((newShapes: CanvasShape[]) => {
    setShapes(newShapes);
  }, [setShapes]);

  // Undo/Redo handlers - use store methods directly for window context
  const handleUndo = useCallback(() => {
    store.getState()._undo();
  }, [store]);

  const handleRedo = useCallback(() => {
    store.getState()._redo();
  }, [store]);

  // Delete handlers
  const handleRequestDelete = useCallback(() => {
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!projectId) return;
    try {
      await invoke('delete_project', { projectId });
      // Notify main window to refresh library
      await emit('capture-deleted', { projectId });
      toast.success('Capture deleted');
      onClose();
    } catch (error) {
      reportError(error, { operation: 'delete capture' });
    }
    setDeleteDialogOpen(false);
  }, [projectId, onClose]);

  const handleCancelDelete = useCallback(() => {
    setDeleteDialogOpen(false);
  }, []);

  // Wire up keyboard shortcuts
  useEditorKeyboardShortcuts({
    view: 'editor',
    selectedTool,
    selectedIds,
    compositorEnabled: compositorSettings.enabled,
    onToolChange: handleToolChange,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onSave: handleSave,
    onCopy: handleCopy,
    onToggleCompositor: handleToggleCompositor,
    onShowShortcuts: handleShowShortcuts,
    onDeselect: handleDeselect,
    onFitToCenter: handleFitToCenter,
  });

  return (
    <>
      <React.Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-(--coral-400)" />
          </div>
        }
      >
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 overflow-hidden min-h-0 relative">
              <EditorCanvas
                ref={editorCanvasRef}
                imageData={imageData}
                selectedTool={selectedTool}
                onToolChange={handleToolChange}
                strokeColor={strokeColor}
                fillColor={fillColor}
                strokeWidth={strokeWidth}
                shapes={shapes}
                onShapesChange={handleShapesChange}
                stageRef={stageRef}
              />
            </div>
            <PropertiesPanel
              selectedTool={selectedTool}
              strokeColor={strokeColor}
              onStrokeColorChange={setStrokeColor}
              fillColor={fillColor}
              onFillColorChange={setFillColor}
              strokeWidth={strokeWidth}
              onStrokeWidthChange={setStrokeWidth}
            />
          </div>
          <Toolbar
            selectedTool={selectedTool}
            onToolChange={handleToolChange}
            onCopy={handleCopy}
            onSave={handleSave}
            onSaveAs={handleSaveAs}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onDelete={handleRequestDelete}
            isCopying={isCopying}
            isSaving={isSaving}
          />
        </div>
      </React.Suspense>

      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        count={1}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
};

/**
 * ImageEditorWindow - Standalone image editor window.
 */
const ImageEditorWindow: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capturePath, setCapturePath] = useState<string | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);
  // Use ref for projectId to avoid race conditions in close handler
  const projectIdRef = useRef<string | null>(null);
  // Flag to prevent auto-save during initial load
  const isInitialLoadRef = useRef(true);
  // Flag to prevent auto-save during window close (clearEditor triggers store change)
  const isClosingRef = useRef(false);

  // Create a store instance for this window
  const [store] = useState(() => createEditorStore());

  // Apply theme
  useTheme();

  // Load project when path is received
  const loadProject = useCallback(async (path: string) => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      editorLogger.info('Loading image project:', path);

      // Fast path: RGBA files can be loaded directly without IPC lookup
      if (path.endsWith('.rgba')) {
        setImageData(path);
        setCapturePath(path);
        setIsLoading(false);
        editorLogger.info('RGBA file loaded directly (fast path)');
        return;
      }

      // For saved images, find the project to get the project ID
      // This allows us to save annotations back to the correct project
      const captures = await invoke<Array<{ id: string; image_path: string }>>('get_capture_list');
      const capture = captures.find((c: { id: string; image_path: string }) => c.image_path === path);

      if (capture) {
        setProjectId(capture.id);
        projectIdRef.current = capture.id;

        // Load the image data (base64 encoded)
        const loadedImageData = await invoke<string>('get_project_image', { projectId: capture.id });
        setImageData(loadedImageData);

        // Load project annotations (shapes, crop bounds, compositor settings)
        try {
          const project = await invoke<{ annotations?: Annotation[]; dimensions?: { width: number; height: number } }>('get_project', { projectId: capture.id });
          if (project.annotations && project.annotations.length > 0) {
            // Separate special annotations from shape annotations
            const cropBoundsAnn = project.annotations.find(isCropBoundsAnnotation);
            const compositorAnn = project.annotations.find(isCompositorSettingsAnnotation);
            const shapeAnnotations = project.annotations.filter(
              (ann: Annotation) => !isCropBoundsAnnotation(ann) && !isCompositorSettingsAnnotation(ann)
            );

            // Load crop bounds if present
            if (cropBoundsAnn) {
              store.getState().setCanvasBounds({
                width: cropBoundsAnn.width,
                height: cropBoundsAnn.height,
                imageOffsetX: cropBoundsAnn.imageOffsetX,
                imageOffsetY: cropBoundsAnn.imageOffsetY,
              });
            }

            // Load compositor settings if present (spread defaults, then saved values)
            if (compositorAnn) {
              store.getState().setCompositorSettings({
                ...DEFAULT_COMPOSITOR_SETTINGS,
                ...compositorAnn,
              });
            }

            // Set original image size for reset functionality
            if (project.dimensions) {
              store.getState().setOriginalImageSize({
                width: project.dimensions.width,
                height: project.dimensions.height,
              });
            }

            // Load shapes
            const projectShapes: CanvasShape[] = shapeAnnotations.map((ann: Annotation) => ({
              ...ann,
              id: ann.id,
              type: ann.type,
            } as CanvasShape));
            store.getState().setShapes(projectShapes);
          }
        } catch (err) {
          editorLogger.warn('Failed to load project annotations:', err);
        }
      } else {
        throw new Error('Could not find project for image path');
      }

      setCapturePath(path);
      setIsLoading(false);
      // Allow auto-save after initial load is complete (with delay to let store settle)
      setTimeout(() => {
        isInitialLoadRef.current = false;
      }, 500);
    } catch (err) {
      editorLogger.error('Failed to load image project:', err);
      setError(err instanceof Error ? err.message : 'Failed to load image project');
      setIsLoading(false);
    }
  }, [store]);

  // Load project from URL params on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const encodedPath = urlParams.get('path');
    if (encodedPath && !hasLoadedRef.current) {
      const path = decodeURIComponent(encodedPath);
      loadProject(path);
    }
  }, [loadProject]);

  // Listen for capture-saved event to get projectId for fresh captures
  // This enables delete functionality for captures opened immediately after taking
  useEffect(() => {
    if (projectId || !capturePath) return; // Already have projectId or no path yet

    const unlisten = listen<{ originalPath: string; imagePath: string; projectId: string }>('capture-saved', (event: { payload: { originalPath: string; imagePath: string; projectId: string } }) => {
      const { originalPath, imagePath, projectId: newProjectId } = event.payload;
      // Check if this event is for our capture (match the path)
      if (originalPath === capturePath) {
        editorLogger.info('Received projectId for fresh capture:', newProjectId);
        setProjectId(newProjectId);
        projectIdRef.current = newProjectId;
        // Update to permanent path
        setCapturePath(imagePath);
      }
    });

    return () => {
      unlisten.then((unlistenFn: () => void) => unlistenFn());
    };
  }, [projectId, capturePath]);

  // Save annotations to the project
  // Uses projectIdRef to avoid dependency on projectId state (prevents race conditions)
  const saveAnnotations = useCallback(async (force = false) => {
    // Skip if closing (unless forced - used by close handler)
    if (!force && isClosingRef.current) {
      return;
    }

    const currentProjectId = projectIdRef.current;
    if (!currentProjectId) {
      return;
    }

    try {
      const state = store.getState();
      const { shapes, canvasBounds, compositorSettings } = state;

      // Build annotations array
      const annotations: Annotation[] = [];

      // Add shape annotations
      shapes.forEach((shape: CanvasShape) => {
        annotations.push({
          ...shape,
          id: shape.id,
          type: shape.type,
        });
      });

      // Add crop bounds annotation if canvas has been modified
      if (canvasBounds) {
        const cropBoundsAnn: CropBoundsAnnotation = {
          id: '__crop_bounds__',
          type: '__crop_bounds__',
          width: canvasBounds.width,
          height: canvasBounds.height,
          imageOffsetX: canvasBounds.imageOffsetX,
          imageOffsetY: canvasBounds.imageOffsetY,
        };
        annotations.push(cropBoundsAnn);
      }

      // Add compositor settings annotation (always save to preserve state)
      const compositorAnn: CompositorSettingsAnnotation = {
        id: '__compositor_settings__',
        type: '__compositor_settings__',
        ...compositorSettings,
      };
      annotations.push(compositorAnn);

      await invoke('update_project_annotations', { projectId: currentProjectId, annotations });
    } catch (err) {
      editorLogger.warn('Failed to save annotations:', err);
      // Don't block window close on save failure
    }
  }, [store]);

  // Auto-save annotations when store state changes (debounced)
  useEffect(() => {
    // Don't auto-save until project is loaded
    if (!projectIdRef.current || isLoading) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Subscribe to store changes and debounce saves
    const unsubscribe = store.subscribe((state: ReturnType<typeof store.getState>, prevState: ReturnType<typeof store.getState>) => {
      // Don't auto-save during initial load or window close (prevents overwriting good data)
      if (isInitialLoadRef.current || isClosingRef.current) {
        return;
      }

      // Check if any saveable state changed
      const shapesChanged = state.shapes !== prevState.shapes;
      const boundsChanged = state.canvasBounds !== prevState.canvasBounds;
      const compositorChanged = state.compositorSettings !== prevState.compositorSettings;

      // Don't auto-save if shapes went from some to zero (this is a clear operation, not a user edit)
      if (shapesChanged && state.shapes.length === 0 && prevState.shapes.length > 0) {
        return;
      }

      if (shapesChanged || boundsChanged || compositorChanged) {
        // Clear previous timeout
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // Schedule auto-save after 1 second of inactivity
        timeoutId = setTimeout(() => {
          saveAnnotations().catch((error: unknown) => {
            editorLogger.warn('Auto-save failed:', error);
          });
        }, 1000);
      }
    });

    return () => {
      unsubscribe();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [store, isLoading, saveAnnotations]);

  // Cleanup on window close
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();
    const unlisten = currentWindow.onCloseRequested(async (event: { preventDefault: () => void }) => {
      // Prevent the default close to ensure we save first
      event.preventDefault();
      // Set closing flag to prevent any more auto-saves
      isClosingRef.current = true;
      // Save annotations (force=true to bypass the closing check)
      await saveAnnotations(true);
      // Now actually close the window (don't clear store - it gets garbage collected)
      currentWindow.destroy();
    });

    return () => {
      unlisten.then((fn: () => void) => fn());
    };
  }, [store, saveAnnotations]);

  // Handle close
  const handleClose = useCallback(async () => {
    // Set closing flag to prevent any more auto-saves
    isClosingRef.current = true;
    // Save with force=true to bypass the closing check
    await saveAnnotations(true);
    // Don't clear store - it gets garbage collected when window closes
    getCurrentWebviewWindow().close();
  }, [saveAnnotations]);

  // Extract filename for title
  const getTitle = () => {
    if (capturePath) {
      // Don't show .rgba temp files - show friendly name until saved
      if (capturePath.endsWith('.rgba')) {
        return 'New Capture';
      }
      const parts = capturePath.split(/[/\\]/);
      return parts[parts.length - 1] || 'Image Editor';
    }
    return 'Image Editor';
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="h-screen w-screen flex flex-col bg-card overflow-hidden">
        <Titlebar title="Loading..." showLogo={true} showMaximize={true} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-(--coral-400)" />
            <p className="text-sm text-(--ink-muted)">Loading image...</p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="h-screen w-screen flex flex-col bg-card overflow-hidden">
        <Titlebar title="Error" showLogo={true} showMaximize={true} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 max-w-md text-center">
            <div className="w-12 h-12 rounded-full bg-(--error-light) flex items-center justify-center">
              <span className="text-2xl">!</span>
            </div>
            <p className="text-sm text-(--error)">{error}</p>
            {capturePath && !capturePath.endsWith('.rgba') && (
              <p className="text-xs text-(--ink-muted)">Path: {capturePath}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // No image data loaded
  if (!imageData) {
    return (
      <div className="h-screen w-screen flex flex-col bg-card overflow-hidden">
        <Titlebar title="Image Editor" showLogo={true} showMaximize={true} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-(--ink-muted)">No image data loaded</p>
        </div>
      </div>
    );
  }

  // Main editor UI
  return (
    <div className="h-screen w-screen flex flex-col bg-card overflow-hidden">
      <Titlebar
        title={getTitle()}
        showLogo={true}
        showMaximize={true}
        onClose={handleClose}
      />
      <EditorStoreProvider store={store}>
        <ImageEditorContent
          imageData={imageData}
          projectId={projectId}
          store={store}
          onClose={handleClose}
        />
      </EditorStoreProvider>
    </div>
  );
};

export default ImageEditorWindow;
