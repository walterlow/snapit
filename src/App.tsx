import { useEffect, useRef, useState, useCallback, lazy, Suspense, Activity } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { save } from '@tauri-apps/plugin-dialog';
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
import { exportToClipboard, exportToFile } from './utils/canvasExport';
import { createErrorHandler } from './utils/errorReporting';
import type { Tool, CanvasShape, Annotation, CropBoundsAnnotation, CompositorSettingsAnnotation } from './types';
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
    setCurrentProject,
    saveNewCapture,
    saveNewCaptureFromFile,
    updateAnnotations,
    setHasUnsavedChanges,
    loadCaptures,
    deleteCapture,
  } = useCaptureStore();

  // Editor state from store
  const { shapes, setShapes, clearEditor, compositorSettings, setCompositorSettings, canvasBounds, setCanvasBounds, setOriginalImageSize, selectedIds, setSelectedIds, canUndo, canRedo } = useEditorStore();

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

  // Guard to prevent racing when rapidly exiting/saving
  const isSavingOnExitRef = useRef(false);

  // Loading states for async operations
  const [isCopying, setIsCopying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Command palette
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

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

  // Command palette shortcut (Ctrl+K / Cmd+K) - works in all views
  useEffect(() => {
    const handleCommandPalette = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(open => !open);
      }
    };
    window.addEventListener('keydown', handleCommandPalette);
    return () => window.removeEventListener('keydown', handleCommandPalette);
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
        'l': 'line',
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

      // Escape: deselect shapes first, then switch to select tool
      if (e.key === 'Escape') {
        e.preventDefault();
        // Priority 1: Deselect shapes if any are selected
        if (selectedIds.length > 0) {
          setSelectedIds([]);
          return;
        }
        // Priority 2: Switch to select tool if on different tool
        if (selectedTool !== 'select') {
          handleToolChange('select');
          return;
        }
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
  }, [view, handleUndo, handleRedo, compositorSettings.enabled, setCompositorSettings, selectedTool, handleToolChange, selectedIds, setSelectedIds]);

  // Load captures on mount
  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Refresh library when video recording completes
  useEffect(() => {
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];

    const unlisten = listen<{ status: string }>('recording-state-changed', (event) => {
      if (event.payload.status === 'completed') {
        console.log('[App] Recording completed, refreshing library...');
        // Delay to ensure file is fully written and flushed
        const t1 = setTimeout(() => {
          loadCaptures();
          // Refresh again after thumbnails might be generated
          const t2 = setTimeout(() => loadCaptures(), 2000);
          timeoutIds.push(t2);
        }, 500);
        timeoutIds.push(t1);
      }
    });

    return () => {
      timeoutIds.forEach(clearTimeout);
      unlisten.then((fn) => fn()).catch(() => {});
    };
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
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Sync recording state with backend on window focus
  // This handles edge cases where frontend/backend state may drift
  useEffect(() => {
    const handleFocus = () => {
      useVideoRecordingStore.getState().refreshStatus();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Listen for create-capture-toolbar event from Rust D2D overlay
  // Creates toolbar window from frontend for full control over sizing/positioning
  useEffect(() => {
    const unlisten = listen<{ x: number; y: number; width: number; height: number }>(
      'create-capture-toolbar',
      async (event) => {
        const { x, y, width, height } = event.payload;

        // Close any existing toolbar window first
        const existing = await WebviewWindow.getByLabel('capture-toolbar');
        if (existing) {
          try {
            await existing.close();
          } catch {
            // Ignore
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        // Create toolbar window - starts hidden, frontend will position and show
        const url = `/capture-toolbar.html?x=${x}&y=${y}&width=${width}&height=${height}`;
        const win = new WebviewWindow('capture-toolbar', {
          url,
          title: 'Selection Toolbar',
          width: 900,
          height: 300,
          x: x + Math.floor(width / 2) - 450, // Centered below selection
          y: y + height + 8,
          resizable: false,
          decorations: false,
          alwaysOnTop: true,
          transparent: true,
          skipTaskbar: true,
          shadow: false,
          visible: false, // Hidden until toolbar measures and positions itself
          focus: false,
        });

        win.once('tauri://error', (e) => {
          console.error('Failed to create capture toolbar:', e);
        });
      }
    );

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
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
      unlisten.then((fn) => fn()).catch(() => {});
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
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [saveNewCaptureFromFile, setCurrentImageData, setView, clearEditor]);

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

  // Copy to clipboard (browser native API - faster than Rust for clipboard)
  const handleCopy = async () => {
    if (!stageRef.current || !currentImageData) return;

    setIsCopying(true);
    try {
      await exportToClipboard(stageRef, canvasBounds, compositorSettings);
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
        await exportToFile(stageRef, canvasBounds, compositorSettings, filePath);
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
      const formatInfo = {
        png: { ext: 'png', mime: 'image/png' as const, name: 'PNG', quality: undefined },
        jpg: { ext: 'jpg', mime: 'image/jpeg' as const, name: 'JPEG', quality: 0.92 },
        webp: { ext: 'webp', mime: 'image/webp' as const, name: 'WebP', quality: 0.9 },
      }[format];

      const filePath = await save({
        defaultPath: `capture_${Date.now()}.${formatInfo.ext}`,
        filters: [{ name: formatInfo.name, extensions: [formatInfo.ext] }],
      });

      if (filePath) {
        await exportToFile(stageRef, canvasBounds, compositorSettings, filePath, {
          format: formatInfo.mime,
          quality: formatInfo.quality,
        });
        toast.success(`Image saved as ${formatInfo.name}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
      toast.error(`Failed to save image: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Go back to library - finalize any in-progress drawing, save, then clear
  const handleBack = useCallback(async () => {
    // Guard against rapid multiple clicks causing race conditions
    if (isSavingOnExitRef.current) return;
    isSavingOnExitRef.current = true;

    try {
      // Finalize any in-progress drawing FIRST to capture shapes that might be in refs
      // Then read DIRECTLY from store to get latest state (bypasses React batching)
      editorCanvasRef.current?.finalizeAndGetShapes();
      const storeState = useEditorStore.getState();
      const finalizedShapes = storeState.shapes;

      // Capture data for save BEFORE any state changes
      // Read from store directly to ensure we have latest values
      const projectToSave = currentProject;
      const boundsToSave = storeState.canvasBounds;
      const compositorToSave = { ...storeState.compositorSettings };

      // Switch view immediately for responsive UX
      setView('library');
      setCurrentProject(null);
      setCurrentImageData(null);
      clearEditor();
      clearHistory();

      // Save annotations in background using invoke directly (not updateAnnotations)
      // because updateAnnotations reads currentProject from store which we just cleared
      if (projectToSave) {
        const annotations: Annotation[] = finalizedShapes.map((shape) => ({ ...shape }));
        if (boundsToSave) {
          const cropAnnotation: CropBoundsAnnotation = {
            id: '__crop_bounds__',
            type: '__crop_bounds__',
            width: boundsToSave.width,
            height: boundsToSave.height,
            imageOffsetX: boundsToSave.imageOffsetX,
            imageOffsetY: boundsToSave.imageOffsetY,
          };
          annotations.push(cropAnnotation);
        }
        const compositorAnnotation: CompositorSettingsAnnotation = {
          id: '__compositor_settings__',
          type: '__compositor_settings__',
          ...compositorToSave,
        };
        annotations.push(compositorAnnotation);

        // Use invoke directly with captured projectId to bypass store's currentProject check
        invoke('update_project_annotations', {
          projectId: projectToSave.id,
          annotations,
        }).catch(createErrorHandler({ operation: 'save annotations', silent: true }));
      }
    } finally {
      isSavingOnExitRef.current = false;
    }
  }, [currentProject, setView, setCurrentProject, setCurrentImageData, clearEditor]);

  // Keyboard shortcuts for save/copy (separate useEffect since these handlers are defined later)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (view !== 'editor') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
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
