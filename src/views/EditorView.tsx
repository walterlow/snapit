/**
 * EditorView Component
 *
 * Encapsulates all editor-specific state, refs, and UI.
 * Exposes an imperative API via ref for App.tsx to use in
 * CommandPalette and keyboard shortcuts.
 *
 * Extracted from App.tsx for better separation of concerns.
 */

import { useState, useRef, useCallback, useImperativeHandle, forwardRef, lazy, Suspense } from 'react';
import Konva from 'konva';
import { toast } from 'sonner';
import { useCaptureStore } from '../stores/captureStore';
import { useEditorStore, undo, redo } from '../stores/editorStore';
import { useEditorActions } from '../hooks/useEditorActions';
import { useEditorPersistence } from '../hooks/useEditorPersistence';
import { reportError } from '../utils/errorReporting';
import { EditorErrorBoundary } from '../components/ErrorBoundary';
import { DeleteDialog } from '../components/Library/components/DeleteDialog';
import { EditorLoadingSkeleton } from './EditorLoadingSkeleton';
import type { EditorCanvasRef } from '../components/Editor/EditorCanvas';
import type { Tool, CanvasShape } from '../types';

// Lazy load editor components - only loaded when entering editor view
const EditorCanvas = lazy(() => import('../components/Editor/EditorCanvas').then(m => ({ default: m.EditorCanvas })));
const Toolbar = lazy(() => import('../components/Editor/Toolbar').then(m => ({ default: m.Toolbar })));
const PropertiesPanel = lazy(() => import('../components/Editor/PropertiesPanel').then(m => ({ default: m.PropertiesPanel })));

/**
 * Imperative API exposed by EditorView for use by App.tsx
 */
export interface EditorViewRef {
  // Current state accessors
  selectedTool: Tool;
  // Actions
  setTool: (tool: Tool) => void;
  copy: () => Promise<void>;
  save: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  back: () => Promise<void>;
  requestDelete: () => void;
  toggleCompositor: () => void;
  fitToCenter: () => void;
  deselect: () => void;
}

/**
 * EditorView component that manages editor state and UI.
 */
export const EditorView = forwardRef<EditorViewRef>(function EditorView(_props, ref) {
  const {
    currentProject,
    currentImageData,
    setView,
    setHasUnsavedChanges,
    deleteCapture,
  } = useCaptureStore();

  const {
    shapes,
    setShapes,
    compositorSettings,
    setCompositorSettings,
    setSelectedIds,
  } = useEditorStore();

  // Local editor UI state
  const [selectedTool, setSelectedTool] = useState<Tool>('select');
  const [strokeColor, setStrokeColor] = useState('#ef4444');
  const [fillColor, setFillColor] = useState('transparent');
  const [strokeWidth, setStrokeWidth] = useState(3);

  // Refs for canvas access
  const stageRef = useRef<Konva.Stage>(null);
  const editorCanvasRef = useRef<EditorCanvasRef>(null);

  // Delete confirmation dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Extracted hooks for editor actions
  const { isCopying, isSaving, handleCopy, handleSave, handleSaveAs } = useEditorActions({ stageRef });
  const { handleBack } = useEditorPersistence({ editorCanvasRef });

  // Wrapper to deselect elements when switching away from select tool
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
  }, [setShapes, setHasUnsavedChanges]);

  // Undo/Redo handlers
  const handleUndo = useCallback(() => {
    undo();
  }, []);

  const handleRedo = useCallback(() => {
    redo();
  }, []);

  // Delete handlers
  const handleRequestDelete = useCallback(() => {
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!currentProject) return;
    try {
      await deleteCapture(currentProject.id);
      toast.success('Capture deleted');
      setView('library');
    } catch (error) {
      reportError(error, { operation: 'delete capture' });
    }
    setDeleteDialogOpen(false);
  }, [currentProject, deleteCapture, setView]);

  const handleCancelDelete = useCallback(() => {
    setDeleteDialogOpen(false);
  }, []);

  // Compositor toggle
  const handleToggleCompositor = useCallback(() => {
    setCompositorSettings({ enabled: !compositorSettings.enabled });
  }, [compositorSettings.enabled, setCompositorSettings]);

  // Fit to center
  const handleFitToCenter = useCallback(() => {
    window.dispatchEvent(new CustomEvent('fit-to-center'));
  }, []);

  // Deselect all shapes
  const handleDeselect = useCallback(() => {
    setSelectedIds([]);
  }, [setSelectedIds]);

  // Expose imperative API via ref
  useImperativeHandle(ref, () => ({
    get selectedTool() {
      return selectedTool;
    },
    setTool: handleToolChange,
    copy: handleCopy,
    save: handleSave,
    undo: handleUndo,
    redo: handleRedo,
    back: handleBack,
    requestDelete: handleRequestDelete,
    toggleCompositor: handleToggleCompositor,
    fitToCenter: handleFitToCenter,
    deselect: handleDeselect,
  }), [
    selectedTool,
    handleToolChange,
    handleCopy,
    handleSave,
    handleUndo,
    handleRedo,
    handleBack,
    handleRequestDelete,
    handleToggleCompositor,
    handleFitToCenter,
    handleDeselect,
  ]);

  return (
    <>
      <EditorErrorBoundary projectId={currentProject?.id} onBack={handleBack}>
        <Suspense fallback={<EditorLoadingSkeleton />}>
          <div className="flex-1 flex flex-col min-h-0">
            {/* Editor Area with optional Sidebar */}
            <div className="flex-1 flex min-h-0">
              {/* Canvas Area - flex-1 takes remaining space */}
              <div className="flex-1 overflow-hidden min-h-0 relative">
                {currentImageData && (
                  <EditorCanvas
                    ref={editorCanvasRef}
                    imageData={currentImageData}
                    selectedTool={selectedTool}
                    onToolChange={handleToolChange}
                    strokeColor={strokeColor}
                    fillColor={fillColor}
                    strokeWidth={strokeWidth}
                    shapes={shapes}
                    onShapesChange={handleShapesChange}
                    stageRef={stageRef}
                  />
                )}
              </div>

              {/* Properties Sidebar - always visible */}
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

            {/* Toolbar */}
            <Toolbar
              selectedTool={selectedTool}
              onToolChange={handleToolChange}
              onCopy={handleCopy}
              onSave={handleSave}
              onSaveAs={handleSaveAs}
              onBack={handleBack}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onDelete={handleRequestDelete}
              isCopying={isCopying}
              isSaving={isSaving}
            />
          </div>
        </Suspense>
      </EditorErrorBoundary>

      {/* Delete Confirmation Dialog */}
      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        count={1}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
});
