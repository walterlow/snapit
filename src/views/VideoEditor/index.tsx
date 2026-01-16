/**
 * VideoEditorView Component
 *
 * Main view for editing video recordings with features like:
 * - Auto-zoom to clicks
 * - Cursor highlighting
 * - Webcam overlay toggling
 * - Timeline-based editing
 */

import { useCallback, forwardRef, useImperativeHandle, useEffect, useState, lazy, Suspense } from 'react';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useCaptureStore } from '../../stores/captureStore';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { useVideoEditorShortcuts } from '../../hooks/useVideoEditorShortcuts';
import { Button } from '../../components/ui/button';
import { VideoEditorToolbar } from './VideoEditorToolbar';
import { VideoEditorSidebar } from './VideoEditorSidebar';
import { VideoEditorPreview } from './VideoEditorPreview';
import { VideoEditorTimeline } from './VideoEditorTimeline';
import type { ExportProgress, CropConfig, CompositionConfig } from '../../types';
import { videoEditorLogger } from '../../utils/logger';

// Lazy load CropDialog - only needed when crop tool is opened (861 lines)
const CropDialog = lazy(() => import('../../components/VideoEditor/CropDialog').then(m => ({ default: m.CropDialog })));

/**
 * Imperative API exposed by VideoEditorView
 */
export interface VideoEditorViewRef {
  togglePlayback: () => void;
  seekToStart: () => void;
  seekToEnd: () => void;
  exportVideo: () => void;
}

export interface VideoEditorViewProps {
  /** Custom back handler. If not provided, navigates to library view. */
  onBack?: () => void;
  /** Hide the top bar entirely (useful when embedded in a window with its own titlebar) */
  hideTopBar?: boolean;
}

/**
 * VideoEditorView - Main video editor component with preview, timeline, and controls.
 */
