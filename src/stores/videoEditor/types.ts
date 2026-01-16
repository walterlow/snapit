import type { StateCreator } from 'zustand';
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
} from '../../types';

// Re-export types for external use
export type {
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
};

// Import slice types
import type { PlaybackSlice } from './playbackSlice';
import type { TimelineSlice } from './timelineSlice';
import type { SegmentsSlice } from './segmentsSlice';
import type { ExportSlice } from './exportSlice';
import type { ProjectSlice } from './projectSlice';
import type { GPUEditorSlice } from './gpuEditorSlice';

/**
 * Combined VideoEditorState type from all slices
 */
export type VideoEditorState = PlaybackSlice &
  TimelineSlice &
  SegmentsSlice &
  ExportSlice &
  ProjectSlice &
  GPUEditorSlice;

/**
 * Slice creator type for creating slice with access to full state
 */
export type SliceCreator<T> = StateCreator<VideoEditorState, [], [], T>;

/**
 * Track visibility configuration
 */
export interface TrackVisibility {
  video: boolean;
  text: boolean;
  mask: boolean;
  zoom: boolean;
  scene: boolean;
}

/**
 * Track types for hover state
 */
export type HoveredTrack = 'video' | 'zoom' | 'audio' | 'scene' | 'text' | 'webcam' | 'mask' | null;

/**
 * Drag edge types
 */
export type DragEdge = 'start' | 'end' | 'move' | null;
