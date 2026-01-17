/**
 * GPUPreviewCanvas - Displays GPU-rendered preview frames from WebSocket stream.
 *
 * This component receives frames from the Rust backend via WebSocket,
 * ensuring the preview exactly matches the exported video (text rendered by glyphon).
 *
 * Uses Cap's approach: calculate exact pixel dimensions instead of object-contain.
 */

import { memo, useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStream } from '../../hooks/usePreviewStream';
import type { VideoProject } from '../../types';
import { videoEditorLogger } from '@/utils/logger';

interface GPUPreviewCanvasProps {
  /** Video project configuration */
  project: VideoProject | null;
  /** Current playback time in milliseconds */
  currentTimeMs: number;
  /** Container width in pixels */
  containerWidth: number;
  /** Container height in pixels */
  containerHeight: number;
  /** Whether to enable GPU preview (falls back to HTML video if false) */
  enabled?: boolean;
  /** Whether currently playing (uses text-only mode for performance) */
  isPlaying?: boolean;
  /** Zoom style to apply (matches video zoom) */
  zoomStyle?: React.CSSProperties;
  /** Callback when preview is ready */
  onReady?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
}

/**
 * Canvas-based preview that displays GPU-rendered frames.
 * Sizes canvas to exact pixel dimensions to fill container without letterboxing.
 */
