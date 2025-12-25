import { useEffect, useRef, useState, useCallback, Activity } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import Konva from 'konva';
import { toast, Toaster } from 'sonner';
import { Titlebar } from './components/Titlebar/Titlebar';
import { CaptureLibrary } from './components/Library/CaptureLibrary';
import { DeleteDialog } from './components/Library/components/DeleteDialog';
import { EditorCanvas } from './components/Editor/EditorCanvas';
import { Toolbar } from './components/Editor/Toolbar';
import { PropertiesPanel } from './components/Editor/PropertiesPanel';
import { KeyboardShortcutsModal } from './components/KeyboardShortcuts/KeyboardShortcutsModal';
import { SettingsModal } from './components/Settings/SettingsModal';
import { useCaptureStore } from './stores/captureStore';
import { useEditorStore, undo, redo, clearHistory } from './stores/editorStore';
import { useSettingsStore } from './stores/settingsStore';
import { registerAllShortcuts, setShortcutHandler } from './utils/hotkeyManager';
import { useUpdater } from './hooks/useUpdater';
import { useTheme } from './hooks/useTheme';
import { getContentBounds, calculateExportBounds, exportCanvas } from './utils/canvasExport';
import type { Tool, CanvasShape, Annotation, CompositorSettings } from './types';

// Settings Modal Container - uses store for open/close state
const SettingsModalContainer: React.FC = () => {
  const { settingsModalOpen, closeSettingsModal } = useSettingsStore();
  return (
    <SettingsModal open={settingsModalOpen} onClose={closeSettingsModal} />
  );
};

