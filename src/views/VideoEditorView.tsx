/**
 * VideoEditorView Component
 *
 * Main view for editing video recordings with features like:
 * - Auto-zoom to clicks
 * - Cursor highlighting
 * - Webcam overlay toggling
 * - Timeline-based editing
 */

import { useCallback, forwardRef, useImperativeHandle, useEffect } from 'react';
import { toast } from 'sonner';
import { Wand2, Loader2, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useCaptureStore } from '../stores/captureStore';
import { useVideoEditorStore } from '../stores/videoEditorStore';
import { GPUVideoPreview } from '../components/VideoEditor/GPUVideoPreview';
import { VideoTimeline } from '../components/VideoEditor/VideoTimeline';
import { PlaybackControls } from '../components/VideoEditor/PlaybackControls';
import { Button } from '../components/ui/button';
import type { ExportProgress } from '../types';

/**
 * Imperative API exposed by VideoEditorView
 */
export interface VideoEditorViewRef {
  togglePlayback: () => void;
  seekToStart: () => void;
  seekToEnd: () => void;
  exportVideo: () => void;
}

/**
 * VideoEditorView - Main video editor component with preview, timeline, and controls.
 */
export const VideoEditorView = forwardRef<VideoEditorViewRef>(function VideoEditorView(_props, ref) {
  const { setView } = useCaptureStore();
  const { 
    project, 
    togglePlayback, 
    setCurrentTime,
    clearEditor,
    generateAutoZoom,
    isGeneratingAutoZoom,
    isExporting,
    exportProgress,
    exportVideo,
    setExportProgress,
    cancelExport,
  } = useVideoEditorStore();

  // Listen for export progress events from Rust backend
  useEffect(() => {
    const unlisten = listen<ExportProgress>('export-progress', (event) => {
      setExportProgress(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setExportProgress]);

  // Navigate back to library
  const handleBack = useCallback(() => {
    clearEditor();
    setView('library');
  }, [clearEditor, setView]);

  // Export video with zoom effects applied
  const handleExport = useCallback(async () => {
    if (!project) return;

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

      // Start export
      const result = await exportVideo(outputPath);

      // Show success toast with file info
      const sizeMB = (result.fileSizeBytes / (1024 * 1024)).toFixed(1);
      toast.success(`Exported successfully`, {
        description: `${sizeMB} MB • ${result.format.toUpperCase()}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed';
      toast.error(message);
    }
  }, [project, exportVideo]);

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

  // Generate auto-zoom regions from cursor data
  const handleGenerateAutoZoom = useCallback(async () => {
    if (!project) return;
    
    try {
      await generateAutoZoom();
      toast.success('Generated auto-zoom regions from click events');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate auto-zoom';
      toast.error(message);
    }
  }, [generateAutoZoom, project]);

  // Check if cursor data is available
  const hasCursorData = project?.sources.cursorData != null;

  // Expose imperative API
  useImperativeHandle(ref, () => ({
    togglePlayback,
    seekToStart: handleSeekToStart,
    seekToEnd: handleSeekToEnd,
    exportVideo: handleExport,
  }), [togglePlayback, handleSeekToStart, handleSeekToEnd, handleExport]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      {/* Main content area - Preview and Properties */}
      <div className="flex-1 flex min-h-0">
        {/* Video Preview */}
        <div className="flex-1 flex flex-col min-w-0 p-4">
          <GPUVideoPreview />
        </div>

        {/* Right sidebar for properties (future: zoom settings, cursor config, etc.) */}
        <div className="w-72 bg-zinc-900/50 border-l border-zinc-800 flex flex-col">
          <div className="p-4 border-b border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-300">Properties</h3>
          </div>
          
          <div className="flex-1 p-4 overflow-y-auto">
            {/* Project Info */}
            <div className="space-y-4">
              <div>
                <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Project</label>
                <p className="text-sm text-zinc-300 mt-1 truncate">
                  {project?.name ?? 'No project loaded'}
                </p>
              </div>
              
              {project && (
                <>
                  <div>
                    <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Resolution</label>
                    <p className="text-sm text-zinc-300 mt-1 font-mono">
                      {project.sources.originalWidth} × {project.sources.originalHeight}
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Frame Rate</label>
                    <p className="text-sm text-zinc-300 mt-1 font-mono">
                      {project.sources.fps} fps
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Duration</label>
                    <p className="text-sm text-zinc-300 mt-1 font-mono">
                      {Math.floor(project.timeline.durationMs / 60000)}:{String(Math.floor((project.timeline.durationMs % 60000) / 1000)).padStart(2, '0')}
                    </p>
                  </div>

                  {/* Auto-Zoom Section */}
                  <div className="pt-4 border-t border-zinc-800">
                    <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Auto-Zoom</label>
                    <p className="text-sm text-zinc-400 mt-1 mb-3">
                      Generate zoom regions from click events
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      disabled={!hasCursorData || isGeneratingAutoZoom}
                      onClick={handleGenerateAutoZoom}
                    >
                      {isGeneratingAutoZoom ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Wand2 className="h-4 w-4 mr-2" />
                          Generate Auto-Zoom
                        </>
                      )}
                    </Button>
                    {!hasCursorData && (
                      <p className="text-[11px] text-zinc-500 mt-2">
                        No cursor data available for this recording
                      </p>
                    )}
                  </div>

                  <div className="pt-4 border-t border-zinc-800">
                    <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Zoom Regions</label>
                    <p className="text-sm text-zinc-300 mt-1">
                      {project.zoom.regions.length} region{project.zoom.regions.length !== 1 ? 's' : ''}
                    </p>
                  </div>

                  <div>
                    <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Webcam Segments</label>
                    <p className="text-sm text-zinc-300 mt-1">
                      {project.webcam.visibilitySegments.length} segment{project.webcam.visibilitySegments.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="h-48 min-h-[12rem] max-h-[16rem]">
        <VideoTimeline />
      </div>

      {/* Playback Controls Toolbar */}
      <PlaybackControls onBack={handleBack} onExport={handleExport} />

      {/* Export Progress Overlay */}
      {isExporting && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-lg p-6 w-80 shadow-xl border border-zinc-800">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-zinc-200">Exporting Video</h3>
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
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
              <div
                className="h-full bg-indigo-500 transition-all duration-300"
                style={{ width: `${(exportProgress?.progress ?? 0) * 100}%` }}
              />
            </div>
            
            {/* Progress info */}
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="capitalize">{exportProgress?.stage ?? 'preparing'}</span>
              <span>{Math.round((exportProgress?.progress ?? 0) * 100)}%</span>
            </div>
            
            {/* Status message */}
            {exportProgress?.message && (
              <p className="text-xs text-zinc-500 mt-2 truncate">
                {exportProgress.message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