export const GPUPreviewCanvas = memo(function GPUPreviewCanvas({
  project,
  currentTimeMs,
  containerWidth,
  containerHeight,
  enabled = true,
  isPlaying = false,
  zoomStyle,
  onReady,
  onError,
}: GPUPreviewCanvasProps) {
  // Track initialization state to prevent re-initialization
  const initStateRef = useRef<'idle' | 'initializing' | 'ready' | 'error'>('idle');
  // Track which project is set (state to trigger re-renders)
  const [projectId, setProjectId] = useState<string | null>(null);
  // Track text content version to detect changes
  const lastTextVersionRef = useRef<string | null>(null);

  const {
    canvasRef,
    isConnected,
    hasFrame,
    initPreview,
    renderFrame,
    renderTextOnly,
    shutdown,
  } = usePreviewStream({
    onFrame: (_frameNumber) => {
      // Frame received - could update UI if needed
    },
    onError: (error) => {
      videoEditorLogger.error('GPUPreviewCanvas error:', error);
      initStateRef.current = 'error';
      onError?.(error);
    },
  });

  // Calculate display size for the canvas (Cap's approach: exact pixel dimensions)
  // CSS handles padding/background, GPU canvas only shows video content.
  // Display size is based on video dimensions to fill the container area.
  const displaySize = useMemo(() => {
    const frameWidth = project?.sources.originalWidth ?? 1920;
    const frameHeight = project?.sources.originalHeight ?? 1080;

    if (containerWidth === 0 || containerHeight === 0) {
      return { width: frameWidth, height: frameHeight };
    }

    const containerAspect = containerWidth / containerHeight;
    const frameAspect = frameWidth / frameHeight;

    let width: number;
    let height: number;

    if (frameAspect < containerAspect) {
      // Frame is taller than container - constrain by height
      height = containerHeight;
      width = height * frameAspect;
    } else {
      // Frame is wider than container - constrain by width
      width = containerWidth;
      height = width / frameAspect;
    }

    return { width, height };
  }, [project?.sources.originalWidth, project?.sources.originalHeight, containerWidth, containerHeight]);

  // Stable callbacks that don't change on every render
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  }, [onReady, onError]);

  // Initialize preview system once
  const doInit = useCallback(async () => {
    if (initStateRef.current === 'initializing' || initStateRef.current === 'ready') {
      return;
    }

    initStateRef.current = 'initializing';

    try {
      await initPreview();
      initStateRef.current = 'ready';
      onReadyRef.current?.();
    } catch (error) {
      videoEditorLogger.error('GPUPreviewCanvas failed to initialize:', error);
      initStateRef.current = 'error';
      onErrorRef.current?.(String(error));
    }
  }, [initPreview]);

  // Set project when it changes (by ID or content)
  const doSetProject = useCallback(async (proj: VideoProject, timeMs: number, isNewProject: boolean) => {
    if (initStateRef.current !== 'ready') {
      return;
    }

    try {
      await invoke('set_preview_project', { project: proj });

      // Only update state if this is a new project (ID changed)
      // This prevents re-renders on text edits
      if (isNewProject) {
        setProjectId(proj.id);
        videoEditorLogger.info('GPUPreviewCanvas project set:', proj.id);
      }

      // Render a frame immediately after setting project
      await invoke('render_preview_frame', { timeMs: Math.floor(timeMs) });
    } catch (error) {
      videoEditorLogger.error('GPUPreviewCanvas failed to set project:', error);
      onErrorRef.current?.(String(error));
    }
  }, []);

  // Initialize preview when enabled
  useEffect(() => {
    if (!enabled) {
      return;
    }

    doInit();

    return () => {
      // Only shutdown on unmount, not on every effect cleanup
      if (initStateRef.current === 'ready') {
        initStateRef.current = 'idle';
        setProjectId(null);
        shutdown();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]); // Only depend on enabled, not doInit/shutdown

  // Compute a version string for text content to detect changes
  const textVersion = project?.text?.segments
    ? JSON.stringify(project.text.segments.map(s => ({ content: s.content, center: s.center, size: s.size, fontSize: s.fontSize })))
    : null;

  // Set project when initialized, connected, and project/text changes
  // Debounce text changes to avoid interrupting typing
  useEffect(() => {
    if (!enabled || !project || initStateRef.current !== 'ready' || !isConnected) {
      return;
    }

    // Update if project ID changed OR text content changed
    const isNewProject = projectId !== project.id;
    const textChanged = lastTextVersionRef.current !== textVersion;

    // New project: update immediately
    if (isNewProject) {
      lastTextVersionRef.current = textVersion;
      doSetProject(project, currentTimeMs, true);
      return;
    }

    // Text changed: debounce to avoid interrupting typing
    if (textChanged) {
      const timeoutId = setTimeout(() => {
        lastTextVersionRef.current = textVersion;
        doSetProject(project, currentTimeMs, false);
      }, 300); // 300ms debounce

      return () => clearTimeout(timeoutId);
    }
  }, [enabled, project, isConnected, projectId, textVersion, currentTimeMs, doSetProject]);

  // Render frame when time changes
  // Use different modes: full frame for scrubbing, text-only for playback
  const lastRenderTimeRef = useRef<number>(0);

  useEffect(() => {
    // Only render if connected, ready, AND project is set
    if (!isConnected || !enabled || initStateRef.current !== 'ready' || !projectId) {
      return;
    }

    const now = Date.now();
    const timeSinceLastRender = now - lastRenderTimeRef.current;

    // Always use text-only mode (no video decoding - much faster)
    // Video is handled by HTML video (playback) or WebCodecs (scrubbing)
    // GPU only renders text overlay on transparent background
    const minInterval = isPlaying ? 66 : 16; // ~15fps playback, ~60fps scrub
    if (timeSinceLastRender < minInterval) {
      return;
    }
    lastRenderTimeRef.current = now;
    renderTextOnly(currentTimeMs);
  }, [currentTimeMs, isConnected, enabled, projectId, isPlaying, renderFrame, renderTextOnly]);

  if (!enabled) {
    return null;
  }

  // Don't render canvas at all until we have a valid frame
  // This prevents any possibility of showing uninitialized/skewed content
  if (!hasFrame) {
    // Still need to render the canvas element for the ref to work,
    // but keep it completely hidden and off-screen
    return (
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          left: -9999,
          top: -9999,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
      />
    );
  }

  // Center the canvas and set explicit pixel dimensions (Cap's approach)
  // This ensures the canvas fills the container without gaps
  // Apply zoomStyle to match video zoom transform
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <canvas
        ref={canvasRef}
        style={{
          width: `${displaySize.width}px`,
          height: `${displaySize.height}px`,
          ...zoomStyle,
        }}
      />
    </div>
  );
});

export default GPUPreviewCanvas;
