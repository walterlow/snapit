/**
 * VideoEditorContext - Provides isolated video editor state per window.
 *
 * This context allows multiple video editor windows to have independent state.
 * Each window creates its own store instance via the VideoEditorProvider.
 */

import { createContext, useContext, useRef, useEffect, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import {
  createVideoEditorStore,
  useVideoEditorStore as globalVideoEditorStore,
  type VideoEditorState,
} from '../stores/videoEditorStore';

// Context holds the store instance
const VideoEditorContext = createContext<StoreApi<VideoEditorState> | null>(null);

interface VideoEditorProviderProps {
  children: ReactNode;
}

/**
 * Provider that creates an isolated video editor store for its subtree.
 * Use this in each video editor window to get independent state.
 */
export function VideoEditorProvider({ children }: VideoEditorProviderProps) {
  // Create store once on mount
  const storeRef = useRef<StoreApi<VideoEditorState> | null>(null);

  if (!storeRef.current) {
    storeRef.current = createVideoEditorStore();
  }

  // Cleanup store on unmount
  useEffect(() => {
    return () => {
      // Cleanup GPU editor when provider unmounts
      const store = storeRef.current;
      if (store) {
        const state = store.getState();
        if (state.editorInstanceId) {
          state.destroyGPUEditor().catch(console.warn);
        }
      }
    };
  }, []);

  return (
    <VideoEditorContext.Provider value={storeRef.current}>
      {children}
    </VideoEditorContext.Provider>
  );
}

/**
 * Get the video editor store from context.
 * Throws if used outside of VideoEditorProvider.
 */
export function useVideoEditorContext(): StoreApi<VideoEditorState> {
  const store = useContext(VideoEditorContext);
  if (!store) {
    throw new Error('useVideoEditorContext must be used within a VideoEditorProvider');
  }
  return store;
}

/**
 * Hook to access video editor state with selector.
 * Uses the store from context if available, otherwise falls back to global store.
 *
 * @param selector - Function to select state from the store
 * @returns Selected state
 */
export function useVideoEditor<T>(selector: (state: VideoEditorState) => T): T {
  const contextStore = useContext(VideoEditorContext);
  // Always call useStore unconditionally to satisfy React hooks rules
  const store = contextStore ?? globalVideoEditorStore;
  return useStore(store, selector);
}

/**
 * Hook to access video editor store actions.
 * Returns stable references to store actions.
 */
export function useVideoEditorActions() {
  const contextStore = useContext(VideoEditorContext);

  if (contextStore) {
    // Return actions from context store
    const state = contextStore.getState();
    return {
      setProject: state.setProject,
      loadCursorData: state.loadCursorData,
      setCurrentTime: state.setCurrentTime,
      togglePlayback: state.togglePlayback,
      setIsPlaying: state.setIsPlaying,
      initializeGPUEditor: state.initializeGPUEditor,
      destroyGPUEditor: state.destroyGPUEditor,
      handlePlaybackEvent: state.handlePlaybackEvent,
      renderFrame: state.renderFrame,
      gpuPlay: state.gpuPlay,
      gpuPause: state.gpuPause,
      gpuSeek: state.gpuSeek,
      selectZoomRegion: state.selectZoomRegion,
      addZoomRegion: state.addZoomRegion,
      updateZoomRegion: state.updateZoomRegion,
      deleteZoomRegion: state.deleteZoomRegion,
      selectTextSegment: state.selectTextSegment,
      addTextSegment: state.addTextSegment,
      updateTextSegment: state.updateTextSegment,
      deleteTextSegment: state.deleteTextSegment,
      selectMaskSegment: state.selectMaskSegment,
      addMaskSegment: state.addMaskSegment,
      updateMaskSegment: state.updateMaskSegment,
      deleteMaskSegment: state.deleteMaskSegment,
      selectSceneSegment: state.selectSceneSegment,
      addSceneSegment: state.addSceneSegment,
      updateSceneSegment: state.updateSceneSegment,
      deleteSceneSegment: state.deleteSceneSegment,
      selectWebcamSegment: state.selectWebcamSegment,
      addWebcamSegment: state.addWebcamSegment,
      updateWebcamSegment: state.updateWebcamSegment,
      deleteWebcamSegment: state.deleteWebcamSegment,
      toggleWebcamAtTime: state.toggleWebcamAtTime,
      updateWebcamConfig: state.updateWebcamConfig,
      updateExportConfig: state.updateExportConfig,
      updateCursorConfig: state.updateCursorConfig,
      updateAudioConfig: state.updateAudioConfig,
      setTimelineZoom: state.setTimelineZoom,
      setTimelineScrollLeft: state.setTimelineScrollLeft,
      toggleTrackVisibility: state.toggleTrackVisibility,
      setDraggingPlayhead: state.setDraggingPlayhead,
      setDraggingZoomRegion: state.setDraggingZoomRegion,
      setDraggingSceneSegment: state.setDraggingSceneSegment,
      setDraggingMaskSegment: state.setDraggingMaskSegment,
      setDraggingTextSegment: state.setDraggingTextSegment,
      setPreviewTime: state.setPreviewTime,
      setHoveredTrack: state.setHoveredTrack,
      setSplitMode: state.setSplitMode,
      splitZoomRegionAtPlayhead: state.splitZoomRegionAtPlayhead,
      deleteSelectedZoomRegion: state.deleteSelectedZoomRegion,
      clearEditor: state.clearEditor,
      generateAutoZoom: state.generateAutoZoom,
      saveProject: state.saveProject,
      exportVideo: state.exportVideo,
      setExportProgress: state.setExportProgress,
      cancelExport: state.cancelExport,
    };
  }

  // Fallback to global store
  return globalVideoEditorStore.getState();
}

/**
 * Get the raw store for imperative access.
 * Returns context store if available, otherwise global store.
 */
export function useVideoEditorStore(): StoreApi<VideoEditorState> {
  const contextStore = useContext(VideoEditorContext);

  if (contextStore) {
    return contextStore;
  }

  // Fallback to global store
  return globalVideoEditorStore;
}
