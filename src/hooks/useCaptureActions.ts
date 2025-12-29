/**
 * Capture Actions Hook
 *
 * React hook wrapper around CaptureService for use in components.
 * Provides capture triggering with integrated store updates and UI feedback.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useCaptureStore } from '../stores/captureStore';
import { useEditorStore, clearHistory } from '../stores/editorStore';
import { CaptureService } from '../services/captureService';

export function useCaptureActions() {
  const { saveNewCapture } = useCaptureStore();
  const { clearEditor } = useEditorStore();

  /**
   * Trigger region capture overlay for screenshot.
   */
  const triggerNewCapture = useCallback(async () => {
    await CaptureService.showScreenshotOverlay();
  }, []);

  /**
   * Capture fullscreen of primary monitor.
   */
  const triggerFullscreenCapture = useCallback(async () => {
    const result = await CaptureService.captureFullscreen();
    if (result?.image_data) {
      await saveNewCapture(result.image_data, 'fullscreen', {});
      clearEditor();
      clearHistory();
      toast.success('Fullscreen captured');
    }
  }, [saveNewCapture, clearEditor]);

  /**
   * Capture all monitors combined into a single image.
   */
  const triggerAllMonitorsCapture = useCallback(async () => {
    await CaptureService.captureAllMonitorsToEditor();
  }, []);

  return {
    triggerNewCapture,
    triggerFullscreenCapture,
    triggerAllMonitorsCapture,
  };
}
