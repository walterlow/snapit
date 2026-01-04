/**
 * useToolbarPositioning - Measures content and resizes window to fit.
 *
 * Measures the full container (including titlebar) for height,
 * and the content element for width. Uses ResizeObserver to track changes.
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toolbarLogger } from '@/utils/logger';

interface UseToolbarPositioningOptions {
  /** Ref to the full container (app-container) for height measurement */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Ref to the content element for width measurement */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Selection confirmed state - triggers remeasure when content swaps */
  selectionConfirmed?: boolean;
  /** Toolbar mode - triggers remeasure when mode changes (selection/recording/etc) */
  mode?: string;
}

export function useToolbarPositioning({ containerRef, contentRef, selectionConfirmed, mode }: UseToolbarPositioningOptions): void {
  const windowShownRef = useRef(false);
  const lastSizeRef = useRef({ width: 0, height: 0 });

  // Measure content and resize window
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const resizeWindow = async (width: number, height: number) => {
      // Skip if size hasn't changed
      if (width === lastSizeRef.current.width && height === lastSizeRef.current.height) {
        return;
      }
      lastSizeRef.current = { width, height };

      // Add 1px buffer to prevent sub-pixel rounding issues
      const windowWidth = Math.ceil(width) + 1;
      const windowHeight = Math.ceil(height) + 1;

      try {
        await invoke('resize_capture_toolbar', {
          width: windowWidth,
          height: windowHeight,
        });

        // Show window on first resize
        if (!windowShownRef.current) {
          const currentWindow = getCurrentWebviewWindow();
          await currentWindow.show();
          windowShownRef.current = true;
        }
      } catch (e) {
        toolbarLogger.error('Failed to resize toolbar:', e);
      }
    };

    // Initial measurement - use content width, container height (includes titlebar)
    const contentRect = content.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (contentRect.width > 0 && containerRect.height > 0) {
      resizeWindow(contentRect.width, containerRect.height);
    }

    // Watch for size changes on both elements
    const observer = new ResizeObserver(() => {
      const contentRect = content.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (contentRect.width > 0 && containerRect.height > 0) {
        resizeWindow(contentRect.width, containerRect.height);
      }
    });

    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [containerRef, contentRef]);

  // Force remeasure when selection state or mode changes (content swaps)
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    let cancelled = false;

    // Wait for React to render, then wait for browser paint
    requestAnimationFrame(() => {
      if (cancelled) return;
      // Double RAF to ensure paint is complete
      requestAnimationFrame(() => {
        if (cancelled) return;
        const contentRect = content.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (contentRect.width > 0 && containerRect.height > 0) {
          // Reset last size to force update
          lastSizeRef.current = { width: 0, height: 0 };
          // Trigger resize
          const windowWidth = Math.ceil(contentRect.width) + 1;
          const windowHeight = Math.ceil(containerRect.height) + 1;
          invoke('resize_capture_toolbar', { width: windowWidth, height: windowHeight }).catch((e) => toolbarLogger.error('Failed to resize toolbar:', e));
        }
      });
    });

    return () => { cancelled = true; };
  }, [selectionConfirmed, mode, containerRef, contentRef]);
}
