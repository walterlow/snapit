import type {
  SliceCreator,
  ZoomRegion,
  TextSegment,
  MaskSegment,
  SceneSegment,
  VisibilitySegment,
  WebcamConfig,
  CursorConfig,
  AudioTrackSettings,
} from './types';

/**
 * Generate a unique zoom region ID
 */
export function generateZoomRegionId(): string {
  return `zoom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Segments state and actions for managing timeline segments
 * (zoom regions, text, mask, scene, webcam)
 */
export interface SegmentsSlice {
  // Selection state
  selectedZoomRegionId: string | null;
  selectedWebcamSegmentIndex: number | null;
  selectedSceneSegmentId: string | null;
  selectedTextSegmentId: string | null;
  selectedMaskSegmentId: string | null;

  // Zoom region actions
  selectZoomRegion: (id: string | null) => void;
  addZoomRegion: (region: ZoomRegion) => void;
  updateZoomRegion: (id: string, updates: Partial<ZoomRegion>) => void;
  deleteZoomRegion: (id: string) => void;
  splitZoomRegionAtPlayhead: () => void;
  deleteSelectedZoomRegion: () => void;

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

  // Config actions
  updateWebcamConfig: (updates: Partial<WebcamConfig>) => void;
  updateCursorConfig: (updates: Partial<CursorConfig>) => void;
  updateAudioConfig: (updates: Partial<AudioTrackSettings>) => void;
}

export const createSegmentsSlice: SliceCreator<SegmentsSlice> = (set, get) => ({
  // Initial selection state
  selectedZoomRegionId: null,
  selectedWebcamSegmentIndex: null,
  selectedSceneSegmentId: null,
  selectedTextSegmentId: null,
  selectedMaskSegmentId: null,

  // Zoom region actions
  selectZoomRegion: (id) =>
    set({
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
          regions: project.zoom.regions.map((r) => (r.id === id ? { ...r, ...updates } : r)),
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

  splitZoomRegionAtPlayhead: () => {
    const { project, currentTimeMs, selectedZoomRegionId } = get();
    if (!project || !selectedZoomRegionId) return;

    const region = project.zoom.regions.find((r) => r.id === selectedZoomRegionId);
    if (!region) return;

    // Check if playhead is within the region (with some margin)
    const minDuration = 100; // Minimum 100ms per segment
    if (currentTimeMs <= region.startMs + minDuration || currentTimeMs >= region.endMs - minDuration) {
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

  // Text segment actions
  selectTextSegment: (id) =>
    set({
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
    const newIndex = segments.findIndex((s) => Math.abs(s.start - clampedSegment.start) < 0.001);

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
  selectMaskSegment: (id) =>
    set({
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
          segments: project.mask.segments.map((s) => (s.id === id ? { ...s, ...updates } : s)),
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
  selectSceneSegment: (id) =>
    set({
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
          segments: project.scene.segments.map((s) => (s.id === id ? { ...s, ...updates } : s)),
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
  selectWebcamSegment: (index) =>
    set({
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
      selectedWebcamSegmentIndex: selectedWebcamSegmentIndex === index ? null : selectedWebcamSegmentIndex,
    });
  },

  toggleWebcamAtTime: (timeMs) => {
    const { project } = get();
    if (!project) return;

    const segments = project.webcam.visibilitySegments;

    // Find if current time is within a segment
    const segmentIndex = segments.findIndex((s) => timeMs >= s.startMs && timeMs <= s.endMs);

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
        newSegments.splice(segmentIndex, 1, { ...segment, endMs: timeMs }, { ...segment, startMs: timeMs });
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

  // Config actions
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
});
