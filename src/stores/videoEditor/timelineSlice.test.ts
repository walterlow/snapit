import { describe, it, expect, beforeEach } from 'vitest';
import { useVideoEditorStore, DEFAULT_TIMELINE_ZOOM } from './index';
import type { VideoProject } from '../../types';

// Helper to create a minimal test project
function createTestProject(overrides: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'test-project-id',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: 'Test Project',
    sources: {
      screenVideo: '/path/to/video.mp4',
      originalWidth: 1920,
      originalHeight: 1080,
      webcamVideo: null,
      cursorData: null,
      audioFile: null,
    },
    timeline: {
      durationMs: 60000, // 60 seconds
      inPoint: 0,
      outPoint: 60000,
      speed: 1.0,
    },
    zoom: {
      enabled: false,
      regions: [],
      autoZoom: null,
    },
    cursor: {
      visible: true,
      scale: 1.0,
      highlightClicks: false,
      clickRingColor: '#ff0000',
      clickRingOpacity: 0.8,
      clickRingSize: 40,
      clickRingDuration: 300,
      smoothing: 0.5,
    },
    webcam: {
      enabled: false,
      position: 'bottom-right',
      size: 25,
      shape: 'circle',
      borderWidth: 3,
      borderColor: '#ffffff',
      shadowEnabled: true,
      visibilitySegments: [],
    },
    audio: {
      screenVolume: 1.0,
      micVolume: 1.0,
      masterVolume: 1.0,
      muted: false,
    },
    export: {
      preset: 'high',
      format: 'mp4',
      resolution: '1080p',
      frameRate: 30,
      customWidth: null,
      customHeight: null,
    },
    scene: {
      segments: [],
    },
    text: {
      segments: [],
    },
    mask: {
      segments: [],
    },
    ...overrides,
  };
}

// Get initial state for reset
const getInitialTimelineState = () => ({
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
});

