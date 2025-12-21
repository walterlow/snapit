import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import Konva from 'konva';
import { Titlebar } from './components/Titlebar/Titlebar';
import { CaptureLibrary } from './components/Library/CaptureLibrary';
import { EditorCanvas } from './components/Editor/EditorCanvas';
import { Toolbar } from './components/Editor/Toolbar';
import { PropertiesPanel } from './components/Editor/PropertiesPanel';
import { useCaptureStore } from './stores/captureStore';
import { useEditorStore } from './stores/editorStore';
import { compositeImage } from './utils/compositor';
import type { Tool, CanvasShape, Annotation } from './types';

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

  // Undo/Redo handlers
  const handleUndo = useCallback(() => {
    useEditorStore.temporal.getState().undo();
  }, []);

  const handleRedo = useCallback(() => {
    useEditorStore.temporal.getState().redo();
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
      };

      const tool = toolShortcuts[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        setSelectedTool(tool);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, handleUndo, handleRedo]);

  // Load captures on mount
  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Listen for capture-complete event from Rust
  useEffect(() => {
    const unlisten = listen<string>('capture-complete', async (event) => {
      const imageData = event.payload;

      // Save the capture to storage
      try {
        await saveNewCapture(imageData, 'region', {});
        clearEditor();
        useEditorStore.temporal.getState().clear(); // Clear undo history for new capture
      } catch (error) {
        console.error('Failed to save capture:', error);
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

  // Copy to clipboard
  const handleCopy = async () => {
    if (!stageRef.current || !currentImageData) return;

    try {
      // Get layer reference
      const layer = stageRef.current.findOne('Layer') as Konva.Layer;
      if (!layer) return;

      // Find the background image to get original dimensions
      const imageNode = stageRef.current.findOne('[name=background]') as Konva.Image | undefined;
      const imageWidth = imageNode?.width() || 800;
      const imageHeight = imageNode?.height() || 600;

      // Save current stage transform (zoom/pan)
      const stage = stageRef.current;
      const savedScale = { x: stage.scaleX(), y: stage.scaleY() };
      const savedPosition = { x: stage.x(), y: stage.y() };

      // Reset stage to 1:1 for true-size export
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });

      // Physically remove editor-only elements from their parents before export
      // Try multiple selector syntaxes
      let checkerboard = stageRef.current.findOne('.checkerboard');
      if (!checkerboard) checkerboard = stageRef.current.findOne('[name=checkerboard]');

      let editorShadow = stageRef.current.findOne('.editor-shadow');
      if (!editorShadow) editorShadow = stageRef.current.findOne('[name=editor-shadow]');

      console.log('Export debug - checkerboard found:', !!checkerboard, checkerboard?.getClassName());

      // Debug: list all nodes with names
      const allNodes = stageRef.current.find('Rect');
      console.log('All Rects:', allNodes.map((n: Konva.Node) => ({ name: n.name(), className: n.getClassName() })));
      console.log('Export debug - editorShadow found:', !!editorShadow);

      const checkerParent = checkerboard?.getParent();
      const shadowParent = editorShadow?.getParent();
      const checkerIndex = checkerboard?.getZIndex();
      const shadowIndex = editorShadow?.getZIndex();

      if (checkerboard) checkerboard.remove();
      if (editorShadow) editorShadow.remove();

      // Force synchronous redraw at 1:1 scale before export
      layer.draw();

      // Calculate export region - use crop bounds if set, otherwise full image
      const exportX = Math.round(canvasBounds ? -canvasBounds.imageOffsetX : 0);
      const exportY = Math.round(canvasBounds ? -canvasBounds.imageOffsetY : 0);
      const exportWidth = Math.round(canvasBounds?.width || imageWidth);
      const exportHeight = Math.round(canvasBounds?.height || imageHeight);

      console.log('Export region:', { exportX, exportY, exportWidth, exportHeight });
      console.log('Canvas bounds:', canvasBounds);
      console.log('Layer children after remove:', layer.getChildren().length);

      // Export at true 1:1 pixel size
      const sourceCanvas = layer.toCanvas({
        x: exportX,
        y: exportY,
        width: exportWidth,
        height: exportHeight,
        pixelRatio: 1,
      });

      // Restore stage transform
      stage.scale(savedScale);
      stage.position(savedPosition);

      // Re-add editor elements to their parents
      if (checkerboard && checkerParent) {
        checkerParent.add(checkerboard);
        if (checkerIndex !== undefined) checkerboard.zIndex(checkerIndex);
      }
      if (editorShadow && shadowParent) {
        shadowParent.add(editorShadow);
        if (shadowIndex !== undefined) editorShadow.zIndex(shadowIndex);
      }
      layer.draw();

      // Apply compositor only if enabled, otherwise export directly (preserve transparency)
      let outputCanvas: HTMLCanvasElement;
      if (compositorSettings.enabled) {
        outputCanvas = await compositeImage({
          settings: compositorSettings,
          sourceCanvas,
          canvasBounds: null,
        });
      } else {
        outputCanvas = sourceCanvas;
      }

      const dataUrl = outputCanvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];

      await invoke('copy_to_clipboard', { imageData: base64 });
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  // Save to file
  const handleSave = async () => {
    if (!stageRef.current || !currentImageData) return;

    try {
      // First save annotations to project (including crop bounds)
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

      // Ask user for save location
      const filePath = await save({
        defaultPath: `capture_${Date.now()}.png`,
        filters: [{ name: 'Images', extensions: ['png'] }],
      });

      if (filePath) {
        // Get layer reference
        const layer = stageRef.current.findOne('Layer') as Konva.Layer;
        if (!layer) return;

        // Find the background image to get original dimensions
        const imageNode = stageRef.current.findOne('[name=background]') as Konva.Image | undefined;
        const imageWidth = imageNode?.width() || 800;
        const imageHeight = imageNode?.height() || 600;

        // Save current stage transform (zoom/pan)
        const stage = stageRef.current;
        const savedScale = { x: stage.scaleX(), y: stage.scaleY() };
        const savedPosition = { x: stage.x(), y: stage.y() };

        // Reset stage to 1:1 for true-size export
        stage.scale({ x: 1, y: 1 });
        stage.position({ x: 0, y: 0 });

        // Physically remove editor-only elements from their parents before export
        // Try multiple selector syntaxes
        let checkerboard = stageRef.current.findOne('.checkerboard');
        if (!checkerboard) checkerboard = stageRef.current.findOne('[name=checkerboard]');

        let editorShadow = stageRef.current.findOne('.editor-shadow');
        if (!editorShadow) editorShadow = stageRef.current.findOne('[name=editor-shadow]');

        console.log('SAVE debug - checkerboard found:', !!checkerboard);

        const checkerParent = checkerboard?.getParent();
        const shadowParent = editorShadow?.getParent();
        const checkerIndex = checkerboard?.getZIndex();
        const shadowIndex = editorShadow?.getZIndex();

        if (checkerboard) checkerboard.remove();
        if (editorShadow) editorShadow.remove();

        // Force synchronous redraw at 1:1 scale before export
        layer.draw();

        // Calculate export region - use crop bounds if set, otherwise full image
        const exportX = Math.round(canvasBounds ? -canvasBounds.imageOffsetX : 0);
        const exportY = Math.round(canvasBounds ? -canvasBounds.imageOffsetY : 0);
        const exportWidth = Math.round(canvasBounds?.width || imageWidth);
        const exportHeight = Math.round(canvasBounds?.height || imageHeight);

        // Export at true 1:1 pixel size
        const sourceCanvas = layer.toCanvas({
          x: exportX,
          y: exportY,
          width: exportWidth,
          height: exportHeight,
          pixelRatio: 1,
        });

        // Restore stage transform
        stage.scale(savedScale);
        stage.position(savedPosition);

        // Re-add editor elements to their parents
        if (checkerboard && checkerParent) {
          checkerParent.add(checkerboard);
          if (checkerIndex !== undefined) checkerboard.zIndex(checkerIndex);
        }
        if (editorShadow && shadowParent) {
          shadowParent.add(editorShadow);
          if (shadowIndex !== undefined) editorShadow.zIndex(shadowIndex);
        }
        layer.draw();

        // Apply compositor only if enabled, otherwise export directly (preserve transparency)
        let outputCanvas: HTMLCanvasElement;
        if (compositorSettings.enabled) {
          outputCanvas = await compositeImage({
            settings: compositorSettings,
            sourceCanvas,
            canvasBounds: null,
          });
        } else {
          outputCanvas = sourceCanvas;
        }

        const dataUrl = outputCanvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];

        await invoke('save_image', { imageData: base64, filePath: filePath, format: 'png' });
      }
    } catch (error) {
      console.error('Failed to save:', error);
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
    useEditorStore.temporal.getState().clear(); // Clear undo history
    setCurrentProject(null);
    setCurrentImageData(null);
    setView('library');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--obsidian-base)] overflow-hidden">
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
            />
          </>
        )}
      </div>
    </div>
  );
}

export default App;
