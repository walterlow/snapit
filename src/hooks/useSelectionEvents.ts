/**
 * useSelectionEvents - Listens for selection updates from the capture overlay.
 *
 * Handles:
 * - selection-updated: Region bounds changed (resize/move)
 * - confirm-selection: User confirmed selection (from preselection flow)
 */

import { useEffect, useState, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, type Monitor } from '@tauri-apps/api/window';

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source type: 'area', 'window', or 'display' */
  sourceType?: 'area' | 'window' | 'display';
  /** Window ID (HWND) if sourceType is 'window' */
  windowId?: number | null;
  /** Window/app title if sourceType is 'window' */
  sourceTitle?: string | null;
  /** Monitor name if sourceType is 'display' */
  monitorName?: string | null;
  /** Monitor index if sourceType is 'display' */
  monitorIndex?: number | null;
}

/** Default bounds (no selection) */
const DEFAULT_BOUNDS: SelectionBounds = { x: 0, y: 0, width: 0, height: 0 };

interface UseSelectionEventsReturn {
  /** Current selection bounds */
  selectionBounds: SelectionBounds;
  /** Ref for synchronous access to bounds */
  selectionBoundsRef: React.MutableRefObject<SelectionBounds>;
  /** Whether selection has been confirmed (shows record button) */
  selectionConfirmed: boolean;
  /** Set selection confirmed state */
  setSelectionConfirmed: (confirmed: boolean) => void;
}


const MARGIN = 8;

/**
 * Calculate and apply toolbar position based on selection bounds.
 * Positions toolbar below selection (preferred) or above if doesn't fit.
 */
async function repositionToolbar(selection: SelectionBounds): Promise<void> {
  // Get actual window size
  const currentWindow = getCurrentWebviewWindow();
  const outerSize = await currentWindow.outerSize();
  const toolbarWidth = outerSize.width;
  const toolbarHeight = outerSize.height;

  const monitors = await availableMonitors();
  const selectionCenterX = selection.x + selection.width / 2;
  const selectionCenterY = selection.y + selection.height / 2;

  // Find monitor containing selection center
  const currentMonitor = monitors.find((m: Monitor) => {
    const pos = m.position;
    const size = m.size;
    return (
      selectionCenterX >= pos.x &&
      selectionCenterX < pos.x + size.width &&
      selectionCenterY >= pos.y &&
      selectionCenterY < pos.y + size.height
    );
  });

  const centeredX = Math.floor(selectionCenterX - toolbarWidth / 2);
  const belowY = selection.y + selection.height + MARGIN;
  const aboveY = selection.y - toolbarHeight - MARGIN;

  const fitsInMonitor = (x: number, y: number, monitor: Monitor): boolean => {
    const pos = monitor.position;
    const size = monitor.size;
    return (
      x >= pos.x + MARGIN &&
      x + toolbarWidth <= pos.x + size.width - MARGIN &&
      y >= pos.y + MARGIN &&
      y + toolbarHeight <= pos.y + size.height - MARGIN
    );
  };

  const clampToMonitor = (x: number, y: number, monitor: Monitor): { x: number; y: number } => {
    const pos = monitor.position;
    const size = monitor.size;
    return {
      x: Math.max(pos.x + MARGIN, Math.min(x, pos.x + size.width - MARGIN - toolbarWidth)),
      y: Math.max(pos.y + MARGIN, Math.min(y, pos.y + size.height - MARGIN - toolbarHeight)),
    };
  };

  let finalPos = { x: centeredX, y: belowY };

  if (currentMonitor) {
    if (fitsInMonitor(centeredX, belowY, currentMonitor)) {
      finalPos = { x: centeredX, y: belowY };
    } else if (fitsInMonitor(centeredX, aboveY, currentMonitor)) {
      finalPos = { x: centeredX, y: aboveY };
    } else {
      finalPos = clampToMonitor(centeredX, belowY, currentMonitor);
    }
  } else if (monitors.length > 0) {
    finalPos = clampToMonitor(centeredX, belowY, monitors[0]);
  }

  // Update position via Rust (size is handled by useToolbarPositioning)
  await invoke('set_capture_toolbar_position', {
    x: finalPos.x,
    y: finalPos.y,
  });
}

export function useSelectionEvents(): UseSelectionEventsReturn {
  // Always start with no selection (startup state)
  const [selectionBounds, setSelectionBounds] = useState<SelectionBounds>(DEFAULT_BOUNDS);
  const selectionBoundsRef = useRef<SelectionBounds>(DEFAULT_BOUNDS);

  // Selection confirmed state - starts false (startup mode)
  const [selectionConfirmed, setSelectionConfirmed] = useState(false);

  // Listen for selection updates (bounds changes during drag/resize)
  useEffect(() => {
    let unlistenSelection: UnlistenFn | null = null;

    const setup = async () => {
      unlistenSelection = await listen<SelectionBounds>('selection-updated', (event) => {
        const bounds = event.payload;
        setSelectionBounds(bounds);
        selectionBoundsRef.current = bounds;
      });
    };

    setup();

    return () => {
      unlistenSelection?.();
    };
  }, []);

  // Listen for selection confirmation (from preselection flow or new selection)
  useEffect(() => {
    let unlistenConfirm: UnlistenFn | null = null;
    let unlistenReset: UnlistenFn | null = null;

    const setup = async () => {
      // Selection confirmed (from overlay) - repositions toolbar
      unlistenConfirm = await listen<SelectionBounds>('confirm-selection', async (event) => {
        const bounds = event.payload;
        setSelectionBounds(bounds);
        selectionBoundsRef.current = bounds;
        setSelectionConfirmed(true);

        // Wait for React to re-render and resize hook to run, then reposition
        // This ensures the window size is updated AFTER DimensionSelect renders
        await new Promise(resolve => setTimeout(resolve, 200));

        // Reposition toolbar for the new selection
        try {
          await repositionToolbar(bounds);
        } catch (e) {
          console.error('Failed to reposition toolbar:', e);
        }
      });

      // Reset to startup state (overlay cancelled)
      unlistenReset = await listen('reset-to-startup', () => {
        setSelectionConfirmed(false);
        setSelectionBounds({ x: 0, y: 0, width: 0, height: 0 });
        selectionBoundsRef.current = { x: 0, y: 0, width: 0, height: 0 };
      });
    };

    setup();

    return () => {
      unlistenConfirm?.();
      unlistenReset?.();
    };
  }, []);

  return {
    selectionBounds,
    selectionBoundsRef,
    selectionConfirmed,
    setSelectionConfirmed,
  };
}
