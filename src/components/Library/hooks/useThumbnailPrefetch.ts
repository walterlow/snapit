import { useEffect, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { CaptureListItem } from '../../../types';

// Global cache for converted thumbnail URLs (WeakMap doesn't work with strings)
// Using a Map with LRU-like behavior (max 500 entries)
const urlCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

/**
 * Get a cached converted URL for a thumbnail path.
 * Caches results to avoid repeated convertFileSrc calls.
 */
export function getCachedThumbnailUrl(thumbnailPath: string): string {
  if (!thumbnailPath) return '';

  let url = urlCache.get(thumbnailPath);
  if (!url) {
    url = convertFileSrc(thumbnailPath);

    // Simple LRU: delete oldest entry if cache is full
    if (urlCache.size >= MAX_CACHE_SIZE) {
      const firstKey = urlCache.keys().next().value;
      if (firstKey) urlCache.delete(firstKey);
    }

    urlCache.set(thumbnailPath, url);
  }

  return url;
}

/**
 * Prefetch thumbnails for captures that are about to enter the viewport.
 * Creates Image objects to trigger browser preloading.
 */
export function prefetchThumbnails(captures: CaptureListItem[]): void {
  for (const capture of captures) {
    if (capture.thumbnail_path && !capture.id.startsWith('temp_') && !capture.is_missing) {
      const url = getCachedThumbnailUrl(capture.thumbnail_path);
      if (url) {
        // Create Image object to trigger browser prefetch
        const img = new Image();
        img.src = url;
      }
    }
  }
}

interface VirtualRow {
  type: 'header' | 'cardRow';
  captures?: CaptureListItem[];
}

/**
 * Hook to prefetch thumbnails for upcoming rows in a virtualized list.
 * @param rows All rows in the virtualized list
 * @param visibleRange The range of currently visible row indices
 * @param prefetchRows Number of rows ahead to prefetch (default: 3)
 */
export function useThumbnailPrefetch(
  rows: VirtualRow[],
  visibleRange: { startIndex: number; endIndex: number },
  prefetchRows = 3
): void {
  const lastPrefetchedRef = useRef<number>(-1);

  useEffect(() => {
    const { endIndex } = visibleRange;

    // Only prefetch if we've scrolled past the last prefetched position
    if (endIndex <= lastPrefetchedRef.current) return;

    // Collect captures from upcoming rows
    const upcomingCaptures: CaptureListItem[] = [];
    const prefetchEnd = Math.min(endIndex + prefetchRows, rows.length);

    for (let i = endIndex + 1; i <= prefetchEnd; i++) {
      const row = rows[i];
      if (row?.type === 'cardRow' && row.captures) {
        upcomingCaptures.push(...row.captures);
      }
    }

    if (upcomingCaptures.length > 0) {
      // Prefetch in next idle callback to avoid blocking render
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => prefetchThumbnails(upcomingCaptures), { timeout: 100 });
      } else {
        setTimeout(() => prefetchThumbnails(upcomingCaptures), 0);
      }
      lastPrefetchedRef.current = prefetchEnd;
    }
  }, [rows, visibleRange, prefetchRows]);
}

/**
 * Hook to prefetch all visible thumbnails on initial load.
 * Call this once when the library first renders.
 */
export function useInitialThumbnailPrefetch(captures: CaptureListItem[], enabled: boolean): void {
  const prefetchedRef = useRef(false);

  useEffect(() => {
    if (!enabled || prefetchedRef.current || captures.length === 0) return;

    // Prefetch first batch of thumbnails (first ~20 items)
    const initialBatch = captures.slice(0, 20);

    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => {
        prefetchThumbnails(initialBatch);
        prefetchedRef.current = true;
      }, { timeout: 200 });
    } else {
      setTimeout(() => {
        prefetchThumbnails(initialBatch);
        prefetchedRef.current = true;
      }, 100);
    }
  }, [captures, enabled]);
}
