/**
 * ImageEditorWindow - Dedicated window for image editing.
 *
 * Each image opens in its own window for faster switching between projects.
 * Receives capture path via URL query params and loads the project independently.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
import type { Tool, CanvasShape } from '@/types';
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
  const [, setHasUnsavedChanges] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const { isCopying, isSaving, handleCopy, handleSave, handleSaveAs } = useEditorActions({ stageRef });

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
    setSelectedTool(newTool);
  }, [selectedTool, setSelectedIds]);

  // Handle shapes change
  const handleShapesChange = useCallback((newShapes: CanvasShape[]) => {
    setShapes(newShapes);
    setHasUnsavedChanges(true);
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

        // Load the image data (base64 encoded)
        const loadedImageData = await invoke<string>('get_project_image', { projectId: capture.id });
        setImageData(loadedImageData);
        editorLogger.info('Image data loaded successfully');
      } else {
        throw new Error('Could not find project for image path');
      }

      setCapturePath(path);
      setIsLoading(false);
    } catch (err) {
      editorLogger.error('Failed to load image project:', err);
      setError(err instanceof Error ? err.message : 'Failed to load image project');
      setIsLoading(false);
    }
  }, []);

  // Load project from URL params on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const encodedPath = urlParams.get('path');
    if (encodedPath && !hasLoadedRef.current) {
      const path = decodeURIComponent(encodedPath);
      loadProject(path);
    }
  }, [loadProject]);

  // Cleanup on window close
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();
    const unlisten = currentWindow.onCloseRequested(async () => {
      // Clear store state
      store.getState().clearEditor();
      store.getState()._clearHistory();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [store]);

  // Handle close
  const handleClose = useCallback(async () => {
    store.getState().clearEditor();
    store.getState()._clearHistory();
    getCurrentWebviewWindow().close();
  }, [store]);

  // Extract filename for title
  const getTitle = () => {
    if (capturePath) {
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
            <p className="text-xs text-(--ink-muted)">Path: {capturePath}</p>
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
