import { create, type StoreApi } from 'zustand';
import { devtools } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type {
  AudioTrackSettings,
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
  CursorConfig,
  SceneSegment,
  TextSegment,
  MaskSegment,
  CursorRecording,
} from '../types';
import { STORAGE } from '../constants';
import { videoEditorLogger } from '../utils/logger';

export interface VideoEditorState {
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
  selectedMaskSegmentId: string | null;
  
  // Timeline interaction state
  isDraggingPlayhead: boolean;
  isDraggingZoomRegion: boolean;
  draggedZoomEdge: 'start' | 'end' | 'move' | null;
  isDraggingSceneSegment: boolean;
  draggedSceneEdge: 'start' | 'end' | 'move' | null;
  isDraggingMaskSegment: boolean;
  draggedMaskEdge: 'start' | 'end' | 'move' | null;
  isDraggingTextSegment: boolean;
  draggedTextEdge: 'start' | 'end' | 'move' | null;
  previewTimeMs: number | null; // Hover preview time for scrubbing
  hoveredTrack: 'video' | 'zoom' | 'audio' | 'scene' | 'text' | 'webcam' | 'mask' | null; // Which track is hovered
  splitMode: boolean; // Split mode for cutting regions at playhead
  
  // View state
  trackVisibility: {
    video: boolean;
    text: boolean;
    mask: boolean;
    zoom: boolean;
    scene: boolean;
  };
  timelineZoom: number; // pixels per millisecond
  timelineScrollLeft: number;
  timelineContainerWidth: number; // measured container width for fit-to-window
  
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

  // Mask segment actions
  selectMaskSegment: (id: string | null) => void;
  addMaskSegment: (segment: MaskSegment) => void;
  updateMaskSegment: (id: string, updates: Partial<MaskSegment>) => void;
  deleteMaskSegment: (id: string) => void;

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

  // Cursor config actions
  updateCursorConfig: (updates: Partial<CursorConfig>) => void;

  // Audio config actions
  updateAudioConfig: (updates: Partial<AudioTrackSettings>) => void;

  // Timeline view actions
  setTimelineZoom: (zoom: number) => void;
  setTimelineScrollLeft: (scrollLeft: number) => void;
  setTimelineContainerWidth: (width: number) => void;
  fitTimelineToWindow: () => void;
  toggleTrackVisibility: (track: keyof VideoEditorState['trackVisibility']) => void;
  
  // Drag state actions
  setDraggingPlayhead: (dragging: boolean) => void;
  setDraggingZoomRegion: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingSceneSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingMaskSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingTextSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
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
  
  // Save state
  isSaving: boolean;
  lastSavedAt: string | null;
  
  // Save action
  saveProject: () => Promise<void>;
  
  // Export actions
  exportVideo: (outputPath: string) => Promise<ExportResult>;
  setExportProgress: (progress: ExportProgress | null) => void;
  cancelExport: () => void;
}

const DEFAULT_TIMELINE_ZOOM = 0.05; // 50px per second

