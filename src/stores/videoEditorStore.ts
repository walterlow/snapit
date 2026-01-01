import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type {
  AutoZoomConfig,
  VideoProject,
  ZoomRegion,
  VisibilitySegment,
  ExportProgress,
  ExportResult,
  EditorInstanceInfo,
  PlaybackEvent,
  RenderedFrame,
  WebcamConfig,
  ExportConfig,
  SceneSegment,
  TextSegment,
  CursorRecording,
} from '../types';

interface VideoEditorState {
  // Project state
  project: VideoProject | null;
  cursorRecording: CursorRecording | null;
  
  // GPU Editor instance state
  editorInstanceId: string | null;
  editorInfo: EditorInstanceInfo | null;
  isInitializingEditor: boolean;
  
  // Playback state
  currentTimeMs: number;
  currentFrame: number;
  isPlaying: boolean;
  
  // Current rendered frame (GPU-rendered RGBA data)
  renderedFrame: RenderedFrame | null;
  
  // Selection state
  selectedZoomRegionId: string | null;
  selectedWebcamSegmentIndex: number | null;
  selectedSceneSegmentId: string | null;
  selectedTextSegmentId: string | null;
  
  // Timeline interaction state
  isDraggingPlayhead: boolean;
  isDraggingZoomRegion: boolean;
  draggedZoomEdge: 'start' | 'end' | 'move' | null;
  isDraggingSceneSegment: boolean;
  draggedSceneEdge: 'start' | 'end' | 'move' | null;
  previewTimeMs: number | null; // Hover preview time for scrubbing
  hoveredTrack: 'video' | 'zoom' | 'audio' | 'scene' | 'text' | 'webcam' | null; // Which track is hovered
  splitMode: boolean; // Split mode for cutting regions at playhead
  
  // View state
  timelineZoom: number; // pixels per millisecond
  timelineScrollLeft: number;
  
  // Export state
  isExporting: boolean;
  exportProgress: ExportProgress | null;
  
  // Actions
  setProject: (project: VideoProject | null) => void;
  loadCursorData: (cursorDataPath: string) => Promise<void>;
  setCurrentTime: (timeMs: number) => void;
  togglePlayback: () => void;
  setIsPlaying: (playing: boolean) => void;
  
  // GPU Editor actions
  initializeGPUEditor: (project: VideoProject) => Promise<void>;
  destroyGPUEditor: () => Promise<void>;
  handlePlaybackEvent: (event: PlaybackEvent) => void;
  renderFrame: (timestampMs: number) => Promise<RenderedFrame | null>;
  gpuPlay: () => Promise<void>;
  gpuPause: () => Promise<void>;
  gpuSeek: (timestampMs: number) => Promise<void>;
  
  // Zoom region actions
  selectZoomRegion: (id: string | null) => void;
  addZoomRegion: (region: ZoomRegion) => void;
  updateZoomRegion: (id: string, updates: Partial<ZoomRegion>) => void;
  deleteZoomRegion: (id: string) => void;
  
  // Text segment actions
  selectTextSegment: (id: string | null) => void;
  addTextSegment: (segment: TextSegment) => void;
  updateTextSegment: (id: string, updates: Partial<TextSegment>) => void;
  deleteTextSegment: (id: string) => void;

  // Scene segment actions
  selectSceneSegment: (id: string | null) => void;
  addSceneSegment: (segment: SceneSegment) => void;
  updateSceneSegment: (id: string, updates: Partial<SceneSegment>) => void;
  deleteSceneSegment: (id: string) => void;

  // Webcam segment actions
  selectWebcamSegment: (index: number | null) => void;
  addWebcamSegment: (segment: VisibilitySegment) => void;
  updateWebcamSegment: (index: number, updates: Partial<VisibilitySegment>) => void;
  deleteWebcamSegment: (index: number) => void;
  toggleWebcamAtTime: (timeMs: number) => void;

  // Webcam config actions
  updateWebcamConfig: (updates: Partial<WebcamConfig>) => void;

  // Export config actions
  updateExportConfig: (updates: Partial<ExportConfig>) => void;
  
  // Timeline view actions
  setTimelineZoom: (zoom: number) => void;
  setTimelineScrollLeft: (scrollLeft: number) => void;
  
