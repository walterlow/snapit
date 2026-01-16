import { invoke } from '@tauri-apps/api/core';
import type { SliceCreator, VideoProject, EditorInstanceInfo, PlaybackEvent, RenderedFrame } from './types';
import { videoEditorLogger } from '../../utils/logger';

/**
 * GPU Editor state and actions for GPU-accelerated video rendering
 */
export interface GPUEditorSlice {
  // GPU Editor instance state
  editorInstanceId: string | null;
  editorInfo: EditorInstanceInfo | null;
  isInitializingEditor: boolean;

  // GPU Editor actions
  initializeGPUEditor: (project: VideoProject) => Promise<void>;
  destroyGPUEditor: () => Promise<void>;
  handlePlaybackEvent: (event: PlaybackEvent) => void;
  renderFrame: (timestampMs: number) => Promise<RenderedFrame | null>;
  gpuPlay: () => Promise<void>;
  gpuPause: () => Promise<void>;
  gpuSeek: (timestampMs: number) => Promise<void>;
}

export const createGPUEditorSlice: SliceCreator<GPUEditorSlice> = (set, get) => ({
  // Initial state
  editorInstanceId: null,
  editorInfo: null,
  isInitializingEditor: false,

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
});
