/**
 * Editor Actions Hook
 *
 * Extracted from App.tsx to centralize editor save/export logic.
 * Handles copy to clipboard, save to file, and save as different formats.
 */

import { useState, useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import Konva from 'konva';
import { useCaptureStore } from '../stores/captureStore';
import { useEditorStore } from '../stores/editorStore';
import { exportToClipboard, exportToFile } from '../utils/canvasExport';
import { reportError } from '../utils/errorReporting';
import type { Annotation } from '../types';

interface UseEditorActionsProps {
  stageRef: React.RefObject<Konva.Stage | null>;
}

export function useEditorActions({ stageRef }: UseEditorActionsProps) {
  const [isCopying, setIsCopying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const { currentProject, currentImageData, updateAnnotations } = useCaptureStore();
  const { shapes, canvasBounds, compositorSettings } = useEditorStore();

  /**
   * Save all project annotations (shapes, crop bounds, compositor settings).
   */
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

  /**
   * Copy canvas to clipboard (browser native API - faster than Rust for clipboard).
   */
  const handleCopy = useCallback(async () => {
    if (!stageRef.current || !currentImageData) return;

    setIsCopying(true);
    try {
      await exportToClipboard(stageRef, canvasBounds, compositorSettings);
      toast.success('Copied to clipboard');
    } catch (error) {
      reportError(error, { operation: 'copy to clipboard' });
    } finally {
      setIsCopying(false);
    }
  }, [stageRef, currentImageData, canvasBounds, compositorSettings]);

  /**
   * Save to file (browser toBlob + Tauri writeFile - no IPC serialization).
   */
  const handleSave = useCallback(async () => {
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
    } catch (error) {
      reportError(error, { operation: 'save image' });
    } finally {
      setIsSaving(false);
    }
  }, [stageRef, currentImageData, canvasBounds, compositorSettings, saveProjectAnnotations]);

  /**
   * Save to file with specific format.
   */
  const handleSaveAs = useCallback(
    async (format: 'png' | 'jpg' | 'webp') => {
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
      } catch (error) {
        reportError(error, { operation: 'export image' });
      } finally {
        setIsSaving(false);
      }
    },
    [stageRef, currentImageData, canvasBounds, compositorSettings]
  );

  return {
    isCopying,
    isSaving,
    handleCopy,
    handleSave,
    handleSaveAs,
    saveProjectAnnotations,
  };
}
