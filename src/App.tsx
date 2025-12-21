import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import Konva from 'konva';
import { toast, Toaster } from 'sonner';
import { Titlebar } from './components/Titlebar/Titlebar';
import { CaptureLibrary } from './components/Library/CaptureLibrary';
import { EditorCanvas } from './components/Editor/EditorCanvas';
import { Toolbar } from './components/Editor/Toolbar';
import { PropertiesPanel } from './components/Editor/PropertiesPanel';
import { KeyboardShortcutsModal } from './components/KeyboardShortcuts/KeyboardShortcutsModal';
import { SettingsModal } from './components/Settings/SettingsModal';
import { useCaptureStore } from './stores/captureStore';
import { useEditorStore, undo, redo, clearHistory } from './stores/editorStore';
import { useSettingsStore } from './stores/settingsStore';
import { registerAllShortcuts, setShortcutHandler } from './utils/hotkeyManager';
import type { Tool, CanvasShape, Annotation } from './types';

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
    updateAnnotations,
    setHasUnsavedChanges,
    loadCaptures,
  } = useCaptureStore();

  // Editor state from store
  const { shapes, setShapes, clearEditor, compositorSettings, canvasBounds, setCanvasBounds, setOriginalImageSize } = useEditorStore();

  // Local editor UI state
  const [selectedTool, setSelectedTool] = useState<Tool>('select');
  const [strokeColor, setStrokeColor] = useState('#ef4444');
  const [strokeWidth, setStrokeWidth] = useState(3);
  const stageRef = useRef<Konva.Stage>(null);
  
  // Loading states for async operations
  const [isCopying, setIsCopying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Undo/Redo handlers
  const handleUndo = useCallback(() => {
    undo();
  }, []);

  const handleRedo = useCallback(() => {
    redo();
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
        'x': 'crop',
        'a': 'arrow',
        'r': 'rect',
        'c': 'circle',
        't': 'text',
        'h': 'highlight',
        'b': 'blur',
        's': 'steps',
        'p': 'pen',
      };

      const tool = toolShortcuts[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        setSelectedTool(tool);
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
  }, [view, handleUndo, handleRedo]);

  // Load captures on mount
  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Capture trigger functions
  const triggerRegionCapture = useCallback(async () => {
    try {
      await invoke('show_overlay');
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

  const triggerWindowCapture = useCallback(async () => {
    // For now, window capture uses the same overlay as region capture
    // The user can then select a window from the overlay
    try {
      await invoke('show_overlay');
    } catch {
      toast.error('Failed to start capture');
    }
  }, []);

  // Initialize settings and register shortcuts
  useEffect(() => {
    const initSettings = async () => {
      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();
      
      // Set up shortcut handlers - these trigger actual captures
      setShortcutHandler('region_capture', triggerRegionCapture);
      setShortcutHandler('fullscreen_capture', triggerFullscreenCapture);
      setShortcutHandler('window_capture', triggerWindowCapture);
      
      // Register all shortcuts from settings
      await registerAllShortcuts();
    };
    
    initSettings();
  }, [triggerRegionCapture, triggerFullscreenCapture, triggerWindowCapture]);

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

  // Listen for capture-complete event from Rust
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

  // Load annotations when project changes
  useEffect(() => {
    if (currentProject?.annotations) {
      // Separate crop bounds from shape annotations
      const cropBoundsAnn = currentProject.annotations.find((ann) => ann.type === '__crop_bounds__');
      const shapeAnnotations = currentProject.annotations.filter((ann) => ann.type !== '__crop_bounds__');
      
      // Load crop bounds if present
      if (cropBoundsAnn) {
        setCanvasBounds({
          width: cropBoundsAnn.width as number,
          height: cropBoundsAnn.height as number,
          imageOffsetX: cropBoundsAnn.imageOffsetX as number,
          imageOffsetY: cropBoundsAnn.imageOffsetY as number,
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
  }, [currentProject, setCanvasBounds, setOriginalImageSize, setShapes]);

  // Handle shapes change
  const handleShapesChange = (newShapes: CanvasShape[]) => {
    setShapes(newShapes);
    setHasUnsavedChanges(true);
  };

  // Copy to clipboard (native browser API)
  const handleCopy = async () => {
    if (!stageRef.current || !currentImageData) return;

    setIsCopying(true);
    try {
      const stage = stageRef.current;
      const layer = stage.findOne('Layer') as Konva.Layer;
      if (!layer) return;

      // Get content dimensions from image or canvas bounds
      const imageNode = stage.findOne('[name=background]') as Konva.Image | undefined;
      const contentWidth = canvasBounds?.width || imageNode?.width() || 800;
      const contentHeight = canvasBounds?.height || imageNode?.height() || 600;
      const contentX = canvasBounds ? -canvasBounds.imageOffsetX : 0;
      const contentY = canvasBounds ? -canvasBounds.imageOffsetY : 0;

      // Calculate export bounds (with compositor padding if enabled)
      let exportX: number, exportY: number, exportWidth: number, exportHeight: number;
      
      if (compositorSettings.enabled) {
        const avgDimension = (contentWidth + contentHeight) / 2;
        const padding = avgDimension * (compositorSettings.padding / 100);
        exportX = Math.round(contentX - padding);
        exportY = Math.round(contentY - padding);
        exportWidth = Math.round(contentWidth + padding * 2);
        exportHeight = Math.round(contentHeight + padding * 2);
      } else {
        exportX = Math.round(contentX);
        exportY = Math.round(contentY);
        exportWidth = Math.round(contentWidth);
        exportHeight = Math.round(contentHeight);
      }

      // Save and reset transform for 1:1 export
      const savedScale = { x: stage.scaleX(), y: stage.scaleY() };
      const savedPosition = { x: stage.x(), y: stage.y() };
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });

    // Hide editor-only elements
    const checkerboard = stage.findOne('[name=checkerboard]');
    const editorShadow = stage.findOne('[name=editor-shadow]');
    if (checkerboard) checkerboard.hide();
    if (editorShadow) editorShadow.hide();

    // Export directly from Konva
    const outputCanvas = layer.toCanvas({
      x: exportX,
      y: exportY,
      width: exportWidth,
      height: exportHeight,
      pixelRatio: 1,
    });

    // Restore immediately
    stage.scale(savedScale);
    stage.position(savedPosition);
    if (checkerboard) checkerboard.show();
    if (editorShadow) editorShadow.show();

    // Use browser's native Clipboard API
    const blob = await new Promise<Blob>((resolve, reject) => {
      outputCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob'));
      }, 'image/png');
    });

    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);

    toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    } finally {
      setIsCopying(false);
    }
  };

  // Save to file (fast - exports directly from Konva)
  const handleSave = async () => {
    if (!stageRef.current || !currentImageData) return;

    setIsSaving(true);
    try {
      // Save annotations first
      if (currentProject) {
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
        
        await updateAnnotations(annotations);
      }

      // Ask user for save location first
      const filePath = await save({
        defaultPath: `capture_${Date.now()}.png`,
        filters: [{ name: 'Images', extensions: ['png'] }],
      });

      if (filePath) {
        const stage = stageRef.current;
        const layer = stage.findOne('Layer') as Konva.Layer;
        if (!layer) return;

        // Get content dimensions
        const imageNode = stage.findOne('[name=background]') as Konva.Image | undefined;
        const contentWidth = canvasBounds?.width || imageNode?.width() || 800;
        const contentHeight = canvasBounds?.height || imageNode?.height() || 600;
        const contentX = canvasBounds ? -canvasBounds.imageOffsetX : 0;
        const contentY = canvasBounds ? -canvasBounds.imageOffsetY : 0;

        // Calculate export bounds (with compositor padding if enabled)
        let exportX: number, exportY: number, exportWidth: number, exportHeight: number;
        
        if (compositorSettings.enabled) {
          const avgDimension = (contentWidth + contentHeight) / 2;
          const padding = avgDimension * (compositorSettings.padding / 100);
          exportX = Math.round(contentX - padding);
          exportY = Math.round(contentY - padding);
          exportWidth = Math.round(contentWidth + padding * 2);
          exportHeight = Math.round(contentHeight + padding * 2);
        } else {
          exportX = Math.round(contentX);
          exportY = Math.round(contentY);
          exportWidth = Math.round(contentWidth);
          exportHeight = Math.round(contentHeight);
        }

        // Save and reset transform
        const savedScale = { x: stage.scaleX(), y: stage.scaleY() };
        const savedPosition = { x: stage.x(), y: stage.y() };
        stage.scale({ x: 1, y: 1 });
        stage.position({ x: 0, y: 0 });

        // Hide editor-only elements
        const checkerboard = stage.findOne('[name=checkerboard]');
        const editorShadow = stage.findOne('[name=editor-shadow]');
        if (checkerboard) checkerboard.hide();
        if (editorShadow) editorShadow.hide();

        // Export directly from Konva
        const outputCanvas = layer.toCanvas({
          x: exportX,
          y: exportY,
          width: exportWidth,
          height: exportHeight,
          pixelRatio: 1,
        });

        // Restore immediately
        stage.scale(savedScale);
        stage.position(savedPosition);
        if (checkerboard) checkerboard.show();
        if (editorShadow) editorShadow.show();

        // Fast path: canvas.toBlob() -> Uint8Array -> direct file write (no IPC serialization)
        const blob = await new Promise<Blob>((resolve, reject) => {
          outputCanvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error('Failed to create blob'));
          }, 'image/png');
        });

        // Write directly using Tauri's fs plugin (handles binary efficiently)
        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(filePath, new Uint8Array(arrayBuffer));
        toast.success('Image saved successfully');
      }
    } catch {
      toast.error('Failed to save image');
    } finally {
      setIsSaving(false);
    }
  };

  // Go back to library
  const handleBack = async () => {
    // Save annotations before going back (including crop bounds)
    if (currentProject) {
      const shapeAnnotations: Annotation[] = shapes.map((shape) => ({
        ...shape,
      } as Annotation));
      
      // Add crop bounds as special annotation if modified
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
      
      await updateAnnotations(annotations);
    }

    clearEditor();
    clearHistory(); // Clear undo history
    setCurrentProject(null);
    setCurrentImageData(null);
    setView('library');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--obsidian-base)] overflow-hidden">
      {/* Toast Notifications */}
      <Toaster 
        position="top-center"
        toastOptions={{
          style: {
            background: 'var(--obsidian-elevated)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
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
        {view === 'library' ? (
          <CaptureLibrary />
        ) : (
          <>
            {/* Editor Area with optional Sidebar */}
            <div className="flex-1 flex min-h-0">
              {/* Canvas Area - flex-1 takes remaining space */}
              <div className="flex-1 overflow-hidden min-h-0 relative">
                {currentImageData && (
                  <EditorCanvas
                    imageData={currentImageData}
                    selectedTool={selectedTool}
                    onToolChange={setSelectedTool}
                    strokeColor={strokeColor}
                    strokeWidth={strokeWidth}
                    shapes={shapes}
                    onShapesChange={handleShapesChange}
                    stageRef={stageRef}
                  />
                )}
              </div>

              {/* Properties Sidebar - always visible */}
              <PropertiesPanel />
            </div>

            {/* Toolbar */}
            <Toolbar
              selectedTool={selectedTool}
              onToolChange={setSelectedTool}
              strokeColor={strokeColor}
              onStrokeColorChange={setStrokeColor}
              strokeWidth={strokeWidth}
              onStrokeWidthChange={setStrokeWidth}
              onCopy={handleCopy}
              onSave={handleSave}
              onBack={handleBack}
              onUndo={handleUndo}
              onRedo={handleRedo}
              isCopying={isCopying}
              isSaving={isSaving}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default App;
