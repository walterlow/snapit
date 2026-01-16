import type { SliceCreator, TrackVisibility, HoveredTrack, DragEdge } from './types';

export const DEFAULT_TIMELINE_ZOOM = 0.05; // 50px per second

/**
 * Timeline view state and actions for timeline UI control
 */
export interface TimelineSlice {
  // Timeline interaction state
  isDraggingPlayhead: boolean;
  isDraggingZoomRegion: boolean;
  draggedZoomEdge: DragEdge;
  isDraggingSceneSegment: boolean;
  draggedSceneEdge: DragEdge;
  isDraggingMaskSegment: boolean;
  draggedMaskEdge: DragEdge;
  isDraggingTextSegment: boolean;
  draggedTextEdge: DragEdge;
  previewTimeMs: number | null;
  hoveredTrack: HoveredTrack;
  splitMode: boolean;

  // View state
  trackVisibility: TrackVisibility;
  timelineZoom: number;
  timelineScrollLeft: number;
  timelineContainerWidth: number;

  // Timeline view actions
  setTimelineZoom: (zoom: number) => void;
  setTimelineScrollLeft: (scrollLeft: number) => void;
  setTimelineContainerWidth: (width: number) => void;
  fitTimelineToWindow: () => void;
  toggleTrackVisibility: (track: keyof TrackVisibility) => void;

  // Drag state actions
  setDraggingPlayhead: (dragging: boolean) => void;
  setDraggingZoomRegion: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingSceneSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingMaskSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setDraggingTextSegment: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
  setPreviewTime: (timeMs: number | null) => void;
  setHoveredTrack: (track: HoveredTrack) => void;

  // Split mode actions
  setSplitMode: (enabled: boolean) => void;
}

export const createTimelineSlice: SliceCreator<TimelineSlice> = (set, get) => ({
  // Initial state
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

  toggleTrackVisibility: (track) =>
    set((state) => ({
      trackVisibility: {
        ...state.trackVisibility,
        [track]: !state.trackVisibility[track],
      },
    })),

  // Drag state actions
  setDraggingPlayhead: (dragging) => set({ isDraggingPlayhead: dragging }),
  setPreviewTime: (timeMs) => set({ previewTimeMs: timeMs }),

  setHoveredTrack: (track) => set({ hoveredTrack: track }),

  setDraggingZoomRegion: (dragging, edge) =>
    set({
      isDraggingZoomRegion: dragging,
      draggedZoomEdge: dragging ? edge ?? null : null,
    }),

  setDraggingSceneSegment: (dragging, edge) =>
    set({
      isDraggingSceneSegment: dragging,
      draggedSceneEdge: dragging ? edge ?? null : null,
    }),

  setDraggingMaskSegment: (dragging, edge) =>
    set({
      isDraggingMaskSegment: dragging,
      draggedMaskEdge: dragging ? edge ?? null : null,
    }),

  setDraggingTextSegment: (dragging, edge) =>
    set({
      isDraggingTextSegment: dragging,
      draggedTextEdge: dragging ? edge ?? null : null,
    }),

  // Split mode actions
  setSplitMode: (enabled) => set({ splitMode: enabled }),
});
