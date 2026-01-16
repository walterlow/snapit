import { create, type StoreApi } from 'zustand';
import { devtools } from 'zustand/middleware';

// Import slice creators
import { createPlaybackSlice } from './playbackSlice';
import { createTimelineSlice } from './timelineSlice';
import { createSegmentsSlice } from './segmentsSlice';
import { createExportSlice } from './exportSlice';
import { createProjectSlice } from './projectSlice';
import { createGPUEditorSlice } from './gpuEditorSlice';

// Import and re-export types
import type { VideoEditorState } from './types';
export type { VideoEditorState } from './types';

// Re-export slice types for consumers who need them
export type { PlaybackSlice } from './playbackSlice';
export type { TimelineSlice } from './timelineSlice';
export type { SegmentsSlice } from './segmentsSlice';
export type { ExportSlice } from './exportSlice';
export type { ProjectSlice } from './projectSlice';
export type { GPUEditorSlice } from './gpuEditorSlice';

// Type alias for the store
export type VideoEditorStore = StoreApi<VideoEditorState>;

/**
 * Combined video editor store with all feature slices
 */
export const useVideoEditorStore = create<VideoEditorState>()(
  devtools(
    (...a) => ({
      ...createPlaybackSlice(...a),
      ...createTimelineSlice(...a),
      ...createSegmentsSlice(...a),
      ...createExportSlice(...a),
      ...createProjectSlice(...a),
      ...createGPUEditorSlice(...a),
    }),
    { name: 'VideoEditorStore', enabled: process.env.NODE_ENV === 'development' }
  )
);

// Re-export utility functions
export { generateZoomRegionId } from './segmentsSlice';
export { sanitizeProjectForSave } from './projectSlice';
export { DEFAULT_TIMELINE_ZOOM } from './timelineSlice';

/**
 * Format milliseconds as timecode (MM:SS:FF at 30fps)
 */
export function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor((ms % 1000) / (1000 / 30)); // Assuming 30fps

  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Format milliseconds as simple time (M:SS)
 */
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