describe('timelineSlice', () => {
  beforeEach(() => {
    // Reset store state before each test
    useVideoEditorStore.setState({
      ...getInitialTimelineState(),
      project: null,
    });
  });

  describe('initial state', () => {
    it('should have correct initial values', () => {
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingPlayhead).toBe(false);
      expect(state.isDraggingZoomRegion).toBe(false);
      expect(state.draggedZoomEdge).toBeNull();
      expect(state.previewTimeMs).toBeNull();
      expect(state.hoveredTrack).toBeNull();
      expect(state.splitMode).toBe(false);
      expect(state.timelineZoom).toBe(DEFAULT_TIMELINE_ZOOM);
      expect(state.timelineScrollLeft).toBe(0);
      expect(state.timelineContainerWidth).toBe(0);
    });

    it('should have all tracks visible by default', () => {
      const { trackVisibility } = useVideoEditorStore.getState();
      expect(trackVisibility.video).toBe(true);
      expect(trackVisibility.text).toBe(true);
      expect(trackVisibility.mask).toBe(true);
      expect(trackVisibility.zoom).toBe(true);
      expect(trackVisibility.scene).toBe(true);
    });
  });

  describe('track visibility', () => {
    it('should toggle video track visibility', () => {
      expect(useVideoEditorStore.getState().trackVisibility.video).toBe(true);
      useVideoEditorStore.getState().toggleTrackVisibility('video');
      expect(useVideoEditorStore.getState().trackVisibility.video).toBe(false);
      useVideoEditorStore.getState().toggleTrackVisibility('video');
      expect(useVideoEditorStore.getState().trackVisibility.video).toBe(true);
    });

    it('should toggle text track visibility', () => {
      expect(useVideoEditorStore.getState().trackVisibility.text).toBe(true);
      useVideoEditorStore.getState().toggleTrackVisibility('text');
      expect(useVideoEditorStore.getState().trackVisibility.text).toBe(false);
    });

    it('should toggle mask track visibility', () => {
      expect(useVideoEditorStore.getState().trackVisibility.mask).toBe(true);
      useVideoEditorStore.getState().toggleTrackVisibility('mask');
      expect(useVideoEditorStore.getState().trackVisibility.mask).toBe(false);
    });

    it('should toggle zoom track visibility', () => {
      expect(useVideoEditorStore.getState().trackVisibility.zoom).toBe(true);
      useVideoEditorStore.getState().toggleTrackVisibility('zoom');
      expect(useVideoEditorStore.getState().trackVisibility.zoom).toBe(false);
    });

    it('should toggle scene track visibility', () => {
      expect(useVideoEditorStore.getState().trackVisibility.scene).toBe(true);
      useVideoEditorStore.getState().toggleTrackVisibility('scene');
      expect(useVideoEditorStore.getState().trackVisibility.scene).toBe(false);
    });

    it('should preserve other track visibility when toggling one', () => {
      useVideoEditorStore.getState().toggleTrackVisibility('video');
      const { trackVisibility } = useVideoEditorStore.getState();
      expect(trackVisibility.video).toBe(false);
      expect(trackVisibility.text).toBe(true);
      expect(trackVisibility.mask).toBe(true);
      expect(trackVisibility.zoom).toBe(true);
      expect(trackVisibility.scene).toBe(true);
    });
  });

  describe('timeline zoom', () => {
    it('should set timeline zoom', () => {
      useVideoEditorStore.getState().setTimelineZoom(0.08);
      expect(useVideoEditorStore.getState().timelineZoom).toBe(0.08);
    });

    it('should clamp zoom to minimum of 0.01', () => {
      useVideoEditorStore.getState().setTimelineZoom(0.001);
      expect(useVideoEditorStore.getState().timelineZoom).toBe(0.01);
    });

    it('should clamp zoom to maximum of 0.1', () => {
      useVideoEditorStore.getState().setTimelineZoom(0.5);
      expect(useVideoEditorStore.getState().timelineZoom).toBe(0.1);
    });

    it('should accept edge values', () => {
      useVideoEditorStore.getState().setTimelineZoom(0.01);
      expect(useVideoEditorStore.getState().timelineZoom).toBe(0.01);

      useVideoEditorStore.getState().setTimelineZoom(0.1);
      expect(useVideoEditorStore.getState().timelineZoom).toBe(0.1);
    });
  });

  describe('timeline scroll', () => {
    it('should set timeline scroll left', () => {
      useVideoEditorStore.getState().setTimelineScrollLeft(500);
      expect(useVideoEditorStore.getState().timelineScrollLeft).toBe(500);
    });

    it('should set timeline container width', () => {
      useVideoEditorStore.getState().setTimelineContainerWidth(1200);
      expect(useVideoEditorStore.getState().timelineContainerWidth).toBe(1200);
    });

    it('should accept zero scroll position', () => {
      useVideoEditorStore.getState().setTimelineScrollLeft(100);
      useVideoEditorStore.getState().setTimelineScrollLeft(0);
      expect(useVideoEditorStore.getState().timelineScrollLeft).toBe(0);
    });
  });

  describe('fitTimelineToWindow', () => {
    it('should not adjust zoom without a project', () => {
      const initialZoom = useVideoEditorStore.getState().timelineZoom;
      useVideoEditorStore.getState().setTimelineContainerWidth(1200);
      useVideoEditorStore.getState().fitTimelineToWindow();
      expect(useVideoEditorStore.getState().timelineZoom).toBe(initialZoom);
    });

    it('should not adjust zoom with zero container width', () => {
      const project = createTestProject();
      useVideoEditorStore.setState({ project });
      const initialZoom = useVideoEditorStore.getState().timelineZoom;
      useVideoEditorStore.getState().fitTimelineToWindow();
      expect(useVideoEditorStore.getState().timelineZoom).toBe(initialZoom);
    });

    it('should calculate appropriate zoom to fit timeline', () => {
      const project = createTestProject({
        timeline: {
          durationMs: 60000, // 60 seconds
          inPoint: 0,
          outPoint: 60000,
          speed: 1.0,
        },
      });
      useVideoEditorStore.setState({
        project,
        timelineContainerWidth: 1000,
      });

      useVideoEditorStore.getState().fitTimelineToWindow();

      const { timelineZoom, timelineScrollLeft } = useVideoEditorStore.getState();
      // Should calculate a zoom that fits 60 seconds in ~920px (1000 - 80 track label)
      expect(timelineZoom).toBeGreaterThan(0.01);
      expect(timelineZoom).toBeLessThanOrEqual(0.1);
      // Should reset scroll to start
      expect(timelineScrollLeft).toBe(0);
    });

    it('should reset scroll position when fitting', () => {
      const project = createTestProject();
      useVideoEditorStore.setState({
        project,
        timelineContainerWidth: 1200,
        timelineScrollLeft: 500,
      });

      useVideoEditorStore.getState().fitTimelineToWindow();
      expect(useVideoEditorStore.getState().timelineScrollLeft).toBe(0);
    });
  });

  describe('drag state - playhead', () => {
    it('should set dragging playhead state', () => {
      useVideoEditorStore.getState().setDraggingPlayhead(true);
      expect(useVideoEditorStore.getState().isDraggingPlayhead).toBe(true);
    });

    it('should clear dragging playhead state', () => {
      useVideoEditorStore.getState().setDraggingPlayhead(true);
      useVideoEditorStore.getState().setDraggingPlayhead(false);
      expect(useVideoEditorStore.getState().isDraggingPlayhead).toBe(false);
    });
  });

  describe('drag state - zoom region', () => {
    it('should set dragging zoom region with start edge', () => {
      useVideoEditorStore.getState().setDraggingZoomRegion(true, 'start');
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingZoomRegion).toBe(true);
      expect(state.draggedZoomEdge).toBe('start');
    });

    it('should set dragging zoom region with end edge', () => {
      useVideoEditorStore.getState().setDraggingZoomRegion(true, 'end');
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingZoomRegion).toBe(true);
      expect(state.draggedZoomEdge).toBe('end');
    });

    it('should set dragging zoom region with move edge', () => {
      useVideoEditorStore.getState().setDraggingZoomRegion(true, 'move');
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingZoomRegion).toBe(true);
      expect(state.draggedZoomEdge).toBe('move');
    });

    it('should clear drag state and edge when stopping drag', () => {
      useVideoEditorStore.getState().setDraggingZoomRegion(true, 'start');
      useVideoEditorStore.getState().setDraggingZoomRegion(false);
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingZoomRegion).toBe(false);
      expect(state.draggedZoomEdge).toBeNull();
    });
  });

  describe('drag state - scene segment', () => {
    it('should set dragging scene segment state', () => {
      useVideoEditorStore.getState().setDraggingSceneSegment(true, 'move');
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingSceneSegment).toBe(true);
      expect(state.draggedSceneEdge).toBe('move');
    });

    it('should clear scene segment drag state', () => {
      useVideoEditorStore.getState().setDraggingSceneSegment(true, 'end');
      useVideoEditorStore.getState().setDraggingSceneSegment(false);
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingSceneSegment).toBe(false);
      expect(state.draggedSceneEdge).toBeNull();
    });
  });

  describe('drag state - mask segment', () => {
    it('should set dragging mask segment state', () => {
      useVideoEditorStore.getState().setDraggingMaskSegment(true, 'start');
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingMaskSegment).toBe(true);
      expect(state.draggedMaskEdge).toBe('start');
    });

    it('should clear mask segment drag state', () => {
      useVideoEditorStore.getState().setDraggingMaskSegment(true, 'move');
      useVideoEditorStore.getState().setDraggingMaskSegment(false);
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingMaskSegment).toBe(false);
      expect(state.draggedMaskEdge).toBeNull();
    });
  });

  describe('drag state - text segment', () => {
    it('should set dragging text segment state', () => {
      useVideoEditorStore.getState().setDraggingTextSegment(true, 'end');
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingTextSegment).toBe(true);
      expect(state.draggedTextEdge).toBe('end');
    });

    it('should clear text segment drag state', () => {
      useVideoEditorStore.getState().setDraggingTextSegment(true, 'start');
      useVideoEditorStore.getState().setDraggingTextSegment(false);
      const state = useVideoEditorStore.getState();
      expect(state.isDraggingTextSegment).toBe(false);
      expect(state.draggedTextEdge).toBeNull();
    });
  });

  describe('preview time', () => {
    it('should set preview time', () => {
      useVideoEditorStore.getState().setPreviewTime(5000);
      expect(useVideoEditorStore.getState().previewTimeMs).toBe(5000);
    });

    it('should clear preview time', () => {
      useVideoEditorStore.getState().setPreviewTime(5000);
      useVideoEditorStore.getState().setPreviewTime(null);
      expect(useVideoEditorStore.getState().previewTimeMs).toBeNull();
    });
  });

  describe('hovered track', () => {
    it('should set hovered track to video', () => {
      useVideoEditorStore.getState().setHoveredTrack('video');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('video');
    });

    it('should set hovered track to zoom', () => {
      useVideoEditorStore.getState().setHoveredTrack('zoom');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('zoom');
    });

    it('should set hovered track to audio', () => {
      useVideoEditorStore.getState().setHoveredTrack('audio');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('audio');
    });

    it('should set hovered track to scene', () => {
      useVideoEditorStore.getState().setHoveredTrack('scene');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('scene');
    });

    it('should set hovered track to text', () => {
      useVideoEditorStore.getState().setHoveredTrack('text');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('text');
    });

    it('should set hovered track to webcam', () => {
      useVideoEditorStore.getState().setHoveredTrack('webcam');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('webcam');
    });

    it('should set hovered track to mask', () => {
      useVideoEditorStore.getState().setHoveredTrack('mask');
      expect(useVideoEditorStore.getState().hoveredTrack).toBe('mask');
    });

    it('should clear hovered track', () => {
      useVideoEditorStore.getState().setHoveredTrack('video');
      useVideoEditorStore.getState().setHoveredTrack(null);
      expect(useVideoEditorStore.getState().hoveredTrack).toBeNull();
    });
  });

  describe('split mode', () => {
    it('should enable split mode', () => {
      useVideoEditorStore.getState().setSplitMode(true);
      expect(useVideoEditorStore.getState().splitMode).toBe(true);
    });

    it('should disable split mode', () => {
      useVideoEditorStore.getState().setSplitMode(true);
      useVideoEditorStore.getState().setSplitMode(false);
      expect(useVideoEditorStore.getState().splitMode).toBe(false);
    });
  });

  describe('multiple drag states', () => {
    it('should track multiple drag states independently', () => {
      useVideoEditorStore.getState().setDraggingPlayhead(true);
      useVideoEditorStore.getState().setDraggingZoomRegion(true, 'start');

      const state = useVideoEditorStore.getState();
      expect(state.isDraggingPlayhead).toBe(true);
      expect(state.isDraggingZoomRegion).toBe(true);
      expect(state.draggedZoomEdge).toBe('start');
    });

    it('should clear individual drag states without affecting others', () => {
      useVideoEditorStore.getState().setDraggingPlayhead(true);
      useVideoEditorStore.getState().setDraggingZoomRegion(true, 'end');
      useVideoEditorStore.getState().setDraggingSceneSegment(true, 'move');

      useVideoEditorStore.getState().setDraggingZoomRegion(false);

      const state = useVideoEditorStore.getState();
      expect(state.isDraggingPlayhead).toBe(true);
      expect(state.isDraggingZoomRegion).toBe(false);
      expect(state.draggedZoomEdge).toBeNull();
      expect(state.isDraggingSceneSegment).toBe(true);
      expect(state.draggedSceneEdge).toBe('move');
    });
  });
});