function App() {
  const {
    view,
    setView,
    currentProject,
    currentImageData,
    setCurrentImageData,
    setCurrentProject,
    saveNewCapture,
    saveNewCaptureFromFile,
    updateAnnotations,
    setHasUnsavedChanges,
    loadCaptures,
    deleteCapture,
  } = useCaptureStore();

  // Editor state from store
  const { shapes, setShapes, clearEditor, compositorSettings, setCompositorSettings, canvasBounds, setCanvasBounds, setOriginalImageSize, setSelectedIds } = useEditorStore();

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
  
  // Loading states for async operations
  const [isCopying, setIsCopying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false);

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
      console.error('Failed to delete:', error);
      toast.error('Failed to delete capture');
    }
    setDeleteDialogOpen(false);
  }, [currentProject, deleteCapture, setView]);

  const handleCancelDelete = useCallback(() => {
    setDeleteDialogOpen(false);
  }, []);

  // Keyboard shortcuts for undo/redo, compositor, and tools
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle in editor view
      if (view !== 'editor') return;

      // Don't handle shortcuts when typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Tool shortcuts (only when no modifier keys)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const toolShortcuts: Record<string, Tool> = {
        'v': 'select',
        'c': 'crop',
        'a': 'arrow',
        'r': 'rect',
        'e': 'circle',
        't': 'text',
        'h': 'highlight',
        'b': 'blur',
        's': 'steps',
        'p': 'pen',
      };

      const tool = toolShortcuts[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        handleToolChange(tool);
        return;
      }

      // G: Toggle background tool and compositor
      if (e.key.toLowerCase() === 'g') {
        e.preventDefault();
        // If already on background tool, toggle the effect off and switch to select
        if (selectedTool === 'background') {
          setCompositorSettings({ enabled: false });
          handleToolChange('select');
        } else {
          // Switch to background tool and enable effect
          handleToolChange('background');
          setCompositorSettings({ enabled: true });
        }
        return;
      }

      // F: Fit to center (handled by EditorCanvas via custom event)
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('fit-to-center'));
        return;
      }

      // Escape: switch to select mode
      if (e.key === 'Escape') {
        e.preventDefault();
        handleToolChange('select');
        return;
      }

      // Show keyboard shortcuts help
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, handleUndo, handleRedo, compositorSettings.enabled, setCompositorSettings, selectedTool, handleToolChange]);

  // Load captures on mount
  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Refresh library when video recording completes
  useEffect(() => {
    const unlisten = listen<{ status: string }>('recording-state-changed', (event) => {
      if (event.payload.status === 'completed') {
        console.log('[App] Recording completed, refreshing library...');
        // Delay to ensure file is fully written and flushed
        setTimeout(() => {
          loadCaptures();
          // Refresh again after thumbnails might be generated
          setTimeout(() => loadCaptures(), 2000);
        }, 500);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadCaptures]);

  // Run startup cleanup (orphan temp files, missing thumbnails)
  useEffect(() => {
    invoke('startup_cleanup').catch(() => {});
  }, []);

  // Reset to select tool when a new image is loaded
  useEffect(() => {
    if (currentImageData) {
      setSelectedTool('select');
    }
  }, [currentImageData]);

  // Capture trigger functions
  const triggerNewCapture = useCallback(async () => {
    try {
      await invoke('show_overlay', { captureType: 'screenshot' });
    } catch {
      toast.error('Failed to start capture');
    }
  }, []);

  const triggerFullscreenCapture = useCallback(async () => {
    try {
      const result = await invoke<{ image_data: string }>('capture_fullscreen');
      if (result?.image_data) {
        await saveNewCapture(result.image_data, 'fullscreen', {});
        clearEditor();
        clearHistory();
        toast.success('Fullscreen captured');
      }
    } catch {
      toast.error('Failed to capture fullscreen');
    }
  }, [saveNewCapture, clearEditor]);

  const triggerAllMonitorsCapture = useCallback(async () => {
    try {
      // Get virtual screen bounds (calculated in Rust)
      const bounds = await invoke<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>('get_virtual_screen_bounds');

      // Capture full virtual desktop using screen region
      const result = await invoke<{ file_path: string; width: number; height: number }>(
        'capture_screen_region_fast',
        {
          selection: bounds
        }
      );

      await invoke('open_editor_fast', {
        filePath: result.file_path,
        width: result.width,
        height: result.height,
      });
    } catch {
      toast.error('Failed to capture all monitors');
    }
  }, []);

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

  // Listen for open-settings event from tray menu
  useEffect(() => {
    const unlisten = listen('open-settings', () => {
      useSettingsStore.getState().openSettingsModal();
    });
    
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Note: Shortcut event listeners are now set up in hotkeyManager.ts
  // when registerShortcut is called with allowOverride=true

  // Listen for capture-complete event from Rust (standard path with base64)
  useEffect(() => {
    const unlisten = listen<string>('capture-complete', async (event) => {
      const imageData = event.payload;

      // Save the capture to storage
      try {
        await saveNewCapture(imageData, 'region', {});
        clearEditor();
        clearHistory(); // Clear undo history for new capture
        toast.success('Screenshot captured');
      } catch {
        toast.error('Failed to save capture');
        // Still show the editor even if save fails
        setCurrentImageData(imageData);
        setView('editor');
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [saveNewCapture, setCurrentImageData, setView, clearEditor]);

  // Listen for capture-complete-fast event (fast path with file path)
  useEffect(() => {
    const unlisten = listen<{ file_path: string; width: number; height: number }>(
      'capture-complete-fast',
      async (event) => {
        const { file_path } = event.payload;

        // For fast capture, we show the editor immediately with the file path
        // The useFastImage hook will handle loading and conversion
        clearEditor();
        clearHistory();

        // Set the file path as image data - EditorCanvas handles both base64 and file paths
        setCurrentImageData(file_path);
        setView('editor');
        toast.success('Screenshot captured');

        // Save directly from RGBA file - no base64 conversion needed!
        try {
          await saveNewCaptureFromFile(
            file_path,
            event.payload.width,
            event.payload.height,
            'region',
            {},
            { silent: true }
          );
        } catch {
          // Silently fail - the capture is already displayed
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [saveNewCaptureFromFile, setCurrentImageData, setView, clearEditor]);

  // Load annotations when project changes
  useEffect(() => {
    if (currentProject?.annotations) {
      // Separate special annotations from shape annotations
      const cropBoundsAnn = currentProject.annotations.find((ann) => ann.type === '__crop_bounds__');
      const compositorAnn = currentProject.annotations.find((ann) => ann.type === '__compositor_settings__');
      const shapeAnnotations = currentProject.annotations.filter(
        (ann) => ann.type !== '__crop_bounds__' && ann.type !== '__compositor_settings__'
      );

      // Load crop bounds if present
      if (cropBoundsAnn) {
        setCanvasBounds({
          width: cropBoundsAnn.width as number,
          height: cropBoundsAnn.height as number,
          imageOffsetX: cropBoundsAnn.imageOffsetX as number,
          imageOffsetY: cropBoundsAnn.imageOffsetY as number,
        });
      }

      // Load compositor settings if present
      if (compositorAnn) {
        setCompositorSettings({
          enabled: compositorAnn.enabled as boolean,
          backgroundType: (compositorAnn.backgroundType as CompositorSettings['backgroundType']) ?? 'gradient',
          backgroundColor: (compositorAnn.backgroundColor as string) ?? '#6366f1',
          gradientAngle: (compositorAnn.gradientAngle as number) ?? 135,
          gradientStops: (compositorAnn.gradientStops as CompositorSettings['gradientStops']) ?? [
            { color: '#667eea', position: 0 },
            { color: '#764ba2', position: 100 },
          ],
          backgroundImage: (compositorAnn.backgroundImage as string | null) ?? null,
          padding: (compositorAnn.padding as number) ?? 64,
          borderRadius: (compositorAnn.borderRadius as number) ?? 12,
          shadowEnabled: (compositorAnn.shadowEnabled as boolean) ?? true,
          shadowIntensity: (compositorAnn.shadowIntensity as number) ?? 0.5,
          aspectRatio: (compositorAnn.aspectRatio as CompositorSettings['aspectRatio']) ?? 'auto',
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

  // Copy to clipboard (browser native API - faster than Rust for clipboard)
  const handleCopy = async () => {
    if (!stageRef.current || !currentImageData) return;

    setIsCopying(true);
    try {
      const stage = stageRef.current;
      const layer = stage.findOne('Layer') as Konva.Layer;
      if (!layer) return;

      const content = getContentBounds(stage, canvasBounds);
      const bounds = calculateExportBounds(content, compositorSettings);
      const outputCanvas = exportCanvas(stage, layer, bounds);

      // Browser native clipboard is faster (GPU accelerated, no disk I/O)
      const blob = await new Promise<Blob>((resolve, reject) => {
        outputCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to create blob'))),
          'image/png'
        );
      });

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    } finally {
      setIsCopying(false);
    }
  };

  // Save all project annotations (shapes, crop bounds, compositor settings)
  const saveProjectAnnotations = useCallback(async () => {
    if (!currentProject) return;

    const shapeAnnotations: Annotation[] = shapes.map((shape) => ({
      ...shape,
    } as Annotation));

    const annotations = [...shapeAnnotations];
    if (canvasBounds) {
      annotations.push({
        id: '__crop_bounds__',
        type: '__crop_bounds__',
        width: canvasBounds.width,
        height: canvasBounds.height,
        imageOffsetX: canvasBounds.imageOffsetX,
        imageOffsetY: canvasBounds.imageOffsetY,
      } as Annotation);
    }

    // Save all compositor settings
    annotations.push({
      id: '__compositor_settings__',
      type: '__compositor_settings__',
      ...compositorSettings,
    } as Annotation);

    await updateAnnotations(annotations);
  }, [currentProject, shapes, canvasBounds, compositorSettings, updateAnnotations]);

  // Save to file (browser toBlob + Tauri writeFile - no IPC serialization)
  const handleSave = async () => {
    if (!stageRef.current || !currentImageData) return;

    setIsSaving(true);
    try {
      await saveProjectAnnotations();

      const filePath = await save({
        defaultPath: `capture_${Date.now()}.png`,
        filters: [{ name: 'Images', extensions: ['png'] }],
      });

      if (filePath) {
        const stage = stageRef.current;
        const layer = stage.findOne('Layer') as Konva.Layer;
        if (!layer) return;

        const content = getContentBounds(stage, canvasBounds);
        const bounds = calculateExportBounds(content, compositorSettings);
        const outputCanvas = exportCanvas(stage, layer, bounds);

        // Browser toBlob (GPU accelerated) + Tauri writeFile (direct binary, no IPC overhead)
        const blob = await new Promise<Blob>((resolve, reject) => {
          outputCanvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('Failed to create blob'))),
            'image/png'
          );
        });

        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(filePath, new Uint8Array(arrayBuffer));
        toast.success('Image saved successfully');
      }
    } catch (err) {
      console.error('Save failed:', err);
      toast.error(`Failed to save image: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Save to file with specific format
  const handleSaveAs = async (format: 'png' | 'jpg' | 'webp') => {
    if (!stageRef.current || !currentImageData) return;

    setIsSaving(true);
    try {
      const stage = stageRef.current;
      const layer = stage.findOne('Layer') as Konva.Layer;
      if (!layer) return;

      const formatInfo = {
        png: { ext: 'png', mime: 'image/png', name: 'PNG', quality: undefined },
        jpg: { ext: 'jpg', mime: 'image/jpeg', name: 'JPEG', quality: 0.92 },
        webp: { ext: 'webp', mime: 'image/webp', name: 'WebP', quality: 0.9 },
      }[format];

      const filePath = await save({
        defaultPath: `capture_${Date.now()}.${formatInfo.ext}`,
        filters: [{ name: formatInfo.name, extensions: [formatInfo.ext] }],
      });

      if (filePath) {
        const content = getContentBounds(stage, canvasBounds);
        const bounds = calculateExportBounds(content, compositorSettings);
        const outputCanvas = exportCanvas(stage, layer, bounds);

        // Browser toBlob (GPU accelerated) + Tauri writeFile (direct binary)
        const blob = await new Promise<Blob>((resolve, reject) => {
          outputCanvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('Failed to create blob'))),
            formatInfo.mime,
            formatInfo.quality
          );
        });

        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(filePath, new Uint8Array(arrayBuffer));
        toast.success(`Image saved as ${formatInfo.name}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
      toast.error(`Failed to save image: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Go back to library - transition immediately, save in background
  const handleBack = () => {
    // Capture data for background save BEFORE clearing
    const projectToSave = currentProject;
    const shapesToSave = [...shapes];
    const boundsToSave = canvasBounds;
    const compositorToSave = { ...compositorSettings };

    // Switch view immediately - library stays mounted so it's instant
    setView('library');
    setCurrentProject(null);
    setCurrentImageData(null);

    // Defer cleanup and save to next frame so UI updates first
    requestAnimationFrame(() => {
      clearEditor();
      clearHistory();

      // Save annotations in background (fire and forget)
      if (projectToSave) {
        const annotations = shapesToSave.map((shape) => ({ ...shape }));
        if (boundsToSave) {
          annotations.push({
            id: '__crop_bounds__',
            type: '__crop_bounds__',
            width: boundsToSave.width,
            height: boundsToSave.height,
            imageOffsetX: boundsToSave.imageOffsetX,
            imageOffsetY: boundsToSave.imageOffsetY,
          } as any);
        }
        annotations.push({
          id: '__compositor_settings__',
          type: '__compositor_settings__',
          ...compositorToSave,
        } as any);

        updateAnnotations(annotations).catch(() => {});
      }
    });
  };

  // Keyboard shortcuts for save/copy (separate useEffect since these handlers are defined later)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (view !== 'editor') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        handleCopy();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, handleSave, handleCopy]);

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
      
      {/* Settings Modal */}
      <SettingsModalContainer />
      
      {/* Custom Titlebar */}
      <Titlebar />

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Library */}
        <Activity mode={view === 'library' ? 'visible' : 'hidden'}>
          <CaptureLibrary />
        </Activity>

        {/* Editor */}
        <Activity mode={view === 'editor' ? 'visible' : 'hidden'}>
          <div className="flex-1 flex flex-col min-h-0">
            {/* Editor Area with optional Sidebar */}
            <div className="flex-1 flex min-h-0">
              {/* Canvas Area - flex-1 takes remaining space */}
              <div className="flex-1 overflow-hidden min-h-0 relative">
                {currentImageData && (
                  <EditorCanvas
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
