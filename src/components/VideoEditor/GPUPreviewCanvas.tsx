/**
 * GPUPreviewCanvas - Displays GPU-rendered preview frames from WebSocket stream.
 *
 * This component receives frames from the Rust backend via WebSocket,
 * ensuring the preview exactly matches the exported video (text rendered by glyphon).
 */

import { memo, useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStream } from '../../hooks/usePreviewStream';
import type { VideoProject } from '../../types';

interface GPUPreviewCanvasProps {
  /** Video project configuration */
  project: VideoProject | null;
  /** Current playback time in milliseconds */
  currentTimeMs: number;
  /** Whether to enable GPU preview (falls back to HTML video if false) */
  enabled?: boolean;
  /** Callback when preview is ready */
  onReady?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
}

/**
 * Canvas-based preview that displays GPU-rendered frames.
 */
export const GPUPreviewCanvas = memo(function GPUPreviewCanvas({
  project,
  currentTimeMs,
  enabled = true,
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
    initPreview,
    renderFrame,
    shutdown,
  } = usePreviewStream({
    onFrame: (_frameNumber) => {
      // Frame received - could update UI if needed
    },
    onError: (error) => {
      console.error('[GPUPreviewCanvas] Error:', error);
      initStateRef.current = 'error';
      onError?.(error);
    },
  });

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
      console.error('[GPUPreviewCanvas] Failed to initialize:', error);
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
        console.log('[GPUPreviewCanvas] Project set:', proj.id);
      }

      // Render a frame immediately after setting project
      await invoke('render_preview_frame', { timeMs: Math.floor(timeMs) });
    } catch (error) {
      console.error('[GPUPreviewCanvas] Failed to set project:', error);
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
  useEffect(() => {
    // Only render if connected, ready, AND project is set
    if (!isConnected || !enabled || initStateRef.current !== 'ready' || !projectId) {
      return;
    }

    // Debounce rapid time changes
    const timeoutId = setTimeout(() => {
      renderFrame(currentTimeMs);
    }, 16); // ~60fps max

    return () => clearTimeout(timeoutId);
  }, [currentTimeMs, isConnected, enabled, projectId, renderFrame]);

  if (!enabled) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full object-contain"
      style={{
        imageRendering: 'auto',
      }}
    />
  );
});

export default GPUPreviewCanvas;
