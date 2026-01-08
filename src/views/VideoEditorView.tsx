/**
 * VideoEditorView Component
 *
 * Main view for editing video recordings with features like:
 * - Auto-zoom to clicks
 * - Cursor highlighting
 * - Webcam overlay toggling
 * - Timeline-based editing
 */

import { useCallback, forwardRef, useImperativeHandle, useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { X, Circle, Square, RectangleHorizontal, Crop } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useCaptureStore } from '../stores/captureStore';
import { useVideoEditorStore } from '../stores/videoEditorStore';
import { useVideoEditorShortcuts } from '../hooks/useVideoEditorShortcuts';
import { GPUVideoPreview } from '../components/VideoEditor/GPUVideoPreview';
import { VideoTimeline } from '../components/VideoEditor/VideoTimeline';
import { CropDialog } from '../components/VideoEditor/CropDialog';
import { Button } from '../components/ui/button';
import { Slider } from '../components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import type { ExportProgress, WebcamOverlayShape, WebcamOverlayPosition, AspectRatio, ExportPreset, VideoBackgroundType, SceneMode, ZoomRegion, CropConfig } from '../types';
import { videoEditorLogger } from '../utils/logger';

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
    <div className="w-full p-3 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-surface-dark)] flex flex-col gap-2">
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
                    ? 'bg-[var(--coral-400)]'
                    : 'bg-[var(--polar-frost)] hover:bg-[var(--polar-steel)]'
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
 * ZoomRegionConfig - Configuration panel for zoom regions following Cap's UI pattern.
 * Shows video thumbnail with draggable focus point in manual mode.
 */
interface ZoomRegionConfigProps {
  region: ZoomRegion;
  videoSrc: string;
  canUseAuto: boolean;
  onUpdate: (updates: Partial<ZoomRegion>) => void;
  onDelete: () => void;
  onDone: () => void;
}