  // Drag state actions
  setDraggingPlayhead: (dragging: boolean) => void;
  setDraggingZoomRegion: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingSceneSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setPreviewTime: (timeMs: number | null) => void;
  setHoveredTrack: (track: VideoEditorState['hoveredTrack']) => void;

  // Split mode actions
  setSplitMode: (enabled: boolean) => void;
  splitZoomRegionAtPlayhead: () => void;
  deleteSelectedZoomRegion: () => void;

  // Editor actions
  clearEditor: () => void;
  
  // Auto-zoom generation
  generateAutoZoom: (config?: AutoZoomConfig) => Promise<void>;
  isGeneratingAutoZoom: boolean;
  
  // Export actions
  exportVideo: (outputPath: string) => Promise<ExportResult>;
  setExportProgress: (progress: ExportProgress | null) => void;
  cancelExport: () => void;
}

const DEFAULT_TIMELINE_ZOOM = 0.05; // 50px per second

export const useVideoEditorStore = create<VideoEditorState>()(
  devtools(
    (set, get) => ({
      // Initial state
      project: null,
      cursorRecording: null,

      // GPU Editor instance state
      editorInstanceId: null,
      editorInfo: null,
      isInitializingEditor: false,
      
      // Playback state
      currentTimeMs: 0,
      currentFrame: 0,
      isPlaying: false,
      
      // Current rendered frame
      renderedFrame: null,
      
      selectedZoomRegionId: null,
      selectedWebcamSegmentIndex: null,
      selectedSceneSegmentId: null,
      selectedTextSegmentId: null,
      isDraggingPlayhead: false,
      isDraggingZoomRegion: false,
      draggedZoomEdge: null,
      isDraggingSceneSegment: false,
      draggedSceneEdge: null,
      previewTimeMs: null,
      hoveredTrack: null,
      splitMode: false,
      timelineZoom: DEFAULT_TIMELINE_ZOOM,
      timelineScrollLeft: 0,
      isGeneratingAutoZoom: false,
      isExporting: false,
      exportProgress: null,

      // Project actions
      setProject: (project) => {
        set({
          project,
          cursorRecording: null, // Reset cursor recording when project changes
          currentTimeMs: 0,
          isPlaying: false,
          selectedZoomRegionId: null,
          selectedWebcamSegmentIndex: null,
        });

        // Auto-load cursor data if available
        if (project?.sources.cursorData) {
          get().loadCursorData(project.sources.cursorData);
        }
      },

      loadCursorData: async (cursorDataPath: string) => {
        try {
          const recording = await invoke<CursorRecording>('load_cursor_recording_cmd', {
            path: cursorDataPath,
          });
          set({ cursorRecording: recording });
          console.log('[CURSOR] Loaded cursor recording with', recording.events.length, 'events');
        } catch (error) {
          console.warn('[CURSOR] Failed to load cursor recording:', error);
          // Don't fail - cursor data is optional for auto zoom
        }
      },

      // Playback actions
      setCurrentTime: (timeMs) => {
        const { project } = get();
        if (!project) return;
        
        // Clamp to valid range
        const clampedTime = Math.max(0, Math.min(timeMs, project.timeline.durationMs));
        set({ currentTimeMs: clampedTime });
      },

      togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),
      
      setIsPlaying: (playing) => set({ isPlaying: playing }),

      // Zoom region actions
      selectZoomRegion: (id) => set({ selectedZoomRegionId: id }),

      addZoomRegion: (region) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            zoom: {
              ...project.zoom,
              regions: [...project.zoom.regions, region],
            },
          },
          selectedZoomRegionId: region.id,
        });
      },

      updateZoomRegion: (id, updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            zoom: {
              ...project.zoom,
              regions: project.zoom.regions.map((r) =>
                r.id === id ? { ...r, ...updates } : r
              ),
            },
          },
        });
      },

      deleteZoomRegion: (id) => {
        const { project, selectedZoomRegionId } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            zoom: {
              ...project.zoom,
              regions: project.zoom.regions.filter((r) => r.id !== id),
            },
          },
          selectedZoomRegionId: selectedZoomRegionId === id ? null : selectedZoomRegionId,
        });
      },



      // Text segment actions
      selectTextSegment: (id) => set({ selectedTextSegmentId: id }),

      addTextSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        const segments = [...project.text.segments, segment];
        segments.sort((a, b) => a.startMs - b.startMs);

        set({
          project: {
            ...project,
            text: {
              ...project.text,
              segments,
            },
          },
          selectedTextSegmentId: segment.id,
        });
      },

      updateTextSegment: (id, updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            text: {
              ...project.text,
              segments: project.text.segments.map((s) =>
                s.id === id ? { ...s, ...updates } : s
              ),
            },
          },
        });
      },

      deleteTextSegment: (id) => {
        const { project, selectedTextSegmentId } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            text: {
              ...project.text,
              segments: project.text.segments.filter((s) => s.id !== id),
            },
          },
          selectedTextSegmentId: selectedTextSegmentId === id ? null : selectedTextSegmentId,
        });
      },

      // Scene segment actions
      selectSceneSegment: (id) => set({ selectedSceneSegmentId: id }),

      addSceneSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        const segments = [...project.scene.segments, segment];
        segments.sort((a, b) => a.startMs - b.startMs);

        set({
          project: {
            ...project,
            scene: {
              ...project.scene,
              segments,
            },
          },
          selectedSceneSegmentId: segment.id,
        });
      },

      updateSceneSegment: (id, updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            scene: {
              ...project.scene,
              segments: project.scene.segments.map((s) =>
                s.id === id ? { ...s, ...updates } : s
              ),
            },
          },
        });
      },

      deleteSceneSegment: (id) => {
        const { project, selectedSceneSegmentId } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            scene: {
              ...project.scene,
              segments: project.scene.segments.filter((s) => s.id !== id),
            },
          },
          selectedSceneSegmentId: selectedSceneSegmentId === id ? null : selectedSceneSegmentId,
        });
      },

      // Webcam segment actions
      selectWebcamSegment: (index) => set({ selectedWebcamSegmentIndex: index }),

      addWebcamSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        const segments = [...project.webcam.visibilitySegments, segment];
        // Sort by start time
        segments.sort((a, b) => a.startMs - b.startMs);

        set({
          project: {
            ...project,
            webcam: {
              ...project.webcam,
              visibilitySegments: segments,
            },
          },
        });
      },

      updateWebcamSegment: (index, updates) => {
        const { project } = get();
        if (!project) return;

        const segments = [...project.webcam.visibilitySegments];
        segments[index] = { ...segments[index], ...updates };

        set({
          project: {
            ...project,
            webcam: {
              ...project.webcam,
              visibilitySegments: segments,
            },
          },
        });
      },

      deleteWebcamSegment: (index) => {
        const { project, selectedWebcamSegmentIndex } = get();
        if (!project) return;

        const segments = project.webcam.visibilitySegments.filter((_, i) => i !== index);

        set({
          project: {
            ...project,
            webcam: {
              ...project.webcam,
              visibilitySegments: segments,
            },
          },
          selectedWebcamSegmentIndex:
            selectedWebcamSegmentIndex === index ? null : selectedWebcamSegmentIndex,
        });
      },

      toggleWebcamAtTime: (timeMs) => {
        const { project } = get();
        if (!project) return;

        const segments = project.webcam.visibilitySegments;
        
        // Find if current time is within a segment
        const segmentIndex = segments.findIndex(
          (s) => timeMs >= s.startMs && timeMs <= s.endMs
        );

        if (segmentIndex >= 0) {
          // Split or remove segment
          const segment = segments[segmentIndex];
          const newSegments = [...segments];
          
          if (timeMs === segment.startMs) {
            // At start, just remove
            newSegments.splice(segmentIndex, 1);
          } else if (timeMs === segment.endMs) {
            // At end, just remove
            newSegments.splice(segmentIndex, 1);
          } else {
            // In middle, split into two
            newSegments.splice(segmentIndex, 1, 
              { ...segment, endMs: timeMs },
              { ...segment, startMs: timeMs }
            );
          }

          set({
            project: {
              ...project,
              webcam: {
                ...project.webcam,
                visibilitySegments: newSegments,
              },
            },
          });
        } else {
          // Add new segment (default 5 seconds)
          const endMs = Math.min(timeMs + 5000, project.timeline.durationMs);
          const newSegment: VisibilitySegment = {
            startMs: timeMs,
            endMs,
            visible: true,
          };

          const newSegments = [...segments, newSegment].sort((a, b) => a.startMs - b.startMs);

          set({
            project: {
              ...project,
              webcam: {
                ...project.webcam,
                visibilitySegments: newSegments,
              },
            },
          });
        }
      },

      // Webcam config actions
      updateWebcamConfig: (updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            webcam: {
              ...project.webcam,
              ...updates,
            },
          },
        });
      },

      // Export config actions
      updateExportConfig: (updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            export: {
              ...project.export,
              ...updates,
            },
          },
        });
      },

      // Timeline view actions
      setTimelineZoom: (zoom) => set({ timelineZoom: Math.max(0.01, Math.min(0.5, zoom)) }),
      
      setTimelineScrollLeft: (scrollLeft) => set({ timelineScrollLeft: scrollLeft }),

      // Drag state actions
      setDraggingPlayhead: (dragging) => set({ isDraggingPlayhead: dragging }),
      setPreviewTime: (timeMs) => set({ previewTimeMs: timeMs }),

      setHoveredTrack: (track) => set({ hoveredTrack: track }),

      setDraggingZoomRegion: (dragging, edge) => set({
        isDraggingZoomRegion: dragging,
        draggedZoomEdge: dragging ? edge ?? null : null,
      }),

      setDraggingSceneSegment: (dragging, edge) => set({
        isDraggingSceneSegment: dragging,
        draggedSceneEdge: dragging ? edge ?? null : null,
      }),

      // Split mode actions
      setSplitMode: (enabled) => set({ splitMode: enabled }),

      splitZoomRegionAtPlayhead: () => {
        const { project, currentTimeMs, selectedZoomRegionId } = get();
        if (!project || !selectedZoomRegionId) return;

        const region = project.zoom.regions.find((r) => r.id === selectedZoomRegionId);
        if (!region) return;

        // Check if playhead is within the region (with some margin)
        const minDuration = 100; // Minimum 100ms per segment
        if (
          currentTimeMs <= region.startMs + minDuration ||
          currentTimeMs >= region.endMs - minDuration
        ) {
          return; // Can't split at edges or if segments would be too small
        }

        // Create two new regions from the split
        const id1 = `zoom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const id2 = `zoom_${Date.now() + 1}_${Math.random().toString(36).substr(2, 9)}`;

        const region1: ZoomRegion = {
          ...region,
          id: id1,
          endMs: currentTimeMs,
        };

        const region2: ZoomRegion = {
          ...region,
          id: id2,
          startMs: currentTimeMs,
        };

        // Replace original with two new regions
        const newRegions = project.zoom.regions
          .filter((r) => r.id !== selectedZoomRegionId)
          .concat([region1, region2])
          .sort((a, b) => a.startMs - b.startMs);

        set({
          project: {
            ...project,
            zoom: {
              ...project.zoom,
              regions: newRegions,
            },
          },
          selectedZoomRegionId: id1, // Select the first part
        });
      },

      deleteSelectedZoomRegion: () => {
        const { project, selectedZoomRegionId } = get();
        if (!project || !selectedZoomRegionId) return;

        set({
          project: {
            ...project,
            zoom: {
              ...project.zoom,
              regions: project.zoom.regions.filter((r) => r.id !== selectedZoomRegionId),
            },
          },
          selectedZoomRegionId: null,
        });
      },

      // GPU Editor actions
      initializeGPUEditor: async (project) => {
        const { editorInstanceId: existingId } = get();
        
        // Clean up existing instance first
        if (existingId) {
          try {
            await invoke('destroy_editor_instance', { instanceId: existingId });
          } catch (e) {
            console.warn('Failed to destroy existing editor instance:', e);
          }
        }
        
        set({ isInitializingEditor: true, editorInstanceId: null, editorInfo: null });
        
        try {
          const info = await invoke<EditorInstanceInfo>('create_editor_instance', { project });
          set({
            editorInstanceId: info.instanceId,
            editorInfo: info,
            isInitializingEditor: false,
            currentFrame: 0,
            currentTimeMs: 0,
          });
        } catch (error) {
          set({ isInitializingEditor: false });
          throw error;
        }
      },

      destroyGPUEditor: async () => {
        const { editorInstanceId } = get();
        if (!editorInstanceId) return;
        
        try {
          await invoke('destroy_editor_instance', { instanceId: editorInstanceId });
        } catch (e) {
          console.warn('Failed to destroy editor instance:', e);
        }
        
        set({
          editorInstanceId: null,
          editorInfo: null,
          renderedFrame: null,
          currentFrame: 0,
        });
      },

      handlePlaybackEvent: (event) => {
        set({
          currentFrame: event.frame,
          currentTimeMs: event.timestampMs,
          isPlaying: event.state === 'playing',
        });
      },

      renderFrame: async (timestampMs) => {
        const { editorInstanceId } = get();
        if (!editorInstanceId) return null;
        
        try {
          const frame = await invoke<RenderedFrame>('editor_render_frame', {
            instanceId: editorInstanceId,
            timestampMs,
          });
          set({ renderedFrame: frame, currentFrame: frame.frame, currentTimeMs: frame.timestampMs });
          return frame;
        } catch (error) {
          console.error('Failed to render frame:', error);
          return null;
        }
      },

      gpuPlay: async () => {
        const { editorInstanceId } = get();
        if (!editorInstanceId) return;
        
        await invoke('editor_play', { instanceId: editorInstanceId });
        set({ isPlaying: true });
      },

      gpuPause: async () => {
        const { editorInstanceId } = get();
        if (!editorInstanceId) return;
        
        await invoke('editor_pause', { instanceId: editorInstanceId });
        set({ isPlaying: false });
      },

      gpuSeek: async (timestampMs) => {
        const { editorInstanceId, project } = get();
        if (!editorInstanceId || !project) return;
        
        // Clamp to valid range
        const clampedTime = Math.max(0, Math.min(timestampMs, project.timeline.durationMs));
        
        await invoke('editor_seek', { instanceId: editorInstanceId, timestampMs: clampedTime });
        set({ currentTimeMs: clampedTime });
      },

      // Editor actions
      clearEditor: () => {
        // Destroy GPU editor if active (fire-and-forget)
        const { editorInstanceId } = get();
        if (editorInstanceId) {
          invoke('destroy_editor_instance', { instanceId: editorInstanceId }).catch(console.warn);
        }
        
        set({
          project: null,
          editorInstanceId: null,
          editorInfo: null,
          isInitializingEditor: false,
          currentTimeMs: 0,
          currentFrame: 0,
          isPlaying: false,
          renderedFrame: null,
          selectedZoomRegionId: null,
          selectedWebcamSegmentIndex: null,
          isDraggingPlayhead: false,
          isDraggingZoomRegion: false,
          draggedZoomEdge: null,
          previewTimeMs: null,
          hoveredTrack: null,
          splitMode: false,
          timelineZoom: DEFAULT_TIMELINE_ZOOM,
          timelineScrollLeft: 0,
          isGeneratingAutoZoom: false,
          isExporting: false,
          exportProgress: null,
        });
      },

      // Auto-zoom generation
      generateAutoZoom: async (config?: AutoZoomConfig) => {
        const { project } = get();
        if (!project) return;
        
        // Check if cursor data exists
        if (!project.sources.cursorData) {
          throw new Error('No cursor data available for this recording. Auto-zoom requires cursor data to be recorded.');
        }
        
        set({ isGeneratingAutoZoom: true });
        
        try {
          const updatedProject = await invoke<VideoProject>('generate_auto_zoom', {
            project,
            config: config ?? null,
          });
          
          set({ 
            project: updatedProject,
            isGeneratingAutoZoom: false,
          });
        } catch (error) {
          set({ isGeneratingAutoZoom: false });
          throw error;
        }
      },

      // Export actions
      exportVideo: async (outputPath: string): Promise<ExportResult> => {
        const { project } = get();
        if (!project) {
          throw new Error('No project loaded');
        }
        
        set({ isExporting: true, exportProgress: null });
        
        try {
          const result = await invoke<ExportResult>('export_video', {
            project,
            outputPath,
          });
          
          set({ isExporting: false, exportProgress: null });
          return result;
        } catch (error) {
          set({ isExporting: false, exportProgress: null });
          throw error;
        }
      },

      setExportProgress: (progress: ExportProgress | null) => {
        set({ exportProgress: progress });
      },

      cancelExport: () => {
        // TODO: Implement cancel via Tauri command when backend supports it
        set({ isExporting: false, exportProgress: null });
      },
    }),
    { name: 'VideoEditorStore', enabled: process.env.NODE_ENV === 'development' }
  )
);

// Utility functions
export function generateZoomRegionId(): string {
  return `zoom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor((ms % 1000) / (1000 / 30)); // Assuming 30fps
  
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

export function formatTimeSimple(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