// Type alias for the store
export type VideoEditorStore = StoreApi<VideoEditorState>;

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
      selectedMaskSegmentId: null,
      isDraggingPlayhead: false,
      isDraggingZoomRegion: false,
      draggedZoomEdge: null,
      isDraggingSceneSegment: false,
      draggedSceneEdge: null,
      isDraggingMaskSegment: false,
      draggedMaskEdge: null,
      isDraggingTextSegment: false,
      draggedTextEdge: null,
      previewTimeMs: null,
      hoveredTrack: null,
      splitMode: false,
      timelineZoom: DEFAULT_TIMELINE_ZOOM,
      timelineScrollLeft: 0,
      timelineContainerWidth: 0,
      trackVisibility: {
        video: true,
        text: true,
        mask: true,
        zoom: true,
        scene: true,
      },
      isGeneratingAutoZoom: false,
      isExporting: false,
      exportProgress: null,
      isSaving: false,
      lastSavedAt: null,

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

        // Save video project path to session storage for F5 persistence
        if (project?.sources.screenVideo) {
          try {
            sessionStorage.setItem(STORAGE.SESSION_VIDEO_PROJECT_PATH_KEY, project.sources.screenVideo);
            sessionStorage.setItem(STORAGE.SESSION_VIEW_KEY, 'videoEditor');
          } catch {
            // sessionStorage might be disabled
          }
        }

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
          
          // Debug: Compare cursor recording dimensions with video dimensions
          const { project } = get();
          if (project) {
            const videoDims = `${project.sources.originalWidth}x${project.sources.originalHeight}`;
            const cursorDims = `${recording.width}x${recording.height}`;
            if (videoDims !== cursorDims) {
              videoEditorLogger.warn(
                `[CURSOR_SYNC] Dimension mismatch! Video: ${videoDims}, Cursor: ${cursorDims}`
              );
            } else {
              videoEditorLogger.debug(
                `[CURSOR_SYNC] Dimensions match: ${videoDims}`
              );
            }
            videoEditorLogger.debug(
              `[CURSOR_SYNC] Cursor recording: ${recording.events.length} events, ` +
              `videoStartOffsetMs=${recording.videoStartOffsetMs ?? 0}ms`
            );
          }
        } catch (error) {
          videoEditorLogger.warn('Failed to load cursor recording:', error);
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
      selectZoomRegion: (id) => set({
        selectedZoomRegionId: id,
        selectedSceneSegmentId: null,
        selectedTextSegmentId: null,
        selectedMaskSegmentId: null,
        selectedWebcamSegmentIndex: null,
      }),

      addZoomRegion: (region) => {
        const { project } = get();
        if (!project) return;

        // Clamp to video duration
        const durationMs = project.timeline.durationMs;
        const clampedRegion = {
          ...region,
          startMs: Math.max(0, Math.min(region.startMs, durationMs)),
          endMs: Math.max(0, Math.min(region.endMs, durationMs)),
        };

        set({
          project: {
            ...project,
            zoom: {
              ...project.zoom,
              regions: [...project.zoom.regions, clampedRegion],
            },
          },
          selectedZoomRegionId: clampedRegion.id,
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
      selectTextSegment: (id) => set({
        selectedTextSegmentId: id,
        selectedZoomRegionId: null,
        selectedSceneSegmentId: null,
        selectedMaskSegmentId: null,
        selectedWebcamSegmentIndex: null,
      }),

      addTextSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        // Clamp to video duration (convert ms to seconds)
        const durationSec = project.timeline.durationMs / 1000;
        const clampedSegment = {
          ...segment,
          start: Math.max(0, Math.min(segment.start, durationSec)),
          end: Math.max(0, Math.min(segment.end, durationSec)),
        };

        const segments = [...project.text.segments, clampedSegment];
        // Sort by start time (Cap uses seconds)
        segments.sort((a, b) => a.start - b.start);

        // Find the index of the newly added segment after sorting
        const newIndex = segments.findIndex(
          (s) => Math.abs(s.start - clampedSegment.start) < 0.001
        );

        // Generate ID for selection (matches frontend component ID generation: text_<start>_<index>)
        const segmentId = `text_${clampedSegment.start.toFixed(3)}_${newIndex}`;

        set({
          project: {
            ...project,
            text: {
              ...project.text,
              segments,
            },
          },
          selectedTextSegmentId: segmentId,
        });
      },

      updateTextSegment: (id, updates) => {
        const { project } = get();
        if (!project) return;

        // Find segment by generated ID (format: text_<start>_<index>)
        // Use index for reliable matching during drag (start time changes)
        const idParts = id.match(/^text_[0-9.]+_(\d+)$/);
        if (!idParts) return;

        const targetIndex = parseInt(idParts[1], 10);
        if (targetIndex < 0 || targetIndex >= project.text.segments.length) return;

        set({
          project: {
            ...project,
            text: {
              ...project.text,
              segments: project.text.segments.map((s, idx) => {
                if (idx === targetIndex) {
                  return { ...s, ...updates };
                }
                return s;
              }),
            },
          },
        });
      },

      deleteTextSegment: (id) => {
        const { project, selectedTextSegmentId } = get();
        if (!project) return;

        // Find segment by generated ID (format: text_<start>_<index>)
        // Use index for reliable matching
        const idParts = id.match(/^text_[0-9.]+_(\d+)$/);
        if (!idParts) return;

        const targetIndex = parseInt(idParts[1], 10);
        if (targetIndex < 0 || targetIndex >= project.text.segments.length) return;

        set({
          project: {
            ...project,
            text: {
              ...project.text,
              segments: project.text.segments.filter((_, idx) => idx !== targetIndex),
            },
          },
          selectedTextSegmentId: selectedTextSegmentId === id ? null : selectedTextSegmentId,
        });
      },

      // Mask segment actions
      selectMaskSegment: (id) => set({
        selectedMaskSegmentId: id,
        selectedZoomRegionId: null,
        selectedTextSegmentId: null,
        selectedSceneSegmentId: null,
        selectedWebcamSegmentIndex: null,
      }),

      addMaskSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        // Clamp to video duration
        const durationMs = project.timeline.durationMs;
        const clampedSegment = {
          ...segment,
          startMs: Math.max(0, Math.min(segment.startMs, durationMs)),
          endMs: Math.max(0, Math.min(segment.endMs, durationMs)),
        };

        const segments = [...project.mask.segments, clampedSegment];
        segments.sort((a, b) => a.startMs - b.startMs);

        set({
          project: {
            ...project,
            mask: {
              ...project.mask,
              segments,
            },
          },
          selectedMaskSegmentId: clampedSegment.id,
        });
      },

      updateMaskSegment: (id, updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            mask: {
              ...project.mask,
              segments: project.mask.segments.map((s) =>
                s.id === id ? { ...s, ...updates } : s
              ),
            },
          },
        });
      },

      deleteMaskSegment: (id) => {
        const { project, selectedMaskSegmentId } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            mask: {
              ...project.mask,
              segments: project.mask.segments.filter((s) => s.id !== id),
            },
          },
          selectedMaskSegmentId: selectedMaskSegmentId === id ? null : selectedMaskSegmentId,
        });
      },

      // Scene segment actions
      selectSceneSegment: (id) => set({
        selectedSceneSegmentId: id,
        selectedZoomRegionId: null,
        selectedTextSegmentId: null,
        selectedMaskSegmentId: null,
        selectedWebcamSegmentIndex: null,
      }),

      addSceneSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        // Clamp to video duration
        const durationMs = project.timeline.durationMs;
        const clampedSegment = {
          ...segment,
          startMs: Math.max(0, Math.min(segment.startMs, durationMs)),
          endMs: Math.max(0, Math.min(segment.endMs, durationMs)),
        };

        const segments = [...project.scene.segments, clampedSegment];
        segments.sort((a, b) => a.startMs - b.startMs);

        set({
          project: {
            ...project,
            scene: {
              ...project.scene,
              segments,
            },
          },
          selectedSceneSegmentId: clampedSegment.id,
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
      selectWebcamSegment: (index) => set({
        selectedWebcamSegmentIndex: index,
        selectedZoomRegionId: null,
        selectedSceneSegmentId: null,
        selectedTextSegmentId: null,
        selectedMaskSegmentId: null,
      }),

      addWebcamSegment: (segment) => {
        const { project } = get();
        if (!project) return;

        // Clamp to video duration
        const durationMs = project.timeline.durationMs;
        const clampedSegment = {
          ...segment,
          startMs: Math.max(0, Math.min(segment.startMs, durationMs)),
          endMs: Math.max(0, Math.min(segment.endMs, durationMs)),
        };

        const segments = [...project.webcam.visibilitySegments, clampedSegment];
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

      // Cursor config actions
      updateCursorConfig: (updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            cursor: {
              ...project.cursor,
              ...updates,
            },
          },
        });
      },

      // Audio config actions
      updateAudioConfig: (updates) => {
        const { project } = get();
        if (!project) return;

        set({
          project: {
            ...project,
            audio: {
              ...project.audio,
              ...updates,
            },
          },
        });
      },

      // Timeline view actions
      setTimelineZoom: (zoom) => set({ timelineZoom: Math.max(0.01, Math.min(0.1, zoom)) }),

      setTimelineScrollLeft: (scrollLeft) => set({ timelineScrollLeft: scrollLeft }),

      setTimelineContainerWidth: (width) => set({ timelineContainerWidth: width }),

      fitTimelineToWindow: () => {
        const { project, timelineContainerWidth } = get();
        if (!project || timelineContainerWidth <= 0) return;

        const durationMs = project.timeline.durationMs;
        if (durationMs <= 0) return;

        // Calculate zoom to fit timeline with 10% buffer (5% each side)
        const trackLabelWidth = 80;
        const availableWidth = timelineContainerWidth - trackLabelWidth;
        const targetWidth = availableWidth * 0.9; // 90% of available space
        const fitZoom = targetWidth / durationMs;

        // Clamp to valid zoom range
        const clampedZoom = Math.max(0.01, Math.min(0.1, fitZoom));

        set({
          timelineZoom: clampedZoom,
          timelineScrollLeft: 0, // Reset scroll to start
        });
      },

      toggleTrackVisibility: (track) => set((state) => ({
        trackVisibility: {
          ...state.trackVisibility,
          [track]: !state.trackVisibility[track],
        },
      })),

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

      setDraggingMaskSegment: (dragging, edge) => set({
        isDraggingMaskSegment: dragging,
        draggedMaskEdge: dragging ? edge ?? null : null,
      }),

      setDraggingTextSegment: (dragging, edge) => set({
        isDraggingTextSegment: dragging,
        draggedTextEdge: dragging ? edge ?? null : null,
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
            videoEditorLogger.warn('Failed to destroy existing editor instance:', e);
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
          videoEditorLogger.warn('Failed to destroy editor instance:', e);
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
          videoEditorLogger.error('Failed to render frame:', error);
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
          invoke('destroy_editor_instance', { instanceId: editorInstanceId }).catch((e) => videoEditorLogger.warn('Failed to destroy editor on clear:', e));
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
          isDraggingSceneSegment: false,
          draggedSceneEdge: null,
          isDraggingMaskSegment: false,
          draggedMaskEdge: null,
          isDraggingTextSegment: false,
          draggedTextEdge: null,
          previewTimeMs: null,
          hoveredTrack: null,
          splitMode: false,
          timelineZoom: DEFAULT_TIMELINE_ZOOM,
          timelineScrollLeft: 0,
          timelineContainerWidth: 0,
          trackVisibility: {
            video: true,
            text: true,
            mask: true,
            zoom: true,
            scene: true,
          },
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
        
        // Infer format from file extension to ensure consistency
        const ext = outputPath.split('.').pop()?.toLowerCase();
        const formatMap: Record<string, 'mp4' | 'webm' | 'gif'> = {
          mp4: 'mp4',
          webm: 'webm',
          gif: 'gif',
        };
        const selectedFormat = formatMap[ext ?? 'mp4'] ?? 'mp4';
        
        // Create project with correct format for the chosen file extension
        const projectWithFormat = selectedFormat !== project.export.format 
          ? {
              ...project,
              export: {
                ...project.export,
                format: selectedFormat,
              },
            }
          : project;
        
        videoEditorLogger.info(`Exporting to: ${outputPath}`);
        videoEditorLogger.debug(`Format: ${selectedFormat}, Quality: ${projectWithFormat.export.quality}, FPS: ${projectWithFormat.export.fps}`);
        videoEditorLogger.debug('Scene config:', projectWithFormat.scene);
        videoEditorLogger.debug('Zoom config:', projectWithFormat.zoom);
        
        set({ isExporting: true, exportProgress: null });
        
        try {
          const result = await invoke<ExportResult>('export_video', {
            project: projectWithFormat,
            outputPath,
          });
          
          videoEditorLogger.info('Export success:', result);
          set({ isExporting: false, exportProgress: null });
          return result;
        } catch (error) {
          videoEditorLogger.error('Export failed:', error);
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

      // Save project to disk
      saveProject: async () => {
        const { project } = get();
        if (!project) {
          videoEditorLogger.warn('No project to save');
          return;
        }

        set({ isSaving: true });

        try {
          // Sanitize project to ensure all ms values are integers (Rust expects u64)
          const sanitizedProject = sanitizeProjectForSave(project);
          await invoke('save_video_project', { project: sanitizedProject });
          const savedAt = new Date().toISOString();
          set({ isSaving: false, lastSavedAt: savedAt });
        } catch (error) {
          videoEditorLogger.error('Failed to save project:', error);
          set({ isSaving: false });
          throw error;
        }
      },
    }),
    { name: 'VideoEditorStore', enabled: process.env.NODE_ENV === 'development' }
  )
);

