/**
 * Hook for WASM-based text rendering using WebGPU.
 *
 * Renders text overlays directly in the browser using wgpu + glyphon
 * compiled to WebAssembly. This eliminates the Rust↔Browser round trip
 * overhead of the WebSocket-based GPU preview.
 */

import { useRef, useCallback, useState, useEffect } from 'react';
import type { TextSegment } from '../types';

// WASM module types
interface WasmTextRenderer {
  resize(width: number, height: number): void;
  render(segments: WasmTextSegment[], timeSec: number): void;
  free(): void;
}

interface WasmModule {
  default: (input?: { module_or_path: string }) => Promise<unknown>;
  WasmTextRenderer: {
    create(canvasId: string): Promise<WasmTextRenderer>;
  };
}

// WASM expects flattened segment format with camelCase
interface WasmTextSegment {
  start: number;
  end: number;
  enabled: boolean;
  content: string;
  centerX: number;
  centerY: number;
  sizeX: number;
  sizeY: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  fadeDuration: number;
}

// Module singleton
let wasmModule: WasmModule | null = null;
let moduleLoadPromise: Promise<WasmModule> | null = null;

/**
 * Load the WASM module (singleton pattern).
 */
async function loadWasmModule(): Promise<WasmModule> {
  if (wasmModule) {
    return wasmModule;
  }

  if (moduleLoadPromise) {
    return moduleLoadPromise;
  }

  moduleLoadPromise = (async () => {
    try {
      // Dynamic import of the WASM module
      const module = await import('../wasm/text-renderer/text_renderer_wasm.js') as WasmModule;

      // Initialize the WASM module
      await module.default();

      console.log('[WasmTextRenderer] Module loaded successfully');
      wasmModule = module;
      return module;
    } catch (error) {
      console.error('[WasmTextRenderer] Failed to load module:', error);
      moduleLoadPromise = null;
      throw error;
    }
  })();

  return moduleLoadPromise;
}

/**
 * Convert TextSegment to WASM format.
 */
function toWasmSegment(segment: TextSegment): WasmTextSegment {
  return {
    start: segment.start,
    end: segment.end,
    enabled: segment.enabled,
    content: segment.content,
    centerX: segment.center.x,
    centerY: segment.center.y,
    sizeX: segment.size.x,
    sizeY: segment.size.y,
    fontFamily: segment.fontFamily,
    fontSize: segment.fontSize,
    fontWeight: segment.fontWeight,
    italic: segment.italic,
    color: segment.color,
    fadeDuration: segment.fadeDuration,
  };
}

export interface UseWasmTextRendererOptions {
  /** Canvas element ID */
  canvasId: string;
  /** Canvas width */
  width: number;
  /** Canvas height */
  height: number;
  /** Callback on error */
  onError?: (error: string) => void;
}

export interface UseWasmTextRendererResult {
  /** Whether the renderer is ready */
  isReady: boolean;
  /** Whether WebGPU is supported */
  isSupported: boolean;
  /** Render text segments at the given time */
  render: (segments: TextSegment[], timeSec: number) => void;
  /** Cleanup the renderer */
  cleanup: () => void;
}

/**
 * Hook to use the WASM text renderer.
 */
export function useWasmTextRenderer({
  canvasId,
  width,
  height,
  onError,
}: UseWasmTextRendererOptions): UseWasmTextRendererResult {
  const rendererRef = useRef<WasmTextRenderer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const initializingRef = useRef(false);

  // Store callbacks in refs to avoid stale closures
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Initialize renderer
  useEffect(() => {
    if (!canvasId || width === 0 || height === 0) {
      return;
    }

    // Check WebGPU support
    if (!('gpu' in navigator)) {
      console.warn('[WasmTextRenderer] WebGPU not supported');
      setIsSupported(false);
      return;
    }

    if (initializingRef.current || rendererRef.current) {
      return;
    }

    initializingRef.current = true;

    (async () => {
      try {
        const module = await loadWasmModule();
        const renderer = await module.WasmTextRenderer.create(canvasId);
        renderer.resize(width, height);

        rendererRef.current = renderer;
        setIsReady(true);
        console.log(`[WasmTextRenderer] Initialized for canvas: ${canvasId} (${width}x${height})`);
      } catch (error) {
        console.error('[WasmTextRenderer] Initialization failed:', error);
        onErrorRef.current?.(String(error));
        initializingRef.current = false;
      }
    })();

    return () => {
      if (rendererRef.current) {
        try {
          rendererRef.current.free();
        } catch {
          // Ignore errors during cleanup
        }
        rendererRef.current = null;
      }
      setIsReady(false);
      initializingRef.current = false;
    };
  }, [canvasId, width, height]);

  // Handle resize
  useEffect(() => {
    if (rendererRef.current && width > 0 && height > 0) {
      rendererRef.current.resize(width, height);
    }
  }, [width, height]);

  // Render function
  const render = useCallback((segments: TextSegment[], timeSec: number) => {
    if (!rendererRef.current) {
      return;
    }

    try {
      const wasmSegments = segments.map(toWasmSegment);
      rendererRef.current.render(wasmSegments, timeSec);
    } catch (error) {
      console.error('[WasmTextRenderer] Render failed:', error);
      onErrorRef.current?.(String(error));
    }
  }, []);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (rendererRef.current) {
      try {
        rendererRef.current.free();
      } catch {
        // Ignore errors during cleanup
      }
      rendererRef.current = null;
    }
    setIsReady(false);
    initializingRef.current = false;
  }, []);

  return {
    isReady,
    isSupported,
    render,
    cleanup,
  };
}
