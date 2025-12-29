import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense, Activity } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Konva from 'konva';
import { toast, Toaster } from 'sonner';
import { Titlebar } from './components/Titlebar/Titlebar';
import { CaptureLibrary } from './components/Library/CaptureLibrary';
import { DeleteDialog } from './components/Library/components/DeleteDialog';
import { EditorErrorBoundary, LibraryErrorBoundary } from './components/ErrorBoundary';
import type { EditorCanvasRef } from './components/Editor/EditorCanvas';

// Lazy load editor components - only loaded when entering editor view
const EditorCanvas = lazy(() => import('./components/Editor/EditorCanvas').then(m => ({ default: m.EditorCanvas })));
const Toolbar = lazy(() => import('./components/Editor/Toolbar').then(m => ({ default: m.Toolbar })));
const PropertiesPanel = lazy(() => import('./components/Editor/PropertiesPanel').then(m => ({ default: m.PropertiesPanel })));
import { KeyboardShortcutsModal } from './components/KeyboardShortcuts/KeyboardShortcutsModal';
import { SettingsModal } from './components/Settings/SettingsModal';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { useCaptureStore } from './stores/captureStore';
import { useEditorStore, undo, redo, clearHistory } from './stores/editorStore';
import { useSettingsStore } from './stores/settingsStore';
import { useVideoRecordingStore } from './stores/videoRecordingStore';
import { registerAllShortcuts, setShortcutHandler } from './utils/hotkeyManager';
import { useUpdater } from './hooks/useUpdater';
import { useTheme } from './hooks/useTheme';
import { useEditorKeyboardShortcuts } from './hooks/useEditorKeyboardShortcuts';
import { useAppEventListeners } from './hooks/useAppEventListeners';
import { useCaptureActions } from './hooks/useCaptureActions';
import { useEditorActions } from './hooks/useEditorActions';
import { useEditorPersistence } from './hooks/useEditorPersistence';
import { createErrorHandler, reportError } from './utils/errorReporting';
import type { Tool, CanvasShape } from './types';
import { isCropBoundsAnnotation, isCompositorSettingsAnnotation } from './types';

// Settings Modal Container - uses store for open/close state
const SettingsModalContainer: React.FC = () => {
  const { settingsModalOpen, closeSettingsModal } = useSettingsStore();
  return (
    <SettingsModal open={settingsModalOpen} onClose={closeSettingsModal} />
  );
};

// Loading skeleton shown while editor components are being lazy-loaded
const EditorLoadingSkeleton: React.FC = () => (
  <div className="flex-1 flex flex-col min-h-0">
    <div className="flex-1 flex min-h-0">
      {/* Canvas skeleton */}
      <div className="flex-1 overflow-hidden min-h-0 relative bg-[var(--polar-snow)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-[var(--text-muted)]">
          <div className="w-8 h-8 border-2 border-[var(--aurora-blue)] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading editor...</span>
        </div>
      </div>
      {/* Properties panel skeleton */}
      <div className="w-[280px] glass-panel border-l border-[var(--polar-frost)] p-4">
        <div className="space-y-4">
          <div className="h-6 bg-[var(--polar-frost)] rounded animate-pulse" />
          <div className="h-24 bg-[var(--polar-frost)] rounded animate-pulse" />
          <div className="h-8 bg-[var(--polar-frost)] rounded animate-pulse" />
        </div>
      </div>
    </div>
    {/* Toolbar skeleton */}
    <div className="h-16 glass-panel border-t border-[var(--polar-frost)] flex items-center justify-center gap-2 px-4">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="w-10 h-10 bg-[var(--polar-frost)] rounded-lg animate-pulse" />
      ))}
    </div>
  </div>
);