// Utility functions

/**
 * Sanitize project for saving - ensures all millisecond values are integers.
 * Rust backend expects u64 for timeline values, but JS may have floats.
 */
function sanitizeProjectForSave(project: VideoProject): VideoProject {
  return {
    ...project,
    timeline: {
      ...project.timeline,
      durationMs: Math.round(project.timeline.durationMs),
      inPoint: Math.round(project.timeline.inPoint),
      outPoint: Math.round(project.timeline.outPoint),
    },
    zoom: {
      ...project.zoom,
      regions: project.zoom.regions.map(region => ({
        ...region,
        startMs: Math.round(region.startMs),
        endMs: Math.round(region.endMs),
      })),
    },
    mask: {
      ...project.mask,
      segments: project.mask.segments.map(segment => ({
        ...segment,
        startMs: Math.round(segment.startMs),
        endMs: Math.round(segment.endMs),
      })),
    },
    scene: {
      ...project.scene,
      segments: project.scene.segments.map(segment => ({
        ...segment,
        startMs: Math.round(segment.startMs),
        endMs: Math.round(segment.endMs),
      })),
    },
    webcam: {
      ...project.webcam,
      visibilitySegments: project.webcam.visibilitySegments.map(segment => ({
        ...segment,
        startMs: Math.round(segment.startMs),
        endMs: Math.round(segment.endMs),
      })),
    },
    // Note: text.segments uses start/end in seconds (f32), not ms
  };
}

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

/**
 * Factory function to create an isolated video editor store.
 * Use this for floating video editor windows that need independent state.
 *
 * Note: For now, this returns the singleton store. Full isolation requires
 * updating all components to use context-based store access.
 *
 * @returns A video editor store instance
 */
export function createVideoEditorStore(): VideoEditorStore {
  // TODO: Implement true isolated stores when components are updated to use context
  // For now, return the singleton to maintain compatibility
  return useVideoEditorStore;
}
