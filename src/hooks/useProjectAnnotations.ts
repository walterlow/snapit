/**
 * Project Annotations Hook
 *
 * Syncs project annotations to editor state when a project is loaded.
 * Handles:
 * - Crop bounds restoration
 * - Compositor settings restoration
 * - Original image size tracking
 * - Shape annotation conversion
 *
 * Extracted from App.tsx for better separation of concerns.
 */

import { useEffect } from 'react';
import { useCaptureStore } from '../stores/captureStore';
import { useEditorStore } from '../stores/editorStore';
import { isCropBoundsAnnotation, isCompositorSettingsAnnotation } from '../types';
import type { CanvasShape } from '../types';

/**
 * Hook that syncs project annotations to editor state.
 * Call this at the app level to ensure annotations are loaded when opening a project.
 */
export function useProjectAnnotations() {
  const { currentProject } = useCaptureStore();
  const { setShapes, setCanvasBounds, setCompositorSettings, setOriginalImageSize } = useEditorStore();

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
          gradientStart: compositorAnn.gradientStart ?? '#667eea',
          gradientEnd: compositorAnn.gradientEnd ?? '#764ba2',
          gradientAngle: compositorAnn.gradientAngle ?? 135,
          wallpaper: compositorAnn.wallpaper ?? null,
          backgroundImage: compositorAnn.backgroundImage ?? null,
          padding: compositorAnn.padding ?? 64,
          borderRadius: compositorAnn.borderRadius ?? 12,
          borderRadiusType: compositorAnn.borderRadiusType ?? 'squircle',
          shadowIntensity: compositorAnn.shadowIntensity ?? 0.5,
          borderWidth: compositorAnn.borderWidth ?? 2,
          borderColor: compositorAnn.borderColor ?? '#ffffff',
          borderOpacity: compositorAnn.borderOpacity ?? 0,
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
}