export const VideoEditorView = forwardRef<VideoEditorViewRef, VideoEditorViewProps>(function VideoEditorView(
  { onBack, hideTopBar },
  ref
) {
  const { setView } = useCaptureStore();
  const {
    project,
    togglePlayback,
    setCurrentTime,
    clearEditor,
    isExporting,
    exportProgress,
    exportVideo,
    setExportProgress,
    cancelExport,
    updateExportConfig,
    splitMode,
    setSplitMode,
    splitZoomRegionAtPlayhead,
    selectZoomRegion,
    timelineZoom,
    setTimelineZoom,
    // Zoom region
    selectedZoomRegionId,
    deleteZoomRegion,
    // Scene segment
    selectedSceneSegmentId,
    selectSceneSegment,
    deleteSceneSegment,
    // Mask segment
    selectedMaskSegmentId,
    selectMaskSegment,
    deleteMaskSegment,
    // Text segment
    selectedTextSegmentId,
    selectTextSegment,
    deleteTextSegment,
    // Save
    saveProject,
    isSaving,
  } = useVideoEditorStore();

  // Crop dialog state
  const [isCropDialogOpen, setIsCropDialogOpen] = useState(false);

  // Skip amount in milliseconds
  const SKIP_AMOUNT_MS = 5000;

  // Keyboard shortcut handlers
  const handleSkipBack = useCallback(() => {
    const store = useVideoEditorStore.getState();
    const newTime = Math.max(0, store.currentTimeMs - SKIP_AMOUNT_MS);
    setCurrentTime(newTime);
  }, [setCurrentTime]);

  const handleSkipForward = useCallback(() => {
    const store = useVideoEditorStore.getState();
    if (!store.project) return;
    const newTime = Math.min(store.project.timeline.durationMs, store.currentTimeMs + SKIP_AMOUNT_MS);
    setCurrentTime(newTime);
  }, [setCurrentTime]);

  const handleToggleSplitMode = useCallback(() => {
    setSplitMode(!splitMode);
    toast.info(splitMode ? 'Split mode off' : 'Split mode on (press C to cut)');
  }, [splitMode, setSplitMode]);

  const handleDeselect = useCallback(() => {
    if (splitMode) {
      setSplitMode(false);
    } else {
      // Deselect all segment types
      selectZoomRegion(null);
      selectSceneSegment(null);
      selectMaskSegment(null);
      selectTextSegment(null);
    }
  }, [splitMode, setSplitMode, selectZoomRegion, selectSceneSegment, selectMaskSegment, selectTextSegment]);

  // Delete whichever segment type is currently selected
  const handleDeleteSelected = useCallback(() => {
    if (selectedZoomRegionId) {
      deleteZoomRegion(selectedZoomRegionId);
    } else if (selectedSceneSegmentId) {
      deleteSceneSegment(selectedSceneSegmentId);
    } else if (selectedMaskSegmentId) {
      deleteMaskSegment(selectedMaskSegmentId);
    } else if (selectedTextSegmentId) {
      deleteTextSegment(selectedTextSegmentId);
    }
  }, [
    selectedZoomRegionId,
    selectedSceneSegmentId,
    selectedMaskSegmentId,
    selectedTextSegmentId,
    deleteZoomRegion,
    deleteSceneSegment,
    deleteMaskSegment,
    deleteTextSegment,
  ]);

  const handleTimelineZoomIn = useCallback(() => {
    setTimelineZoom(timelineZoom * 1.5);
  }, [timelineZoom, setTimelineZoom]);

  const handleTimelineZoomOut = useCallback(() => {
    setTimelineZoom(timelineZoom / 1.5);
  }, [timelineZoom, setTimelineZoom]);

  // Save project handler
  const handleSave = useCallback(async () => {
    if (!project || isSaving) return;
    try {
      await saveProject();
      toast.success('Project saved');
    } catch {
      toast.error('Failed to save project');
    }
  }, [project, isSaving, saveProject]);

  // Use keyboard shortcuts
  useVideoEditorShortcuts({
    enabled: !!project && !isExporting,
    onTogglePlayback: togglePlayback,
    onSeekToStart: () => setCurrentTime(0),
    onSeekToEnd: () => project && setCurrentTime(project.timeline.durationMs),
    onSkipBack: handleSkipBack,
    onSkipForward: handleSkipForward,
    onSplitAtPlayhead: splitZoomRegionAtPlayhead,
    onToggleSplitMode: handleToggleSplitMode,
    onDeleteSelected: handleDeleteSelected,
    onTimelineZoomIn: handleTimelineZoomIn,
    onTimelineZoomOut: handleTimelineZoomOut,
    onDeselect: handleDeselect,
    onSave: handleSave,
    onExport: () => {}, // Will be wired to handleExport after it's defined
  });

  // Listen for export progress events from Rust backend
  useEffect(() => {
    const unlisten = listen<ExportProgress>('export-progress', (event) => {
      setExportProgress(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setExportProgress]);

  // Auto-save project when it changes (debounced)
  useEffect(() => {
    if (!project || isSaving || isExporting) return;

    const timeoutId = setTimeout(() => {
      saveProject().catch((error) => {
        // Silent fail for auto-save - user can manually save with Ctrl+S
        console.warn('Auto-save failed:', error);
      });
    }, 2000); // 2 second debounce

    return () => clearTimeout(timeoutId);
  }, [project, isSaving, isExporting, saveProject]);

  // Navigate back to library
  const handleBack = useCallback(() => {
    clearEditor();
    if (onBack) {
      onBack();
    } else {
      setView('library');
    }
  }, [clearEditor, setView, onBack]);

  // Export video with zoom effects applied
  const handleExport = useCallback(async () => {
    if (!project) return;

    // Stop playback before exporting
    useVideoEditorStore.getState().setIsPlaying(false);

    try {
      // Show save dialog to choose output path
      const outputPath = await save({
        title: 'Export Video',
        defaultPath: `${project.name}.mp4`,
        filters: [
          { name: 'MP4 Video', extensions: ['mp4'] },
          { name: 'WebM Video', extensions: ['webm'] },
          { name: 'GIF Animation', extensions: ['gif'] },
        ],
      });

      if (!outputPath) {
        // User cancelled
        return;
      }

      // Start export (store handles format inference from file extension)
      const result = await exportVideo(outputPath);

      // Show success toast with file info
      const sizeMB = (result.fileSizeBytes / (1024 * 1024)).toFixed(1);
      toast.success(`Exported successfully`, {
        description: `${sizeMB} MB - ${result.format.toUpperCase()}`,
      });
    } catch (error) {
      videoEditorLogger.error('Export failed:', error);
      const message = error instanceof Error ? error.message : 'Export failed';
      toast.error(message);
    }
  }, [project, exportVideo]);

  // Handle crop apply (with composition)
  const handleCropApply = useCallback((crop: CropConfig, composition: CompositionConfig) => {
    updateExportConfig({ crop, composition });
    const message = crop.enabled
      ? composition.mode === 'manual'
        ? `Video cropped, composition set to ${composition.aspectPreset}`
        : 'Crop applied'
      : 'Crop removed';
    toast.success(message);
  }, [updateExportConfig]);

  // Seek to start
  const handleSeekToStart = useCallback(() => {
    setCurrentTime(0);
  }, [setCurrentTime]);

  // Seek to end
  const handleSeekToEnd = useCallback(() => {
    if (project) {
      setCurrentTime(project.timeline.durationMs);
    }
  }, [project, setCurrentTime]);

  // Expose imperative API
  useImperativeHandle(ref, () => ({
    togglePlayback,
    seekToStart: handleSeekToStart,
    seekToEnd: handleSeekToEnd,
    exportVideo: handleExport,
  }), [togglePlayback, handleSeekToStart, handleSeekToEnd, handleExport]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--polar-snow)]">
      {/* Main content area - Preview and Properties */}
      <div className="flex-1 flex min-h-0">
        {/* Left side: Top bar + Video Preview */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top Bar - hidden when embedded in window with its own titlebar */}
          {!hideTopBar && (
            <VideoEditorToolbar project={project} onBack={handleBack} />
          )}

          {/* Video Preview */}
          <VideoEditorPreview />
        </div>

        {/* Right sidebar with tabbed properties panel */}
        <VideoEditorSidebar
          project={project}
          onOpenCropDialog={() => setIsCropDialogOpen(true)}
        />
      </div>

      {/* Timeline with integrated controls */}
      <VideoEditorTimeline onExport={handleExport} />

      {/* Crop Dialog - lazy loaded, crops video content before composition */}
      {project && isCropDialogOpen && (
        <Suspense fallback={null}>
          <CropDialog
            open={isCropDialogOpen}
            onClose={() => setIsCropDialogOpen(false)}
            onApply={handleCropApply}
            videoWidth={project.sources.originalWidth}
            videoHeight={project.sources.originalHeight}
            initialCrop={project.export.crop}
            initialComposition={project.export.composition}
            videoPath={project.sources.screenVideo}
          />
        </Suspense>
      )}

      {/* Export Progress Overlay */}
      {isExporting && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[var(--polar-ice)] rounded-lg p-6 w-80 shadow-xl border border-[var(--glass-border)]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-[var(--ink-dark)]">Exporting Video</h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={cancelExport}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Progress bar */}
            <div className="h-2 bg-[var(--polar-mist)] rounded-full overflow-hidden mb-2">
              <div
                className="h-full bg-[var(--coral-400)] transition-all duration-300"
                style={{ width: `${(exportProgress?.progress ?? 0) * 100}%` }}
              />
            </div>

            {/* Progress info */}
            <div className="flex items-center justify-between text-xs text-[var(--ink-muted)]">
              <span className="capitalize">{exportProgress?.stage ?? 'preparing'}</span>
              <span>{Math.round((exportProgress?.progress ?? 0) * 100)}%</span>
            </div>

            {/* Status message */}
            {exportProgress?.message && (
              <p className="text-xs text-[var(--ink-subtle)] mt-2 truncate">
                {exportProgress.message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Re-export subcomponents for direct use if needed
export { VideoEditorToolbar } from './VideoEditorToolbar';
export { VideoEditorSidebar } from './VideoEditorSidebar';
export { VideoEditorPreview } from './VideoEditorPreview';
export { VideoEditorTimeline } from './VideoEditorTimeline';
export { PositionGrid } from './PositionGrid';
export { ZoomRegionConfig } from './ZoomRegionConfig';
export { MaskSegmentConfig } from './MaskSegmentConfig';
export { TextSegmentConfig } from './TextSegmentConfig';
