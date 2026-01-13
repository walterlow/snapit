/**
 * Hook for WASM-based text rendering using WebGPU.
 *
 * Renders text overlays directly in the browser using wgpu + glyphon
 * compiled to WebAssembly. This eliminates the Rust↔Browser round trip
 * overhead of the WebSocket-based GPU preview.
 */

import { useRef, useCallback, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TextSegment } from '../types';

// WASM module types
interface FontInfo {
  family: string;
  weight: number;
}

interface WasmTextRenderer {
  resize(width: number, height: number): void;
  render(segments: WasmTextSegment[], timeSec: number): void;
  load_font(fontData: Uint8Array): FontInfo;
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

// Font cache - maps requested "family:weight" to actual registered info
const fontMapping = new Map<string, FontInfo>();
const fontLoadPromises = new Map<string, Promise<FontInfo | null>>();

// Lock counter to prevent concurrent access to renderer (causes aliasing errors in WASM)
let rendererLockCount = 0;

// Built-in fonts that don't need loading (always available via fallback)
const BUILTIN_FONTS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  'cursive',
  'fantasy',
  '',
]);

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
      const module = await import('../wasm/text-renderer/text_renderer_wasm.js') as WasmModule;
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
 * Convert TextSegment to WASM format, using actual registered font names.
 */
function toWasmSegment(segment: TextSegment, fontMap: Map<string, FontInfo>): WasmTextSegment {
  // Look up actual font info from our mapping
  const requestedKey = `${segment.fontFamily}:${Math.round(segment.fontWeight / 100) * 100}`;
  const actualFont = fontMap.get(requestedKey);

  return {
    start: segment.start,
    end: segment.end,
    enabled: segment.enabled,
    content: segment.content,
    centerX: segment.center.x,
    centerY: segment.center.y,
    sizeX: segment.size.x,
    sizeY: segment.size.y,
    // Use actual registered font name if available, otherwise use requested
    fontFamily: actualFont?.family ?? segment.fontFamily,
    fontSize: segment.fontSize,
    // Use actual registered weight if available, otherwise use requested
    fontWeight: actualFont?.weight ?? segment.fontWeight,
    italic: segment.italic,
    color: segment.color,
    fadeDuration: segment.fadeDuration,
  };
}

export interface UseWasmTextRendererOptions {
  canvasId: string;
  width: number;
  height: number;
  onError?: (error: string) => void;
}

export interface UseWasmTextRendererResult {
  isReady: boolean;
  isSupported: boolean;
  render: (segments: TextSegment[], timeSec: number) => void;
  loadFont: (fontFamily: string, weight?: number) => Promise<FontInfo | null>;
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

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Initialize renderer
  useEffect(() => {
    if (!canvasId || width === 0 || height === 0) {
      return;
    }

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

        // Clear caches when new renderer is created
        fontMapping.clear();
        fontLoadPromises.clear();
        rendererLockCount = 0;

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

  // Load font function - returns actual registered font info
  const loadFont = useCallback(async (fontFamily: string, weight?: number): Promise<FontInfo | null> => {
    const normalizedFamily = fontFamily.toLowerCase().trim();
    if (BUILTIN_FONTS.has(normalizedFamily)) {
      return { family: 'Noto Sans', weight: 400 }; // Will use embedded fallback
    }

    const fontWeight = weight ?? 400;
    const cacheKey = `${fontFamily}:${fontWeight}`;

    // Check if already loaded
    const cached = fontMapping.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check if loading in progress
    const existingPromise = fontLoadPromises.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    // Start loading
    rendererLockCount++;

    const loadPromise = (async (): Promise<FontInfo | null> => {
      try {
        if (!rendererRef.current) {
          console.warn('[WasmTextRenderer] Cannot load font: renderer not ready');
          return null;
        }

        console.debug(`[WasmTextRenderer] Loading font: ${fontFamily} (weight: ${fontWeight})`);
        const fontData = await invoke<number[]>('get_font_data', { family: fontFamily, weight: fontWeight });

        const fontBytes = new Uint8Array(fontData);
        const actualInfo = rendererRef.current.load_font(fontBytes) as FontInfo;

        // Store the mapping from requested -> actual
        fontMapping.set(cacheKey, actualInfo);
        console.log(`[WasmTextRenderer] Font loaded: "${fontFamily}:${fontWeight}" -> actual: "${actualInfo.family}:${actualInfo.weight}"`);

        return actualInfo;
      } catch (error) {
        console.error(`[WasmTextRenderer] Failed to load font "${fontFamily}" weight ${fontWeight}:`, error);
        return null;
      } finally {
        fontLoadPromises.delete(cacheKey);
        rendererLockCount--;
      }
    })();

    fontLoadPromises.set(cacheKey, loadPromise);
    return loadPromise;
  }, []);

  // Render function
  const render = useCallback((segments: TextSegment[], timeSec: number) => {
    if (!rendererRef.current) {
      return;
    }

    if (rendererLockCount > 0) {
      console.debug('[WasmTextRenderer] Render skipped: font loading in progress');
      return;
    }

    try {
      // Convert segments using actual font mapping
      const wasmSegments = segments.map(s => toWasmSegment(s, fontMapping));
      rendererRef.current.render(wasmSegments, timeSec);
    } catch (error) {
      console.error('[WasmTextRenderer] Render failed:', error);
      onErrorRef.current?.(String(error));
    }
  }, []);

  const cleanup = useCallback(() => {
    if (rendererRef.current) {
      try {
        rendererRef.current.free();
      } catch {
        // Ignore
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
    loadFont,
    cleanup,
  };
}
