/**
 * Hook for connecting to GPU-rendered preview frame stream via WebSocket.
 *
 * Based on Cap's frame streaming implementation.
 * Receives RGBA frames from the Rust backend and renders them to a canvas.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

// RGBA magic number for frame validation (matches Rust backend)
const RGBA_MAGIC = 0x52474241; // "RGBA" in little-endian

interface FrameMetadata {
  stride: number;
  height: number;
  width: number;
  frameNumber: number;
  targetTimeNs: bigint;
}

interface UsePreviewStreamOptions {
  /** Callback when a frame is received */
  onFrame?: (frameNumber: number) => void;
  /** Callback on connection error */
  onError?: (error: string) => void;
}

interface UsePreviewStreamResult {
  /** Canvas ref to attach to your canvas element */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Whether the stream is connected */
  isConnected: boolean;
  /** Current frame number */
  frameNumber: number;
  /** Initialize the preview stream */
  initPreview: () => Promise<void>;
  /** Request a frame render at a specific time */
  renderFrame: (timeMs: number) => Promise<void>;
  /** Shutdown the preview stream */
  shutdown: () => Promise<void>;
  /** Current WebSocket URL */
  wsUrl: string | null;
}

/**
 * Parse frame metadata from the last 28 bytes of the frame data.
 */
function parseFrameMetadata(buffer: ArrayBuffer): FrameMetadata | null {
  if (buffer.byteLength < 28) {
    return null;
  }

  const metadataOffset = buffer.byteLength - 28;
  const meta = new DataView(buffer, metadataOffset, 28);

  // Read metadata (little-endian)
  const stride = meta.getUint32(0, true);
  const height = meta.getUint32(4, true);
  const width = meta.getUint32(8, true);
  const frameNumber = meta.getUint32(12, true);
  const targetTimeNs = meta.getBigUint64(16, true);
  const magic = meta.getUint32(24, true);

  // Validate magic number
  if (magic !== RGBA_MAGIC) {
    console.warn('[PreviewStream] Invalid frame magic:', magic.toString(16));
    return null;
  }

  return { stride, height, width, frameNumber, targetTimeNs };
}

/**
 * Hook for streaming GPU-rendered preview frames.
 */
export function usePreviewStream(options: UsePreviewStreamOptions = {}): UsePreviewStreamResult {
  const { onFrame, onError } = options;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const initializingRef = useRef(false);

  const [isConnected, setIsConnected] = useState(false);
  const [frameNumber, setFrameNumber] = useState(0);
  const [wsUrl, setWsUrl] = useState<string | null>(null);

  // Stable refs for callbacks
  const onFrameRef = useRef(onFrame);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onFrameRef.current = onFrame;
    onErrorRef.current = onError;
  }, [onFrame, onError]);

  // Handle incoming frame data
  const handleFrame = useCallback((buffer: ArrayBuffer) => {
    const metadata = parseFrameMetadata(buffer);
    if (!metadata) {
      return;
    }

    const { width, height, frameNumber: fn } = metadata;
    setFrameNumber(fn);
    onFrameRef.current?.(fn);

    // Get canvas context
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    // Resize canvas if needed
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      ctxRef.current = null; // Reset context on resize
    }

    // Get or create context
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = canvas.getContext('2d', { alpha: false });
      ctxRef.current = ctx;
    }

    if (!ctx) {
      return;
    }

    // Extract RGBA data (excluding metadata)
    const rgbaSize = width * height * 4;
    const rgbaData = new Uint8ClampedArray(buffer, 0, rgbaSize);

    // Create ImageData and draw to canvas
    const imageData = new ImageData(rgbaData, width, height);
    ctx.putImageData(imageData, 0, 0);
  }, []);

  // Initialize the preview system
  const initPreview = useCallback(async () => {
    // Prevent concurrent initialization
    if (initializingRef.current || wsRef.current) {
      console.log('[PreviewStream] Already initialized or initializing');
      return;
    }

    initializingRef.current = true;

    try {
      // Initialize backend preview renderer
      const url = await invoke<string>('init_preview');
      setWsUrl(url);

      // Connect to WebSocket
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('[PreviewStream] Connected to', url);
        setIsConnected(true);
      };

      ws.onclose = () => {
        console.log('[PreviewStream] Disconnected');
        setIsConnected(false);
      };

      ws.onerror = (event) => {
        console.error('[PreviewStream] WebSocket error:', event);
        onErrorRef.current?.('WebSocket connection error');
      };

      ws.onmessage = (event) => {
        const buffer = event.data as ArrayBuffer;
        handleFrame(buffer);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[PreviewStream] Failed to initialize:', error);
      onErrorRef.current?.(String(error));
    } finally {
      initializingRef.current = false;
    }
  }, [handleFrame]);

  // Request a frame render at a specific time
  const renderFrame = useCallback(async (timeMs: number) => {
    try {
      // Convert to integer - backend expects u64
      await invoke('render_preview_frame', { timeMs: Math.floor(timeMs) });
    } catch (error) {
      console.error('[PreviewStream] Failed to render frame:', error);
    }
  }, []);

  // Shutdown the preview system
  const shutdown = useCallback(async () => {
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Shutdown backend
    try {
      await invoke('shutdown_preview');
    } catch (error) {
      console.error('[PreviewStream] Failed to shutdown:', error);
    }

    setIsConnected(false);
    setWsUrl(null);
    initializingRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return {
    canvasRef,
    isConnected,
    frameNumber,
    initPreview,
    renderFrame,
    shutdown,
    wsUrl,
  };
}

export default usePreviewStream;
