/**
 * Hook for managing WebCodecs decoder worker lifecycle.
 * Handles worker creation, message passing, and cleanup.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  FrameDecodedMessage,
} from '../workers/webcodecs-decoder.types';
import { videoEditorLogger } from '@/utils/logger';

interface WorkerState {
  isReady: boolean;
  error: string | null;
  dimensions: { width: number; height: number } | null;
  durationMs: number;
}

interface UseWebCodecsWorkerOptions {
  onFrameDecoded: (msg: FrameDecodedMessage) => void;
  onFrameError?: (requestId: number, timestampMs: number, error: string) => void;
  onCacheEvicted?: (timestampMs: number) => void;
}

interface UseWebCodecsWorkerResult extends WorkerState {
  requestFrame: (timestampMs: number, priority?: 'immediate' | 'prefetch') => number;
  clearCache: () => void;
}

export function useWebCodecsWorker(
  videoUrl: string | null,
  options: UseWebCodecsWorkerOptions
): UseWebCodecsWorkerResult {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [state, setState] = useState<WorkerState>({
    isReady: false,
    error: null,
    dimensions: null,
    durationMs: 0,
  });

  // Stable refs for callbacks to avoid re-creating worker on callback changes
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Initialize worker when videoUrl changes
  useEffect(() => {
    if (!videoUrl) {
      setState({ isReady: false, error: null, dimensions: null, durationMs: 0 });
      return;
    }

    // Reset state for new video
    setState({ isReady: false, error: null, dimensions: null, durationMs: 0 });

    // Create worker using Vite's worker import pattern
    let worker: Worker;
    try {
      worker = new Worker(
        new URL('../workers/webcodecs-decoder.worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (err) {
      videoEditorLogger.error('Failed to create WebCodecs worker:', err);
      setState((s) => ({
        ...s,
        error: 'Failed to create worker',
        isReady: false,
      }));
      return;
    }

    worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;

      switch (msg.type) {
        case 'ready':
          setState({
            isReady: true,
            error: null,
            dimensions: msg.dimensions,
            durationMs: msg.durationMs,
          });
          videoEditorLogger.debug(
            `[WebCodecsWorker] Ready: ${msg.dimensions.width}x${msg.dimensions.height}, ${msg.durationMs}ms`
          );
          break;

        case 'init-error':
          setState((s) => ({ ...s, error: msg.error, isReady: false }));
          videoEditorLogger.error('[WebCodecsWorker] Init error:', msg.error);
          break;

        case 'frame-decoded':
          optionsRef.current.onFrameDecoded(msg);
          break;

        case 'frame-error':
          optionsRef.current.onFrameError?.(msg.requestId, msg.timestampMs, msg.error);
          break;

        case 'cache-evicted':
          optionsRef.current.onCacheEvicted?.(msg.timestampMs);
          break;
      }
    };

    worker.onerror = (err) => {
      videoEditorLogger.error('[WebCodecsWorker] Worker error:', err);
      setState((s) => ({ ...s, error: 'Worker error', isReady: false }));
    };

    workerRef.current = worker;

    // Initialize the worker
    const initMsg: MainToWorkerMessage = {
      type: 'init',
      videoUrl,
    };
    worker.postMessage(initMsg);

    return () => {
      // Send dispose message before terminating
      const disposeMsg: MainToWorkerMessage = { type: 'dispose' };
      worker.postMessage(disposeMsg);

      // Give worker time to clean up, then terminate
      setTimeout(() => {
        worker.terminate();
      }, 100);

      workerRef.current = null;
    };
  }, [videoUrl]);

  // Request frame decode
  const requestFrame = useCallback(
    (timestampMs: number, priority: 'immediate' | 'prefetch' = 'prefetch'): number => {
      const worker = workerRef.current;
      if (!worker) return -1;

      const requestId = ++requestIdRef.current;
      const msg: MainToWorkerMessage = {
        type: 'decode-frame',
        timestampMs,
        requestId,
        priority,
      };
      worker.postMessage(msg);
      return requestId;
    },
    []
  );

  // Clear worker cache
  const clearCache = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;

    const msg: MainToWorkerMessage = { type: 'clear-cache' };
    worker.postMessage(msg);
  }, []);

  return {
    ...state,
    requestFrame,
    clearCache,
  };
}
