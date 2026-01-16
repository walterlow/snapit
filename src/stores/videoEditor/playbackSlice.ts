import type { SliceCreator, RenderedFrame } from './types';

/**
 * Playback state and actions for video playback control
 */
export interface PlaybackSlice {
  // Playback state
  currentTimeMs: number;
  currentFrame: number;
  isPlaying: boolean;
  renderedFrame: RenderedFrame | null;

  // Playback actions
  setCurrentTime: (timeMs: number) => void;
  togglePlayback: () => void;
  setIsPlaying: (playing: boolean) => void;
}

export const createPlaybackSlice: SliceCreator<PlaybackSlice> = (set, get) => ({
  // Initial state
  currentTimeMs: 0,
  currentFrame: 0,
  isPlaying: false,
  renderedFrame: null,

  // Actions
  setCurrentTime: (timeMs) => {
    const { project } = get();
    if (!project) return;

    // Clamp to valid range
    const clampedTime = Math.max(0, Math.min(timeMs, project.timeline.durationMs));
    set({ currentTimeMs: clampedTime });
  },

  togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),

  setIsPlaying: (playing) => set({ isPlaying: playing }),
});
