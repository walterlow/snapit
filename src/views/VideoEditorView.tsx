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
import { Wand2, Loader2, X, Circle, Square, RectangleHorizontal } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useCaptureStore } from '../stores/captureStore';
import { useVideoEditorStore } from '../stores/videoEditorStore';
import { GPUVideoPreview } from '../components/VideoEditor/GPUVideoPreview';
import { VideoTimeline } from '../components/VideoEditor/VideoTimeline';
import { PlaybackControls } from '../components/VideoEditor/PlaybackControls';
import { Button } from '../components/ui/button';
import { Slider } from '../components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import type { ExportProgress, WebcamOverlayShape, WebcamOverlayPosition } from '../types';

/**
 * Position grid for 9-point webcam anchor selection.
 * Maps to corner presets or custom positions for edges/center.
 */
interface PositionGridProps {
  position: WebcamOverlayPosition;
  customX: number;
  customY: number;
  onChange: (position: WebcamOverlayPosition, customX: number, customY: number) => void;
}

// Grid positions: [row][col] -> { position, customX, customY }
const GRID_POSITIONS: Array<{
  position: WebcamOverlayPosition;
  customX: number;
  customY: number;
  label: string;
}> = [
  // Top row
  { position: 'topLeft', customX: 0, customY: 0, label: 'Top Left' },
  { position: 'custom', customX: 0.5, customY: 0.02, label: 'Top Center' },
  { position: 'topRight', customX: 1, customY: 0, label: 'Top Right' },
  // Middle row
  { position: 'custom', customX: 0.02, customY: 0.5, label: 'Middle Left' },
  { position: 'custom', customX: 0.5, customY: 0.5, label: 'Center' },
  { position: 'custom', customX: 0.98, customY: 0.5, label: 'Middle Right' },
  // Bottom row
  { position: 'bottomLeft', customX: 0, customY: 1, label: 'Bottom Left' },
  { position: 'custom', customX: 0.5, customY: 0.98, label: 'Bottom Center' },
  { position: 'bottomRight', customX: 1, customY: 1, label: 'Bottom Right' },
];

function PositionGrid({ position, customX, customY, onChange }: PositionGridProps) {
  // Determine which grid cell is active
  const getActiveIndex = () => {
    // Check corner presets first
    if (position === 'topLeft') return 0;
    if (position === 'topRight') return 2;
    if (position === 'bottomLeft') return 6;
    if (position === 'bottomRight') return 8;

    // For custom, find closest grid position
    if (position === 'custom') {
      // Top center
      if (customY < 0.25 && customX > 0.25 && customX < 0.75) return 1;
      // Middle left
      if (customX < 0.25 && customY > 0.25 && customY < 0.75) return 3;
      // Center
      if (customX > 0.25 && customX < 0.75 && customY > 0.25 && customY < 0.75) return 4;
      // Middle right
      if (customX > 0.75 && customY > 0.25 && customY < 0.75) return 5;
      // Bottom center
      if (customY > 0.75 && customX > 0.25 && customX < 0.75) return 7;
    }

    return -1; // No match
  };

  const activeIndex = getActiveIndex();

  return (
    <div className="w-full p-3 rounded-lg border border-zinc-700 bg-zinc-800/50 flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex justify-between">
          {[0, 1, 2].map((col) => {
            const index = row * 3 + col;
            const pos = GRID_POSITIONS[index];
            return (
              <button
                key={index}
                type="button"
                title={pos.label}
                onClick={() => onChange(pos.position, pos.customX, pos.customY)}
                className={`w-6 h-6 rounded transition-colors ${
                  activeIndex === index
                    ? 'bg-indigo-500'
                    : 'bg-zinc-700 hover:bg-zinc-600'
                }`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

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
    updateWebcamConfig,
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

                  {/* Webcam Settings Section */}
                  {project.sources.webcamVideo && (
                    <div className="pt-4 border-t border-zinc-800 space-y-4">
                      <label className="text-[11px] text-zinc-500 uppercase tracking-wide">Webcam Settings</label>

                      {/* Size Slider */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-zinc-400">Size</span>
                          <span className="text-xs text-zinc-300 font-mono">
                            {Math.round(project.webcam.size * 100)}%
                          </span>
                        </div>
                        <Slider
                          value={[project.webcam.size * 100]}
                          onValueChange={(values) => {
                            updateWebcamConfig({ size: values[0] / 100 });
                          }}
                          min={10}
                          max={50}
                          step={1}
                        />
                      </div>

                      {/* Shape Toggle */}
                      <div>
                        <span className="text-xs text-zinc-400 block mb-2">Shape</span>
                        <ToggleGroup
                          type="single"
                          value={project.webcam.shape}
                          onValueChange={(value) => {
                            if (value) {
                              updateWebcamConfig({ shape: value as WebcamOverlayShape });
                            }
                          }}
                          className="justify-start"
                        >
                          <ToggleGroupItem
                            value="circle"
                            aria-label="Circle"
                            className="h-8 w-8 p-0 data-[state=on]:bg-zinc-700"
                          >
                            <Circle className="h-4 w-4" />
                          </ToggleGroupItem>
                          <ToggleGroupItem
                            value="roundedRectangle"
                            aria-label="Squircle"
                            className="h-8 w-8 p-0 data-[state=on]:bg-zinc-700"
                          >
                            <Square className="h-4 w-4" />
                          </ToggleGroupItem>
                          <ToggleGroupItem
                            value="rectangle"
                            aria-label="Rectangle"
                            className="h-8 w-8 p-0 data-[state=on]:bg-zinc-700"
                          >
                            <RectangleHorizontal className="h-4 w-4" />
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>

                      {/* Position Grid */}
                      <div>
                        <span className="text-xs text-zinc-400 block mb-2">Position</span>
                        <PositionGrid
                          position={project.webcam.position}
                          customX={project.webcam.customX}
                          customY={project.webcam.customY}
                          onChange={(pos, x, y) => {
                            updateWebcamConfig({ position: pos, customX: x, customY: y });
                          }}
                        />
                      </div>
                    </div>
                  )}
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
