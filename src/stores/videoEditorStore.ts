/**
 * @deprecated Import from '@/stores/videoEditor' instead.
 * This file re-exports from the new modular location for backwards compatibility.
 */
export {
  useVideoEditorStore,
  createVideoEditorStore,
  generateZoomRegionId,
  formatTimecode,
  formatTimeSimple,
  sanitizeProjectForSave,
  DEFAULT_TIMELINE_ZOOM,
} from './videoEditor';

export type {
  VideoEditorState,
  VideoEditorStore,
  PlaybackSlice,
  TimelineSlice,
  SegmentsSlice,
  ExportSlice,
  ProjectSlice,
  GPUEditorSlice,
} from './videoEditor';
