/**
 * useToolbarPositioning - Measures content and resizes window to fit.
 *
 * The content has a fixed size, window resizes to match.
 * Uses ResizeObserver to track content size changes.
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

const TITLEBAR_HEIGHT = 41; // 40px height + 1px border-bottom (see styles.css .titlebar)

interface UseToolbarPositioningOptions {
  /** Ref to the content element for measurement */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Selection confirmed state - triggers remeasure when content swaps */
  selectionConfirmed?: boolean;
}

export function useToolbarPositioning({ contentRef, selectionConfirmed }: UseToolbarPositioningOptions): void {
  const windowShownRef = useRef(false);
  const lastSizeRef = useRef({ width: 0, height: 0 });

  // Measure content and resize window
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const resizeWindow = async (width: number, height: number) => {
      // Skip if size hasn't changed
      if (width === lastSizeRef.current.width && height === lastSizeRef.current.height) {
        return;
      }
      lastSizeRef.current = { width, height };

      // Add 1px buffer to prevent sub-pixel rounding issues
      const windowWidth = Math.ceil(width) + 1;
      const windowHeight = Math.ceil(height) + TITLEBAR_HEIGHT + 1;

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
        console.error('Failed to resize toolbar:', e);
      }
    };

    // Initial measurement
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      resizeWindow(rect.width, rect.height);
    }

    // Watch for size changes - use getBoundingClientRect for accurate dimensions
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        resizeWindow(rect.width, rect.height);
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [contentRef]);

  // Force remeasure when selection state changes (content swaps)
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    let cancelled = false;

    // Wait for React to render, then wait for browser paint
    requestAnimationFrame(() => {
      if (cancelled) return;
      // Double RAF to ensure paint is complete
      requestAnimationFrame(() => {
        if (cancelled) return;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Reset last size to force update
          lastSizeRef.current = { width: 0, height: 0 };
          // Trigger resize
          const windowWidth = Math.ceil(rect.width) + 1;
          const windowHeight = Math.ceil(rect.height) + TITLEBAR_HEIGHT + 1;
          invoke('resize_capture_toolbar', { width: windowWidth, height: windowHeight }).catch(console.error);
        }
      });
    });

    return () => { cancelled = true; };
  }, [selectionConfirmed, contentRef]);
}