function App() {
  const {
    view,
    setView,
    currentProject,
    currentImageData,
    setCurrentImageData,
    saveNewCaptureFromFile,
    setHasUnsavedChanges,
    loadCaptures,
    deleteCapture,
  } = useCaptureStore();

  // Editor state from store
  const { shapes, setShapes, clearEditor, compositorSettings, setCompositorSettings, setCanvasBounds, setOriginalImageSize, selectedIds, setSelectedIds, canUndo, canRedo } = useEditorStore();

  // Initialize theme (applies theme class to document root)
  useTheme();

  // Local editor UI state
  const [selectedTool, setSelectedTool] = useState<Tool>('select');

  // Wrapper to deselect elements when switching away from select tool
  const handleToolChange = useCallback((newTool: Tool) => {
    if (newTool !== selectedTool && selectedTool === 'select') {
      setSelectedIds([]);
    }
    setSelectedTool(newTool);
  }, [selectedTool, setSelectedIds]);

  const [strokeColor, setStrokeColor] = useState('#ef4444');
  const [fillColor, setFillColor] = useState('transparent');
  const [strokeWidth, setStrokeWidth] = useState(3);
  const stageRef = useRef<Konva.Stage>(null);
  const editorCanvasRef = useRef<EditorCanvasRef>(null);
  
  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Extracted hooks for capture/editor actions
  const { triggerNewCapture, triggerFullscreenCapture, triggerAllMonitorsCapture } = useCaptureActions();
  const { isCopying, isSaving, handleCopy, handleSave, handleSaveAs } = useEditorActions({ stageRef });
  const { handleBack } = useEditorPersistence({ editorCanvasRef });

  // Delete confirmation dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Auto-update checker (runs 5s after app starts)
  useUpdater(true);

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

  // Command palette action handlers
  const handleFitToCenter = useCallback(() => {
    window.dispatchEvent(new CustomEvent('fit-to-center'));
  }, []);

  const handleToggleCompositor = useCallback(() => {
    setCompositorSettings({ enabled: !compositorSettings.enabled });
  }, [compositorSettings.enabled, setCompositorSettings]);

  const handleBackToLibrary = useCallback(() => {
    setView('library');
  }, [setView]);

  const handleOpenSettings = useCallback(() => {
    useSettingsStore.getState().openSettingsModal();
  }, []);

  // Consolidated event listener callbacks
  const eventCallbacks = useMemo(
    () => ({
      onRecordingComplete: loadCaptures,
      onCaptureCompleteFast: async (data: { file_path: string; width: number; height: number }) => {
        clearEditor();
        clearHistory();
        // Set dimensions BEFORE setting image data - prevents race condition with effects
        setOriginalImageSize({ width: data.width, height: data.height });
        setCanvasBounds({
          width: data.width,
          height: data.height,
          imageOffsetX: 0,
          imageOffsetY: 0,
        });
        setCurrentImageData(data.file_path);
        setView('editor');
        await saveNewCaptureFromFile(data.file_path, data.width, data.height, 'region', {}, { silent: true });
      },
    }),
    [loadCaptures, clearEditor, setCurrentImageData, setView, saveNewCaptureFromFile, setOriginalImageSize, setCanvasBounds]
  );

  // Consolidated Tauri event listeners (replaces 5 individual useEffect hooks)
  useAppEventListeners(eventCallbacks);

  // Load captures on mount
  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Run startup cleanup (orphan temp files, missing thumbnails)
  useEffect(() => {
    invoke('startup_cleanup').catch(
      createErrorHandler({ operation: 'startup cleanup', silent: true })
    );
  }, []);

  // Reset to select tool when a new image is loaded
  useEffect(() => {
    if (currentImageData) {
      setSelectedTool('select');
    }
  }, [currentImageData]);

  // Initialize settings and register shortcuts (non-blocking)
  useEffect(() => {
    // Set up shortcut handlers IMMEDIATELY (synchronous, no blocking)
    setShortcutHandler('new_capture', triggerNewCapture);
    setShortcutHandler('fullscreen_capture', triggerFullscreenCapture);
    setShortcutHandler('all_monitors_capture', triggerAllMonitorsCapture);

    // Defer heavy initialization to after first paint for responsive UI
    const initSettings = async () => {
      try {
        const { loadSettings } = useSettingsStore.getState();
        await loadSettings();

        // Run backend sync and shortcut registration in parallel
        const updatedSettings = useSettingsStore.getState().settings;
        await Promise.allSettled([
          invoke('set_close_to_tray', { enabled: updatedSettings.general.minimizeToTray }),
          registerAllShortcuts(),
        ]);
      } catch (error) {
        console.error('Failed to initialize settings:', error);
      }
    };

    // Use requestIdleCallback if available, otherwise setTimeout
    // This ensures UI renders first before heavy init work
    if ('requestIdleCallback' in window) {
      (window as typeof window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => initSettings());
    } else {
      setTimeout(initSettings, 0);
    }
  }, [triggerNewCapture, triggerFullscreenCapture, triggerAllMonitorsCapture]);

  // Sync recording state with backend on window focus
  // This handles edge cases where frontend/backend state may drift
  useEffect(() => {
    const handleFocus = () => {
      useVideoRecordingStore.getState().refreshStatus();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Note: Event listeners for recording-state-changed, open-settings, create-capture-toolbar,
  // capture-complete, and capture-complete-fast are now consolidated in useAppEventListeners

  // Load annotations when project changes
  useEffect(() => {
    if (currentProject?.annotations) {
      // Separate special annotations from shape annotations using type guards
      const cropBoundsAnn = currentProject.annotations.find(isCropBoundsAnnotation);
      const compositorAnn = currentProject.annotations.find(isCompositorSettingsAnnotation);
      const shapeAnnotations = currentProject.annotations.filter(
        (ann) => !isCropBoundsAnnotation(ann) && !isCompositorSettingsAnnotation(ann)
      );

      // Load crop bounds if present (type is narrowed by type guard)
      if (cropBoundsAnn) {
        setCanvasBounds({
          width: cropBoundsAnn.width,
          height: cropBoundsAnn.height,
          imageOffsetX: cropBoundsAnn.imageOffsetX,
          imageOffsetY: cropBoundsAnn.imageOffsetY,
        });
      }

      // Load compositor settings if present (type is narrowed by type guard)
      if (compositorAnn) {
        setCompositorSettings({
          enabled: compositorAnn.enabled,
          backgroundType: compositorAnn.backgroundType ?? 'gradient',
          backgroundColor: compositorAnn.backgroundColor ?? '#6366f1',
          gradientAngle: compositorAnn.gradientAngle ?? 135,
          gradientStops: compositorAnn.gradientStops ?? [
            { color: '#667eea', position: 0 },
            { color: '#764ba2', position: 100 },
          ],
          backgroundImage: compositorAnn.backgroundImage ?? null,
          padding: compositorAnn.padding ?? 64,
          borderRadius: compositorAnn.borderRadius ?? 12,
          shadowEnabled: compositorAnn.shadowEnabled ?? true,
          shadowIntensity: compositorAnn.shadowIntensity ?? 0.5,
          aspectRatio: compositorAnn.aspectRatio ?? 'auto',
        });
      }

      // Set original image size for reset functionality
      if (currentProject.dimensions) {
        setOriginalImageSize({
          width: currentProject.dimensions.width,
          height: currentProject.dimensions.height,
        });
      }

      // Convert annotations to shapes
      const projectShapes: CanvasShape[] = shapeAnnotations.map((ann) => ({
        ...ann,
        id: ann.id,
        type: ann.type,
      } as CanvasShape));
      setShapes(projectShapes);
    } else {
      setShapes([]);
    }
  }, [currentProject, setCanvasBounds, setCompositorSettings, setOriginalImageSize, setShapes]);

  // Handle shapes change
  const handleShapesChange = (newShapes: CanvasShape[]) => {
    setShapes(newShapes);
    setHasUnsavedChanges(true);
  };

  // Keyboard shortcuts (consolidated hook)
  const { commandPaletteOpen, setCommandPaletteOpen } = useEditorKeyboardShortcuts({
    view,
    selectedTool,
    selectedIds,
    compositorEnabled: compositorSettings.enabled,
    onToolChange: handleToolChange,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onSave: handleSave,
    onCopy: handleCopy,
    onToggleCompositor: handleToggleCompositor,
    onShowShortcuts: useCallback(() => setShowShortcuts(true), []),
    onDeselect: useCallback(() => setSelectedIds([]), [setSelectedIds]),
    onFitToCenter: handleFitToCenter,
  });

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--polar-snow)] overflow-hidden">
      {/* Toast Notifications */}
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: 'var(--card)',
            border: '1px solid var(--polar-frost)',
            color: 'var(--ink-black)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          },
        }}
      />
      
      {/* Keyboard Shortcuts Help Modal */}
      <KeyboardShortcutsModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        view={view}
        selectedTool={selectedTool}
        hasProject={!!currentProject}
        canUndo={canUndo}
        canRedo={canRedo}
        onToolChange={handleToolChange}
        onCopy={handleCopy}
        onSave={handleSave}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onFitToCenter={handleFitToCenter}
        onShowShortcuts={() => setShowShortcuts(true)}
        onOpenSettings={handleOpenSettings}
        onBackToLibrary={handleBackToLibrary}
        onRequestDelete={handleRequestDelete}
        onToggleCompositor={handleToggleCompositor}
      />

      {/* Settings Modal */}
      <SettingsModalContainer />
      
      {/* Custom Titlebar */}
      <Titlebar />

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Library */}
        <Activity mode={view === 'library' ? 'visible' : 'hidden'}>
          <LibraryErrorBoundary>
            <CaptureLibrary />
          </LibraryErrorBoundary>
        </Activity>

        {/* Editor */}
        <Activity mode={view === 'editor' ? 'visible' : 'hidden'}>
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
        </Activity>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        count={1}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  );
}

export default App;
