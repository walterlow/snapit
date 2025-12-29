import { useEffect, useRef, useState, useCallback, useMemo, Activity } from 'react';
import { Toaster } from 'sonner';
import { Titlebar } from './components/Titlebar/Titlebar';
import { CaptureLibrary } from './components/Library/CaptureLibrary';
import { LibraryErrorBoundary, EditorErrorBoundary } from './components/ErrorBoundary';
import { KeyboardShortcutsModal } from './components/KeyboardShortcuts/KeyboardShortcutsModal';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { SettingsModalContainer } from './components/Settings/SettingsModalContainer';
import { EditorView } from './views/EditorView';
import type { EditorViewRef } from './views/EditorView';
import { useCaptureStore } from './stores/captureStore';
import { useEditorStore, clearHistory } from './stores/editorStore';
import { useSettingsStore } from './stores/settingsStore';
import { useUpdater } from './hooks/useUpdater';
import { useTheme } from './hooks/useTheme';
import { useEditorKeyboardShortcuts } from './hooks/useEditorKeyboardShortcuts';
import { useAppEventListeners } from './hooks/useAppEventListeners';
import { useAppInitialization } from './hooks/useAppInitialization';
import { useProjectAnnotations } from './hooks/useProjectAnnotations';
import { useCaptureActions } from './hooks/useCaptureActions';
import type { Tool } from './types';

function App() {
  const {
    view,
    setView,
    currentProject,
    setCurrentImageData,
    saveNewCaptureFromFile,
    loadCaptures,
  } = useCaptureStore();

  // Editor state from store (for keyboard shortcuts and command palette)
  const {
    clearEditor,
    compositorSettings,
    setCanvasBounds,
    setOriginalImageSize,
    selectedIds,
    canUndo,
    canRedo,
  } = useEditorStore();

  // Initialize theme (applies theme class to document root)
  useTheme();

  // Auto-update checker (runs 5s after app starts)
  useUpdater(true);

  // Ref to EditorView for imperative access
  const editorViewRef = useRef<EditorViewRef>(null);

  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Capture actions for shortcuts
  const { triggerNewCapture, triggerFullscreenCapture, triggerAllMonitorsCapture } = useCaptureActions();

  // App initialization (settings, shortcuts, cleanup)
  useAppInitialization({
    triggerNewCapture,
    triggerFullscreenCapture,
    triggerAllMonitorsCapture,
  });

  // Project annotations sync (loads annotations when project changes)
  useProjectAnnotations();

  // Reset to select tool when a new image is loaded
  const currentImageData = useCaptureStore(state => state.currentImageData);
  useEffect(() => {
    if (currentImageData) {
      editorViewRef.current?.setTool('select');
    }
  }, [currentImageData]);

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

  // Consolidated Tauri event listeners
  useAppEventListeners(eventCallbacks);

  // Command palette action handlers that delegate to EditorView
  const handleToolChange = useCallback((tool: Tool) => {
    editorViewRef.current?.setTool(tool);
  }, []);

  const handleCopy = useCallback(() => {
    editorViewRef.current?.copy();
  }, []);

  const handleSave = useCallback(() => {
    editorViewRef.current?.save();
  }, []);

  const handleUndo = useCallback(() => {
    editorViewRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    editorViewRef.current?.redo();
  }, []);

  const handleFitToCenter = useCallback(() => {
    editorViewRef.current?.fitToCenter();
  }, []);

  const handleToggleCompositor = useCallback(() => {
    editorViewRef.current?.toggleCompositor();
  }, []);

  const handleRequestDelete = useCallback(() => {
    editorViewRef.current?.requestDelete();
  }, []);

  const handleDeselect = useCallback(() => {
    editorViewRef.current?.deselect();
  }, []);

  const handleBackToLibrary = useCallback(() => {
    setView('library');
  }, [setView]);

  const handleOpenSettings = useCallback(() => {
    useSettingsStore.getState().openSettingsModal();
  }, []);

  // Get selected tool from EditorView ref (with fallback for when ref not set)
  const getSelectedTool = useCallback((): Tool => {
    return editorViewRef.current?.selectedTool ?? 'select';
  }, []);

  // Keyboard shortcuts (consolidated hook)
  const { commandPaletteOpen, setCommandPaletteOpen } = useEditorKeyboardShortcuts({
    view,
    selectedTool: getSelectedTool(),
    selectedIds,
    compositorEnabled: compositorSettings.enabled,
    onToolChange: handleToolChange,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onSave: handleSave,
    onCopy: handleCopy,
    onToggleCompositor: handleToggleCompositor,
    onShowShortcuts: useCallback(() => setShowShortcuts(true), []),
    onDeselect: handleDeselect,
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
        selectedTool={getSelectedTool()}
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
          <EditorErrorBoundary projectId={currentProject?.id} onBack={handleBackToLibrary}>
            <EditorView ref={editorViewRef} />
          </EditorErrorBoundary>
        </Activity>
      </div>
    </div>
  );
}

export default App;
