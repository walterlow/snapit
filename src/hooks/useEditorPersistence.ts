/**
 * Editor Persistence Hook
 *
 * Extracted from App.tsx to centralize editor exit and annotation persistence logic.
 * Handles saving annotations when leaving the editor and returning to library.
 */

import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCaptureStore } from '../stores/captureStore';
import { useEditorStore, clearHistory } from '../stores/editorStore';
import { createErrorHandler } from '../utils/errorReporting';
import type { EditorCanvasRef } from '../components/Editor/EditorCanvas';
import type { Annotation, CropBoundsAnnotation, CompositorSettingsAnnotation } from '../types';

interface UseEditorPersistenceProps {
  editorCanvasRef: React.RefObject<EditorCanvasRef | null>;
}

export function useEditorPersistence({ editorCanvasRef }: UseEditorPersistenceProps) {
  const { currentProject, setView, setCurrentProject, setCurrentImageData } = useCaptureStore();
  const { clearEditor } = useEditorStore();

  // Guard to prevent racing when rapidly exiting/saving
  const isSavingOnExitRef = useRef(false);

  /**
   * Go back to library - finalize any in-progress drawing, save annotations, then clear editor.
   * Uses optimistic UI: switches view immediately while saving annotations in background.
   */
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
  }, [currentProject, setView, setCurrentProject, setCurrentImageData, clearEditor, editorCanvasRef]);

  return {
    handleBack,
  };
}
