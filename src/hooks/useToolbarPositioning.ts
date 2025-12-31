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
}

export function useToolbarPositioning({ contentRef }: UseToolbarPositioningOptions): void {
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

      const windowWidth = Math.ceil(width);
      const windowHeight = Math.ceil(height) + TITLEBAR_HEIGHT;

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

    // Watch for size changes
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          resizeWindow(width, height);
        }
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [contentRef]);
}