function ZoomRegionConfig({ region, videoSrc, canUseAuto, onUpdate, onDelete, onDone }: ZoomRegionConfigProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load video frame at the region's start time
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.src = convertFileSrc(videoSrc);
    video.preload = 'auto';

    const handleLoadedData = () => {
      // Seek to the region's start time
      video.currentTime = region.startMs / 1000;
    };

    const handleSeeked = () => {
      // Draw frame to canvas
      const canvas = canvasRef.current;
      if (!canvas || !video) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      setIsLoaded(true);
    };

    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('seeked', handleSeeked);
    video.load();

    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [videoSrc, region.startMs]);

  // Handle position drag on the thumbnail
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();

    const updatePosition = (clientX: number, clientY: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onUpdate({ targetX: x, targetY: y });
    };

    updatePosition(e.clientX, e.clientY);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updatePosition(moveEvent.clientX, moveEvent.clientY);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  if (!region) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onDone}
            className="h-7 px-2.5 bg-[var(--coral-100)] hover:bg-[var(--coral-200)] text-[var(--coral-400)] text-xs font-medium rounded-md transition-colors"
          >
            Done
          </button>
          <span className="text-xs text-[var(--ink-subtle)]">Zoom region</span>
        </div>
        <button
          onClick={onDelete}
          className="h-7 px-2.5 bg-[var(--error-light)] hover:bg-[rgba(239,68,68,0.2)] text-[var(--error)] text-xs rounded-md transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Zoom Amount */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[var(--ink-muted)]">Zoom</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{region.scale.toFixed(1)}x</span>
        </div>
        <Slider
          value={[region.scale]}
          min={1}
          max={4}
          step={0.1}
          onValueChange={(values) => onUpdate({ scale: values[0] })}
        />
      </div>

      {/* Zoom Mode Toggle */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Zoom Mode</span>
        <div className="relative flex rounded-lg border border-[var(--glass-border)] overflow-hidden">
          {/* Sliding indicator */}
          <div
            className="absolute top-0 bottom-0 w-1/2 bg-[var(--polar-frost)] transition-transform duration-200"
            style={{ transform: region.mode === 'auto' ? 'translateX(0)' : 'translateX(100%)' }}
          />
          <button
            onClick={() => canUseAuto && onUpdate({ mode: 'auto' })}
            disabled={!canUseAuto}
            className={`relative z-10 flex-1 py-2 text-xs font-medium transition-colors ${
              region.mode === 'auto'
                ? 'text-[var(--ink-black)]'
                : canUseAuto
                  ? 'text-[var(--ink-subtle)] hover:text-[var(--ink-dark)]'
                  : 'text-[var(--ink-faint)] cursor-not-allowed'
            }`}
          >
            Auto
          </button>
          <button
            onClick={() => onUpdate({ mode: 'manual' })}
            className={`relative z-10 flex-1 py-2 text-xs font-medium transition-colors ${
              region.mode !== 'auto'
                ? 'text-[var(--ink-black)]'
                : 'text-[var(--ink-subtle)] hover:text-[var(--ink-dark)]'
            }`}
          >
            Manual
          </button>
        </div>
        {!canUseAuto && (
          <p className="text-[10px] text-[var(--ink-faint)] mt-1">
            No cursor data for auto mode
          </p>
        )}
      </div>

      {/* Manual Mode: Video thumbnail with focus picker */}
      {region.mode !== 'auto' && (
        <div
          className="relative w-full cursor-crosshair"
          onMouseDown={handleMouseDown}
        >
          {/* Focus indicator circle */}
          <div
            className="absolute z-20 w-6 h-6 rounded-full border-2 border-[var(--ink-dark)] -translate-x-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center bg-[var(--glass-bg)]"
            style={{
              left: `${region.targetX * 100}%`,
              top: `${region.targetY * 100}%`,
            }}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--ink-dark)]" />
          </div>

          {/* Video thumbnail canvas */}
          <div className="overflow-hidden rounded-lg border border-[var(--glass-border)] bg-[var(--polar-mist)]">
            <canvas
              ref={canvasRef}
              className={`w-full h-auto transition-opacity duration-200 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
            {!isLoaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--polar-mist)]">
                <span className="text-xs text-[var(--ink-subtle)]">Loading preview...</span>
              </div>
            )}
          </div>

          {/* Hidden video element for frame extraction */}
          <video ref={videoRef} className="hidden" />
        </div>
      )}
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
    isExporting,
    exportProgress,
    exportVideo,
    setExportProgress,
    cancelExport,
    updateWebcamConfig,
    updateExportConfig,
    updateCursorConfig,
    splitMode,
    setSplitMode,
    splitZoomRegionAtPlayhead,
    deleteSelectedZoomRegion,
    selectZoomRegion,
    timelineZoom,
    setTimelineZoom,
    // Zoom region
    selectedZoomRegionId,
    updateZoomRegion,
    deleteZoomRegion,
    // Scene segment
    selectedSceneSegmentId,
    selectSceneSegment,
    updateSceneSegment,
    deleteSceneSegment,
    // Save
    saveProject,
    isSaving,
  } = useVideoEditorStore();

  // Properties panel tab state
  type PropertiesTab = 'project' | 'cursor' | 'webcam' | 'export';
  const [activeTab, setActiveTab] = useState<PropertiesTab>('project');

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
      selectZoomRegion(null);
    }
  }, [splitMode, setSplitMode, selectZoomRegion]);

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
    onDeleteSelected: deleteSelectedZoomRegion,
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

      // Start export (store handles format inference from file extension)
      const result = await exportVideo(outputPath);

      // Show success toast with file info
      const sizeMB = (result.fileSizeBytes / (1024 * 1024)).toFixed(1);
      toast.success(`Exported successfully`, {
        description: `${sizeMB} MB • ${result.format.toUpperCase()}`,
      });
    } catch (error) {
      videoEditorLogger.error('Export failed:', error);
      const message = error instanceof Error ? error.message : 'Export failed';
      toast.error(message);
    }
  }, [project, exportVideo]);

  // Handle crop apply
  const handleCropApply = useCallback((crop: CropConfig) => {
    updateExportConfig({ crop });
    toast.success(crop.enabled ? 'Crop applied' : 'Crop removed');
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
        {/* Video Preview */}
        <div className="flex-1 flex flex-col min-w-0 p-4">
          <GPUVideoPreview />
        </div>

        {/* Right sidebar with tabbed properties panel */}
        <div className="w-72 compositor-sidebar flex flex-col">
          {/* Tab Bar */}
          <div className="flex border-b border-[var(--glass-border)]">
            <button
              onClick={() => setActiveTab('project')}
              className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                activeTab === 'project'
                  ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
              }`}
            >
              Project
            </button>
            {project?.sources.cursorData && (
              <button
                onClick={() => setActiveTab('cursor')}
                className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                  activeTab === 'cursor'
                    ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
                    : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
                }`}
              >
                Cursor
              </button>
            )}
            {project?.sources.webcamVideo && (
              <button
                onClick={() => setActiveTab('webcam')}
                className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                  activeTab === 'webcam'
                    ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
                    : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
                }`}
              >
                Webcam
              </button>
            )}
            <button
              onClick={() => setActiveTab('export')}
              className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                activeTab === 'export'
                  ? 'text-[var(--ink-black)] border-b-2 border-[var(--coral-400)] bg-[var(--coral-50)]'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--glass-highlight)]'
              }`}
            >
              Export
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto relative">
            {/* Selection Overlay (shown when zoom region or scene segment is selected) */}
            {(selectedZoomRegionId || selectedSceneSegmentId) && project && (
              <div className="absolute inset-0 p-4 bg-[var(--glass-surface-dark)] z-10 animate-in slide-in-from-bottom-2 fade-in duration-200 overflow-y-auto">
                {/* Zoom Region Properties */}
                {selectedZoomRegionId && project.zoom.regions.find(r => r.id === selectedZoomRegionId) && (
                  <ZoomRegionConfig
                    region={project.zoom.regions.find(r => r.id === selectedZoomRegionId)!}
                    videoSrc={project.sources.screenVideo}
                    canUseAuto={project.sources.cursorData != null}
                    onUpdate={(updates) => updateZoomRegion(selectedZoomRegionId, updates)}
                    onDelete={() => {
                      deleteZoomRegion(selectedZoomRegionId);
                      selectZoomRegion(null);
                    }}
                    onDone={() => selectZoomRegion(null)}
                  />
                )}

                {/* Scene Segment Properties */}
                {selectedSceneSegmentId && (() => {
                  const segment = project.scene.segments.find(s => s.id === selectedSceneSegmentId);
                  if (!segment) return null;
                  return (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => selectSceneSegment(null)}
                            className="h-7 px-2.5 bg-[var(--coral-100)] hover:bg-[var(--coral-200)] text-[var(--coral-400)] text-xs font-medium rounded-md transition-colors"
                          >
                            Done
                          </button>
                          <span className="text-xs text-[var(--ink-subtle)]">Scene segment</span>
                        </div>
                        <button
                          onClick={() => {
                            deleteSceneSegment(selectedSceneSegmentId);
                            selectSceneSegment(null);
                          }}
                          className="h-7 px-2.5 bg-[var(--error-light)] hover:bg-[rgba(239,68,68,0.2)] text-[var(--error)] text-xs rounded-md transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                      <div className="space-y-3 pt-2">
                        <div>
                          <span className="text-xs text-[var(--ink-muted)] block mb-2">Mode</span>
                          <select
                            value={segment.mode}
                            onChange={(e) => updateSceneSegment(selectedSceneSegmentId, { mode: e.target.value as SceneMode })}
                            className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
                          >
                            <option value="default">Screen + Webcam</option>
                            <option value="cameraOnly">Camera Only</option>
                            <option value="screenOnly">Screen Only</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Project Tab */}
            {activeTab === 'project' && (
              <div className="p-4 space-y-4">
                <div>
                  <label className="text-[11px] text-[var(--ink-subtle)] uppercase tracking-wide">Project</label>
                  <p className="text-sm text-[var(--ink-dark)] mt-1 truncate">
                    {project?.name ?? 'No project loaded'}
                  </p>
                </div>

                {project && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Resolution</label>
                        <p className="text-xs text-[var(--ink-dark)] font-mono mt-0.5">
                          {project.sources.originalWidth}×{project.sources.originalHeight}
                        </p>
                      </div>
                      <div>
                        <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Frame Rate</label>
                        <p className="text-xs text-[var(--ink-dark)] font-mono mt-0.5">
                          {project.sources.fps} fps
                        </p>
                      </div>
                      <div>
                        <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Duration</label>
                        <p className="text-xs text-[var(--ink-dark)] font-mono mt-0.5">
                          {Math.floor(project.timeline.durationMs / 60000)}:{String(Math.floor((project.timeline.durationMs % 60000) / 1000)).padStart(2, '0')}
                        </p>
                      </div>
                      <div>
                        <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Zoom Regions</label>
                        <p className="text-xs text-[var(--ink-dark)] mt-0.5">
                          {project.zoom.regions.length}
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Cursor Tab */}
            {activeTab === 'cursor' && project?.sources.cursorData && (
              <div className="p-4 space-y-4">
                {/* Show/Hide Toggle */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Show Cursor</span>
                  <button
                    onClick={() => updateCursorConfig({ visible: !project.cursor.visible })}
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      project.cursor.visible ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        project.cursor.visible ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Cursor Type */}
                <div>
                  <span className="text-[11px] text-[var(--ink-subtle)] block mb-2">Cursor Type</span>
                  <ToggleGroup
                    type="single"
                    value={project.cursor.cursorType}
                    onValueChange={(value) => {
                      if (value) updateCursorConfig({ cursorType: value as 'auto' | 'circle' });
                    }}
                    className="justify-start"
                  >
                    <ToggleGroupItem value="auto" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                      Auto
                    </ToggleGroupItem>
                    <ToggleGroupItem value="circle" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                      Circle
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {/* Size Slider */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--ink-muted)]">Size</span>
                    <span className="text-xs text-[var(--ink-dark)] font-mono">
                      {Math.round(project.cursor.scale * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[project.cursor.scale * 100]}
                    onValueChange={(values) => updateCursorConfig({ scale: values[0] / 100 })}
                    min={50}
                    max={300}
                    step={10}
                  />
                </div>

                {/* Hide When Idle */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Hide When Idle</span>
                  <button
                    onClick={() => updateCursorConfig({ hideWhenIdle: !project.cursor.hideWhenIdle })}
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      project.cursor.hideWhenIdle ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        project.cursor.hideWhenIdle ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Idle Timeout (only when hideWhenIdle is enabled) */}
                {project.cursor.hideWhenIdle && (
                  <div className="pl-3 border-l border-[var(--glass-border)]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] text-[var(--ink-subtle)]">Inactivity Delay</span>
                      <span className="text-[11px] text-[var(--ink-muted)] font-mono">
                        {(project.cursor.idleTimeoutMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                    <Slider
                      value={[project.cursor.idleTimeoutMs]}
                      onValueChange={(values) => updateCursorConfig({ idleTimeoutMs: values[0] })}
                      min={500}
                      max={5000}
                      step={100}
                    />
                  </div>
                )}

                {/* Smooth Movement */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Smooth Movement</span>
                  <button
                    onClick={() => updateCursorConfig({ smoothMovement: !project.cursor.smoothMovement })}
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      project.cursor.smoothMovement ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        project.cursor.smoothMovement ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Animation Style (only when smoothMovement is enabled) */}
                {project.cursor.smoothMovement && (
                  <div className="pl-3 border-l border-[var(--glass-border)] space-y-3">
                    <div>
                      <span className="text-[11px] text-[var(--ink-subtle)] block mb-2">Animation Style</span>
                      <ToggleGroup
                        type="single"
                        value={project.cursor.animationStyle}
                        onValueChange={(value) => {
                          if (value) {
                            const style = value as 'slow' | 'mellow' | 'fast' | 'custom';
                            // Apply preset values when selecting a non-custom style
                            const presets: Record<string, { tension: number; mass: number; friction: number }> = {
                              slow: { tension: 65, mass: 1.8, friction: 16 },
                              mellow: { tension: 120, mass: 1.1, friction: 18 },
                              fast: { tension: 200, mass: 0.8, friction: 20 },
                            };
                            if (style !== 'custom' && presets[style]) {
                              updateCursorConfig({ animationStyle: style, ...presets[style] });
                            } else {
                              updateCursorConfig({ animationStyle: style });
                            }
                          }
                        }}
                        className="justify-start flex-wrap gap-1"
                      >
                        <ToggleGroupItem value="slow" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                          Slow
                        </ToggleGroupItem>
                        <ToggleGroupItem value="mellow" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                          Mellow
                        </ToggleGroupItem>
                        <ToggleGroupItem value="fast" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                          Fast
                        </ToggleGroupItem>
                        <ToggleGroupItem value="custom" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                          Custom
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </div>

                    {/* Physics Controls (only when Custom style is selected) */}
                    {project.cursor.animationStyle === 'custom' && (
                      <div className="space-y-3 pt-2">
                        {/* Tension */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] text-[var(--ink-subtle)]">Tension</span>
                            <span className="text-[11px] text-[var(--ink-muted)] font-mono">{Math.round(project.cursor.tension)}</span>
                          </div>
                          <Slider
                            value={[project.cursor.tension]}
                            onValueChange={(values) => updateCursorConfig({ tension: values[0] })}
                            min={1}
                            max={500}
                            step={5}
                          />
                        </div>

                        {/* Mass */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] text-[var(--ink-subtle)]">Mass</span>
                            <span className="text-[11px] text-[var(--ink-muted)] font-mono">{project.cursor.mass.toFixed(1)}</span>
                          </div>
                          <Slider
                            value={[project.cursor.mass * 10]}
                            onValueChange={(values) => updateCursorConfig({ mass: values[0] / 10 })}
                            min={1}
                            max={100}
                            step={1}
                          />
                        </div>

                        {/* Friction */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] text-[var(--ink-subtle)]">Friction</span>
                            <span className="text-[11px] text-[var(--ink-muted)] font-mono">{Math.round(project.cursor.friction)}</span>
                          </div>
                          <Slider
                            value={[project.cursor.friction]}
                            onValueChange={(values) => updateCursorConfig({ friction: values[0] })}
                            min={0}
                            max={50}
                            step={1}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Motion Blur */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--ink-muted)]">Motion Blur</span>
                    <span className="text-xs text-[var(--ink-dark)] font-mono">
                      {Math.round(project.cursor.motionBlur * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[project.cursor.motionBlur * 100]}
                    onValueChange={(values) => updateCursorConfig({ motionBlur: values[0] / 100 })}
                    min={0}
                    max={100}
                    step={5}
                  />
                </div>

                {/* Click Highlight Section */}
                <div className="pt-3 border-t border-[var(--glass-border)]">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-[var(--ink-muted)]">Click Highlight</span>
                    <button
                      onClick={() => updateCursorConfig({
                        clickHighlight: { ...project.cursor.clickHighlight, enabled: !project.cursor.clickHighlight.enabled }
                      })}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        project.cursor.clickHighlight.enabled ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                          project.cursor.clickHighlight.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {project.cursor.clickHighlight.enabled && (
                    <div className="space-y-3">
                      {/* Highlight Style */}
                      <div>
                        <span className="text-[11px] text-[var(--ink-subtle)] block mb-2">Style</span>
                        <ToggleGroup
                          type="single"
                          value={project.cursor.clickHighlight.style}
                          onValueChange={(value) => {
                            if (value) updateCursorConfig({
                              clickHighlight: { ...project.cursor.clickHighlight, style: value as 'ripple' | 'spotlight' | 'ring' }
                            });
                          }}
                          className="justify-start"
                        >
                          <ToggleGroupItem value="ripple" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                            Ripple
                          </ToggleGroupItem>
                          <ToggleGroupItem value="spotlight" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                            Spotlight
                          </ToggleGroupItem>
                          <ToggleGroupItem value="ring" className="text-xs h-7 px-2.5 data-[state=on]:bg-[var(--polar-frost)]">
                            Ring
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>

                      {/* Highlight Color */}
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Color</span>
                        <input
                          type="color"
                          value={project.cursor.clickHighlight.color}
                          onChange={(e) => updateCursorConfig({
                            clickHighlight: { ...project.cursor.clickHighlight, color: e.target.value }
                          })}
                          className="w-8 h-6 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
                        />
                      </div>

                      {/* Highlight Radius */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] text-[var(--ink-subtle)]">Radius</span>
                          <span className="text-[11px] text-[var(--ink-muted)] font-mono">{project.cursor.clickHighlight.radius}px</span>
                        </div>
                        <Slider
                          value={[project.cursor.clickHighlight.radius]}
                          onValueChange={(values) => updateCursorConfig({
                            clickHighlight: { ...project.cursor.clickHighlight, radius: values[0] }
                          })}
                          min={10}
                          max={100}
                          step={5}
                        />
                      </div>

                      {/* Highlight Duration */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] text-[var(--ink-subtle)]">Duration</span>
                          <span className="text-[11px] text-[var(--ink-muted)] font-mono">{project.cursor.clickHighlight.durationMs}ms</span>
                        </div>
                        <Slider
                          value={[project.cursor.clickHighlight.durationMs]}
                          onValueChange={(values) => updateCursorConfig({
                            clickHighlight: { ...project.cursor.clickHighlight, durationMs: values[0] }
                          })}
                          min={100}
                          max={1000}
                          step={50}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Webcam Tab */}
            {activeTab === 'webcam' && project?.sources.webcamVideo && (
              <div className="p-4 space-y-4">
                {/* Show/Hide Toggle */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--ink-muted)]">Show Overlay</span>
                  <button
                    onClick={() => updateWebcamConfig({ enabled: !project.webcam.enabled })}
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      project.webcam.enabled ? 'bg-[var(--coral-400)]' : 'bg-[var(--polar-frost)]'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        project.webcam.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Size Slider */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--ink-muted)]">Size</span>
                    <span className="text-xs text-[var(--ink-dark)] font-mono">
                      {Math.round(project.webcam.size * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[project.webcam.size * 100]}
                    onValueChange={(values) => updateWebcamConfig({ size: values[0] / 100 })}
                    min={10}
                    max={50}
                    step={1}
                  />
                </div>

                {/* Shape Toggle */}
                <div>
                  <span className="text-xs text-[var(--ink-muted)] block mb-2">Shape</span>
                  <ToggleGroup
                    type="single"
                    value={project.webcam.shape}
                    onValueChange={(value) => {
                      if (value) updateWebcamConfig({ shape: value as WebcamOverlayShape });
                    }}
                    className="justify-start"
                  >
                    <ToggleGroupItem value="circle" aria-label="Circle" className="h-8 w-8 p-0 data-[state=on]:bg-[var(--polar-frost)]">
                      <Circle className="h-4 w-4" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="roundedRectangle" aria-label="Squircle" className="h-8 w-8 p-0 data-[state=on]:bg-[var(--polar-frost)]">
                      <Square className="h-4 w-4" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="rectangle" aria-label="Rectangle" className="h-8 w-8 p-0 data-[state=on]:bg-[var(--polar-frost)]">
                      <RectangleHorizontal className="h-4 w-4" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {/* Rounding (only for roundedRectangle) */}
                {project.webcam.shape === 'roundedRectangle' && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-[var(--ink-muted)]">Rounding</span>
                      <span className="text-xs text-[var(--ink-subtle)]">{Math.round(project.webcam.rounding)}%</span>
                    </div>
                    <Slider
                      value={[project.webcam.rounding]}
                      onValueChange={(values) => updateWebcamConfig({ rounding: values[0] })}
                      min={0}
                      max={100}
                      step={1}
                      className="w-full"
                    />
                  </div>
                )}

                {/* Shadow */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--ink-muted)]">Shadow</span>
                    <span className="text-xs text-[var(--ink-subtle)]">{Math.round(project.webcam.shadow)}%</span>
                  </div>
                  <Slider
                    value={[project.webcam.shadow]}
                    onValueChange={(values) => updateWebcamConfig({ shadow: values[0] })}
                    min={0}
                    max={100}
                    step={1}
                    className="w-full"
                  />
                </div>

                {/* Advanced Shadow Settings (only when shadow > 0) */}
                {project.webcam.shadow > 0 && (
                  <div className="pl-3 border-l border-[var(--glass-border)] space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Size</span>
                        <span className="text-[11px] text-[var(--ink-faint)]">{Math.round(project.webcam.shadowConfig.size)}%</span>
                      </div>
                      <Slider
                        value={[project.webcam.shadowConfig.size]}
                        onValueChange={(values) => updateWebcamConfig({ 
                          shadowConfig: { ...project.webcam.shadowConfig, size: values[0] } 
                        })}
                        min={0}
                        max={100}
                        step={1}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Opacity</span>
                        <span className="text-[11px] text-[var(--ink-faint)]">{Math.round(project.webcam.shadowConfig.opacity)}%</span>
                      </div>
                      <Slider
                        value={[project.webcam.shadowConfig.opacity]}
                        onValueChange={(values) => updateWebcamConfig({ 
                          shadowConfig: { ...project.webcam.shadowConfig, opacity: values[0] } 
                        })}
                        min={0}
                        max={100}
                        step={1}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-[var(--ink-subtle)]">Blur</span>
                        <span className="text-[11px] text-[var(--ink-faint)]">{Math.round(project.webcam.shadowConfig.blur)}%</span>
                      </div>
                      <Slider
                        value={[project.webcam.shadowConfig.blur]}
                        onValueChange={(values) => updateWebcamConfig({ 
                          shadowConfig: { ...project.webcam.shadowConfig, blur: values[0] } 
                        })}
                        min={0}
                        max={100}
                        step={1}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}

                {/* Position Grid */}
                <div>
                  <span className="text-xs text-[var(--ink-muted)] block mb-2">Position</span>
                  <PositionGrid
                    position={project.webcam.position}
                    customX={project.webcam.customX}
                    customY={project.webcam.customY}
                    onChange={(pos, x, y) => updateWebcamConfig({ position: pos, customX: x, customY: y })}
                  />
                </div>

                {/* Segments count */}
                <div className="pt-3 border-t border-[var(--glass-border)]">
                  <label className="text-[10px] text-[var(--ink-subtle)] uppercase">Visibility Segments</label>
                  <p className="text-xs text-[var(--ink-dark)] mt-0.5">
                    {project.webcam.visibilitySegments.length} segment{project.webcam.visibilitySegments.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
            )}

            {/* Export Tab */}
            {activeTab === 'export' && project && (
              <div className="p-4 space-y-4">
                {/* Export Preset */}
                <div>
                  <span className="text-xs text-[var(--ink-muted)] block mb-2">Preset</span>
                  <select
                    value={project.export.preset}
                    onChange={(e) => updateExportConfig({ preset: e.target.value as ExportPreset })}
                    className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
                  >
                    <option value="draft">Draft (720p, 15fps)</option>
                    <option value="standard">Standard (1080p, 30fps)</option>
                    <option value="highQuality">High Quality (1080p, 60fps)</option>
                    <option value="maximum">Maximum (Source)</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>

                {/* Aspect Ratio */}
                <div>
                  <span className="text-xs text-[var(--ink-muted)] block mb-2">Aspect Ratio</span>
                  <select
                    value={project.export.aspectRatio}
                    onChange={(e) => updateExportConfig({ aspectRatio: e.target.value as AspectRatio })}
                    className="w-full h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
                  >
                    <option value="auto">Auto (Source)</option>
                    <option value="landscape16x9">16:9 Landscape</option>
                    <option value="portrait9x16">9:16 Portrait</option>
                    <option value="square1x1">1:1 Square</option>
                    <option value="standard4x3">4:3 Standard</option>
                  </select>
                </div>

                {/* Background (for letterboxing) */}
                {project.export.aspectRatio !== 'auto' && (
                  <div>
                    <span className="text-xs text-[var(--ink-muted)] block mb-2">Background</span>
                    <div className="flex items-center gap-2">
                      <select
                        value={project.export.background.bgType}
                        onChange={(e) => updateExportConfig({
                          background: { ...project.export.background, bgType: e.target.value as VideoBackgroundType }
                        })}
                        className="flex-1 h-8 bg-[var(--polar-mist)] border border-[var(--glass-border)] rounded-md text-sm text-[var(--ink-dark)] px-2"
                      >
                        <option value="solid">Solid</option>
                        <option value="gradient">Gradient</option>
                      </select>
                      {project.export.background.bgType === 'solid' && (
                        <input
                          type="color"
                          value={project.export.background.solidColor}
                          onChange={(e) => updateExportConfig({
                            background: { ...project.export.background, solidColor: e.target.value }
                          })}
                          className="w-8 h-8 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
                        />
                      )}
                    </div>
                    {project.export.background.bgType === 'gradient' && (
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="color"
                          value={project.export.background.gradientStart}
                          onChange={(e) => updateExportConfig({
                            background: { ...project.export.background, gradientStart: e.target.value }
                          })}
                          className="w-8 h-8 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
                        />
                        <div className="flex-1 h-4 rounded" style={{
                          background: `linear-gradient(90deg, ${project.export.background.gradientStart}, ${project.export.background.gradientEnd})`
                        }} />
                        <input
                          type="color"
                          value={project.export.background.gradientEnd}
                          onChange={(e) => updateExportConfig({
                            background: { ...project.export.background, gradientEnd: e.target.value }
                          })}
                          className="w-8 h-8 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Crop Video */}
                <div className="pt-3 border-t border-[var(--glass-border)]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--ink-muted)]">Crop Video</span>
                    {project.export.crop?.enabled && (
                      <span className="text-[10px] text-[var(--coral-400)] font-medium">
                        {project.export.crop.width}×{project.export.crop.height}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsCropDialogOpen(true)}
                    className="w-full justify-start gap-2"
                  >
                    <Crop className="w-4 h-4" />
                    {project.export.crop?.enabled ? 'Edit Crop' : 'Add Crop'}
                  </Button>
                  {project.export.crop?.enabled && (
                    <p className="text-[10px] text-[var(--ink-subtle)] mt-1.5">
                      Position: {project.export.crop.x}, {project.export.crop.y}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Timeline with integrated controls */}
      <div className="min-h-[14rem]">
        <VideoTimeline onBack={handleBack} onExport={handleExport} />
      </div>

      {/* Crop Dialog */}
      {project && (
        <CropDialog
          open={isCropDialogOpen}
          onClose={() => setIsCropDialogOpen(false)}
          onApply={handleCropApply}
          videoWidth={project.sources.originalWidth}
          videoHeight={project.sources.originalHeight}
          initialCrop={project.export.crop}
        />
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
