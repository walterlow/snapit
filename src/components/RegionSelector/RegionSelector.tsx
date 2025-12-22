import React, { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ScreenRegionSelection } from '../../types';

interface RegionSelectorProps {
  monitorIndex: number;
  monitorX: number;
  monitorY: number;
  monitorWidth: number;
  monitorHeight: number;
  scaleFactor: number;
}

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

// Shared selection in screen coordinates (for cross-monitor display)
interface SharedSelection {
  // Start point in screen coordinates (where drag began)
  startScreenX: number;
  startScreenY: number;
  // Current end point in screen coordinates
  endScreenX: number;
  endScreenY: number;
  originMonitor: number; // Which monitor started the selection
  isActive: boolean; // Is the drag still in progress?
}

interface WindowInfo {
  id: number;
  title: string;
  app_name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type CaptureMode = 'window' | 'region';

export const RegionSelector: React.FC<RegionSelectorProps> = ({
  monitorIndex,
  monitorX,
  monitorY,
  monitorWidth,
  monitorHeight,
  scaleFactor,
}) => {
  const [mode, setMode] = useState<CaptureMode>('window');
  const [isSelecting, setIsSelecting] = useState(false);
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [hoveredWindow, setHoveredWindow] = useState<WindowInfo | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [sharedSelection, setSharedSelection] = useState<SharedSelection | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastWindowDetectRef = useRef<number>(0);
  const windowDetectTimeoutRef = useRef<number | null>(null);

  // Calculate display rect from selection
  const getDisplayRect = useCallback(() => {
    if (!selection) return null;

    const x = Math.min(selection.startX, selection.endX);
    const y = Math.min(selection.startY, selection.endY);
    const width = Math.abs(selection.endX - selection.startX);
    const height = Math.abs(selection.endY - selection.startY);

    return { x, y, width, height };
  }, [selection]);

  // Detect window under cursor (throttled to 100ms to prevent excessive Tauri calls)
  const detectWindowAtPoint = useCallback((screenX: number, screenY: number) => {
    const now = Date.now();
    const THROTTLE_MS = 100;

    // Clear any pending timeout
    if (windowDetectTimeoutRef.current) {
      clearTimeout(windowDetectTimeoutRef.current);
      windowDetectTimeoutRef.current = null;
    }

    const timeSinceLastCall = now - lastWindowDetectRef.current;

    if (timeSinceLastCall >= THROTTLE_MS) {
      // Enough time passed, call immediately
      lastWindowDetectRef.current = now;
      invoke<WindowInfo | null>('get_window_at_point', { x: screenX, y: screenY })
        .then(setHoveredWindow)
        .catch(() => setHoveredWindow(null));
    } else {
      // Schedule a trailing call to ensure we get the final position
      windowDetectTimeoutRef.current = window.setTimeout(() => {
        lastWindowDetectRef.current = Date.now();
        invoke<WindowInfo | null>('get_window_at_point', { x: screenX, y: screenY })
          .then(setHoveredWindow)
          .catch(() => setHoveredWindow(null));
        windowDetectTimeoutRef.current = null;
      }, THROTTLE_MS - timeSinceLastCall);
    }
  }, []);

  // Handle pointer down - start selection or prepare for window capture
  const handlePointerDown = useCallback(async (e: React.PointerEvent) => {
    if (e.button !== 0) return; // Left click only

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    dragStartRef.current = { x, y };
    setIsSelecting(true);
    setSelection({
      startX: x,
      startY: y,
      endX: x,
      endY: y,
    });

    // Capture pointer to receive events even when cursor leaves window bounds
    // This is crucial for cross-monitor selection
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture not supported
    }

    // Tell other overlay windows to ignore cursor events so mouse can pass through
    // This enables dragging across monitors
    emit('set-cursor-passthrough', { originMonitor: monitorIndex, enable: true });
  }, [monitorIndex]);

  // Emit selection update to other overlays
  const emitSelectionUpdate = useCallback((sel: SelectionRect | null, active?: boolean) => {
    if (!sel) {
      emit('selection-update', null);
      return;
    }

    const shared: SharedSelection = {
      startScreenX: monitorX + sel.startX,
      startScreenY: monitorY + sel.startY,
      endScreenX: monitorX + sel.endX,
      endScreenY: monitorY + sel.endY,
      originMonitor: monitorIndex,
      isActive: active ?? true,
    };

    emit('selection-update', shared);
  }, [monitorX, monitorY, monitorIndex]);

  // Handle pointer move - update selection or detect windows
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const screenX = monitorX + x;
    const screenY = monitorY + y;

    setCursorPos({ x, y });

    // Check if we should pick up an active drag from another monitor
    // This handles the case where mouseenter didn't fire or wasn't detected
    if (!isSelecting && sharedSelection?.isActive && sharedSelection.originMonitor !== monitorIndex && e.buttons === 1) {
      // Left button is held and there's an active shared selection from another monitor
      const localStartX = sharedSelection.startScreenX - monitorX;
      const localStartY = sharedSelection.startScreenY - monitorY;

      setMode('region');
      setIsSelecting(true);
      setIsDragging(true);
      dragStartRef.current = { x: localStartX, y: localStartY };
      setSelection({
        startX: localStartX,
        startY: localStartY,
        endX: x,
        endY: y,
      });
      setSharedSelection(null);
      return;
    }

    if (isSelecting && selection && dragStartRef.current) {
      const dx = Math.abs(x - dragStartRef.current.x);
      const dy = Math.abs(y - dragStartRef.current.y);

      // If dragged more than 5px, switch to region mode
      if (dx > 5 || dy > 5) {
        setIsDragging(true);
        setMode('region');
        setHoveredWindow(null);
      }

      const newSelection = {
        ...selection,
        endX: x,
        endY: y,
      };
      setSelection(newSelection);

      // Share selection with other monitors
      if (isDragging) {
        emitSelectionUpdate(newSelection, true);
      }
    } else if (mode === 'window' && !isDragging) {
      // Detect window under cursor (throttled)
      detectWindowAtPoint(screenX, screenY);
    }
  }, [isSelecting, selection, mode, isDragging, monitorX, monitorY, sharedSelection, monitorIndex, detectWindowAtPoint, emitSelectionUpdate]);

  // Handle pointer up - complete selection or capture window
  const handlePointerUp = useCallback(async () => {
    // If we have a shared selection but no local selection, use the shared one
    if (!isSelecting && sharedSelection?.isActive) {
      // Calculate screen rect from shared selection
      const selLeft = Math.min(sharedSelection.startScreenX, sharedSelection.endScreenX);
      const selTop = Math.min(sharedSelection.startScreenY, sharedSelection.endScreenY);
      const width = Math.abs(sharedSelection.endScreenX - sharedSelection.startScreenX);
      const height = Math.abs(sharedSelection.endScreenY - sharedSelection.startScreenY);

      if (width < 10 || height < 10) {
        setSharedSelection(null);
        emitSelectionUpdate(null);
        return;
      }

      try {
        await invoke('move_overlays_offscreen');

        const screenSelection: ScreenRegionSelection = {
          x: selLeft,
          y: selTop,
          width: Math.round(width),
          height: Math.round(height),
        };

        const result = await invoke<{ file_path: string; width: number; height: number }>(
          'capture_screen_region_fast',
          { selection: screenSelection }
        );

        await invoke('open_editor_fast', {
          filePath: result.file_path,
          width: result.width,
          height: result.height,
        });
      } catch {
        await invoke('hide_overlay');
      }
      return;
    }

    if (!isSelecting) return;

    // Re-enable cursor events on all overlays (in case we had set passthrough during drag)
    emit('set-cursor-passthrough', { originMonitor: -1, enable: false });

    setIsSelecting(false);
    dragStartRef.current = null;

    // If we were in window mode and didn't drag, capture the window
    if (mode === 'window' && !isDragging && hoveredWindow) {
      try {
        // Move overlays off-screen first - Rust handles DWM compositor sync
        await invoke('move_overlays_offscreen');

        // Use fast capture (skips PNG encoding on Rust side)
        const result = await invoke<{ file_path: string; width: number; height: number }>(
          'capture_window_fast',
          { windowId: hoveredWindow.id }
        );

        await invoke('open_editor_fast', {
          filePath: result.file_path,
          width: result.width,
          height: result.height,
        });
      } catch {
        // Fallback to fullscreen with fast capture
        try {
          const result = await invoke<{ file_path: string; width: number; height: number }>(
            'capture_fullscreen_fast'
          );
          await invoke('open_editor_fast', {
            filePath: result.file_path,
            width: result.width,
            height: result.height,
          });
        } catch {
          await invoke('hide_overlay');
        }
      }
      return;
    }

    // If we were in window mode but no window detected, capture ALL monitors (full virtual desktop)
    if (mode === 'window' && !isDragging && !hoveredWindow) {
      try {
        // Move overlays off-screen first (instant, reliable)
        await invoke('move_overlays_offscreen');

        // Get all monitors to calculate full virtual desktop bounds
        const monitors = await invoke<Array<{
          x: number;
          y: number;
          width: number;
          height: number;
        }>>('get_monitors');

        if (monitors.length === 0) {
          await invoke('hide_overlay');
          return;
        }

        // Calculate bounding box of all monitors
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const mon of monitors) {
          minX = Math.min(minX, mon.x);
          minY = Math.min(minY, mon.y);
          maxX = Math.max(maxX, mon.x + mon.width);
          maxY = Math.max(maxY, mon.y + mon.height);
        }

        // Capture full virtual desktop using screen region (supports multi-monitor stitching)
        const screenSelection: ScreenRegionSelection = {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        };

        const result = await invoke<{ file_path: string; width: number; height: number }>(
          'capture_screen_region_fast',
          { selection: screenSelection }
        );

        await invoke('open_editor_fast', {
          filePath: result.file_path,
          width: result.width,
          height: result.height,
        });
      } catch (e) {
        console.error('Failed to capture all monitors:', e);
        await invoke('hide_overlay');
      }
      return;
    }

    // Region mode - check if selection is valid
    const displayRect = getDisplayRect();
    if (!displayRect || displayRect.width < 10 || displayRect.height < 10) {
      // Selection too small, reset
      setSelection(null);
      setIsDragging(false);
      setMode('window');
      emitSelectionUpdate(null); // Clear shared selection
      return;
    }

    try {
      // Move overlays off-screen first (instant, reliable)
      await invoke('move_overlays_offscreen');

      // Use screen region capture (supports multi-monitor stitching)
      const screenSelection: ScreenRegionSelection = {
        x: monitorX + displayRect.x,
        y: monitorY + displayRect.y,
        width: Math.round(displayRect.width),
        height: Math.round(displayRect.height),
      };

      const result = await invoke<{ file_path: string; width: number; height: number }>(
        'capture_screen_region_fast',
        { selection: screenSelection }
      );

      await invoke('open_editor_fast', {
        filePath: result.file_path,
        width: result.width,
        height: result.height,
      });
    } catch {
      await invoke('hide_overlay');
    }
  }, [isSelecting, selection, getDisplayRect, monitorX, monitorY, mode, isDragging, hoveredWindow, sharedSelection, emitSelectionUpdate]);

  // Handle pointer enter - pick up active drag from another monitor
  const handlePointerEnter = useCallback((e: React.PointerEvent) => {
    // If there's an active shared selection from another monitor AND mouse button is pressed, continue the drag here
    if (sharedSelection && sharedSelection.isActive && sharedSelection.originMonitor !== monitorIndex && e.buttons === 1) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Convert shared selection start point to this monitor's local coordinates
      const localStartX = sharedSelection.startScreenX - monitorX;
      const localStartY = sharedSelection.startScreenY - monitorY;

      // Continue the selection on this monitor
      setMode('region');
      setIsSelecting(true);
      setIsDragging(true);
      dragStartRef.current = { x: localStartX, y: localStartY };
      setSelection({
        startX: localStartX,
        startY: localStartY,
        endX: x,
        endY: y,
      });
      // Clear shared selection since we're now the active monitor
      setSharedSelection(null);
    }
  }, [sharedSelection, monitorIndex, monitorX, monitorY]);

  // Handle pointer leave - clear hovered window but DON'T cancel active drag
  const handlePointerLeave = useCallback(() => {
    // Clear any pending window detection
    if (windowDetectTimeoutRef.current) {
      clearTimeout(windowDetectTimeoutRef.current);
      windowDetectTimeoutRef.current = null;
    }
    setHoveredWindow(null);

    // If we're dragging a selection, DON'T cancel - let another monitor continue
    // The selection state stays intact, and we've already emitted it via events
    // Only cancel if we weren't actually dragging yet
    if (isSelecting && !isDragging) {
      setIsSelecting(false);
      dragStartRef.current = null;
      setSelection(null);
      setMode('window');
    }
    // If isDragging, keep state so we can resume if user comes back to this monitor
  }, [isSelecting, isDragging]);

  // Handle escape key to cancel
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        await invoke('hide_overlay');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Cleanup window detection timeout on unmount
  useEffect(() => {
    return () => {
      if (windowDetectTimeoutRef.current) {
        clearTimeout(windowDetectTimeoutRef.current);
      }
    };
  }, []);

  // Listen for cursor passthrough events - when another monitor starts dragging,
  // this monitor should allow cursor to pass through
  useEffect(() => {
    const unlisten = listen<{ originMonitor: number; enable: boolean }>('set-cursor-passthrough', async (event) => {
      const { originMonitor, enable } = event.payload;

      // originMonitor = -1 means apply to ALL monitors (reset case)
      // Otherwise only apply to OTHER monitors, not the one doing the dragging
      if (originMonitor === -1 || originMonitor !== monitorIndex) {
        try {
          const window = getCurrentWindow();
          await window.setIgnoreCursorEvents(enable);
        } catch {
          // Failed to set cursor passthrough
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [monitorIndex]);

  // Focus the window on mount
  useEffect(() => {
    const focusWindow = async () => {
      try {
        const window = getCurrentWindow();
        await window.setFocus();
      } catch {
        // Failed to focus window
      }
    };
    focusWindow();
  }, []);

  // Listen for reset-overlay event (when overlay is reused)
  useEffect(() => {
    const unlisten = listen('reset-overlay', async () => {
      // Reset all state for new capture session
      setMode('window');
      setIsSelecting(false);
      setSelection(null);
      setHoveredWindow(null);
      setIsDragging(false);
      setSharedSelection(null);
      dragStartRef.current = null;

      // Ensure cursor events are enabled for this window
      try {
        const window = getCurrentWindow();
        await window.setIgnoreCursorEvents(false);
      } catch (e) {
        console.error('Failed to reset cursor events:', e);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for selection updates from other monitors
  useEffect(() => {
    const unlisten = listen<SharedSelection | null>('selection-update', (event) => {
      const shared = event.payload;

      // Ignore updates from this monitor (we have our own local selection)
      if (shared && shared.originMonitor === monitorIndex) {
        setSharedSelection(null);
        return;
      }

      setSharedSelection(shared);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [monitorIndex]);

  // Calculate the portion of shared selection visible on this monitor
  const getSharedSelectionRect = useCallback(() => {
    if (!sharedSelection) return null;

    // Calculate bounding box from start/end points
    const selLeft = Math.min(sharedSelection.startScreenX, sharedSelection.endScreenX);
    const selTop = Math.min(sharedSelection.startScreenY, sharedSelection.endScreenY);
    const selRight = Math.max(sharedSelection.startScreenX, sharedSelection.endScreenX);
    const selBottom = Math.max(sharedSelection.startScreenY, sharedSelection.endScreenY);

    const monLeft = monitorX;
    const monTop = monitorY;
    const monRight = monitorX + monitorWidth;
    const monBottom = monitorY + monitorHeight;

    // Check for intersection
    if (selRight <= monLeft || selLeft >= monRight ||
        selBottom <= monTop || selTop >= monBottom) {
      return null; // No intersection
    }

    // Calculate visible portion relative to this monitor
    const visLeft = Math.max(selLeft, monLeft) - monitorX;
    const visTop = Math.max(selTop, monTop) - monitorY;
    const visRight = Math.min(selRight, monRight) - monitorX;
    const visBottom = Math.min(selBottom, monBottom) - monitorY;

    return {
      x: visLeft,
      y: visTop,
      width: visRight - visLeft,
      height: visBottom - visTop,
    };
  }, [sharedSelection, monitorX, monitorY, monitorWidth, monitorHeight]);

  const displayRect = getDisplayRect();

  // Calculate window highlight position relative to this monitor
  const getWindowHighlight = useCallback(() => {
    if (!hoveredWindow || mode !== 'window' || isDragging) return null;

    const relX = hoveredWindow.x - monitorX;
    const relY = hoveredWindow.y - monitorY;

    // Only show if window is visible on this monitor
    if (
      relX + hoveredWindow.width < 0 ||
      relY + hoveredWindow.height < 0 ||
      relX > monitorWidth ||
      relY > monitorHeight
    ) {
      return null;
    }

    return {
      x: Math.max(0, relX),
      y: Math.max(0, relY),
      width: Math.min(hoveredWindow.width, monitorWidth - Math.max(0, relX)),
      height: Math.min(hoveredWindow.height, monitorHeight - Math.max(0, relY)),
    };
  }, [hoveredWindow, mode, isDragging, monitorX, monitorY, monitorWidth, monitorHeight]);

  const windowHighlight = getWindowHighlight();

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 cursor-crosshair select-none"
      style={{
        width: monitorWidth,
        height: monitorHeight,
        backgroundColor: mode === 'window' && !isDragging ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.4)',
        touchAction: 'none', // Required for proper pointer capture
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {/* Window highlight mode */}
      {windowHighlight && mode === 'window' && !isDragging && (
        <>
          {/* Darken outside the window */}
          <div className="absolute inset-0 pointer-events-none">
            {/* Top */}
            <div
              className="absolute left-0 right-0 top-0 bg-black/40"
              style={{ height: Math.floor(windowHighlight.y) }}
            />
            {/* Bottom */}
            <div
              className="absolute left-0 right-0 bottom-0 bg-black/40"
              style={{ top: Math.floor(windowHighlight.y + windowHighlight.height) }}
            />
            {/* Left */}
            <div
              className="absolute left-0 bg-black/40"
              style={{
                top: Math.floor(windowHighlight.y) - 1,
                height: Math.ceil(windowHighlight.height) + 2,
                width: Math.floor(windowHighlight.x),
              }}
            />
            {/* Right */}
            <div
              className="absolute right-0 bg-black/40"
              style={{
                top: Math.floor(windowHighlight.y) - 1,
                height: Math.ceil(windowHighlight.height) + 2,
                left: Math.floor(windowHighlight.x + windowHighlight.width),
              }}
            />
          </div>

          {/* Window border highlight (outline doesn't affect size) */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: windowHighlight.x,
              top: windowHighlight.y,
              width: windowHighlight.width,
              height: windowHighlight.height,
              outline: '3px solid #F97066',
              outlineOffset: '-2px',
              boxShadow: 'inset 0 0 0 1px rgba(249, 112, 102, 0.5), 0 0 20px rgba(249, 112, 102, 0.3)',
            }}
          />

        </>
      )}

      {/* Crosshair guides - only show in region mode or when no window detected */}
      {!isSelecting && mode === 'region' && (
        <>
          {/* Horizontal line */}
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{
              top: cursorPos.y,
              height: '1px',
              backgroundImage: 'linear-gradient(to right, rgba(59, 130, 246, 0.5) 50%, transparent 50%)',
              backgroundSize: '8px 1px',
            }}
          />
          {/* Vertical line */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: cursorPos.x,
              width: '1px',
              backgroundImage: 'linear-gradient(to bottom, rgba(59, 130, 246, 0.5) 50%, transparent 50%)',
              backgroundSize: '1px 8px',
            }}
          />
        </>
      )}

      {/* Selection rectangle */}
      {displayRect && displayRect.width > 0 && displayRect.height > 0 && (
        <>
          {/* Dark overlay outside selection */}
          <div className="absolute inset-0 pointer-events-none">
            {/* Top */}
            <div
              className="absolute left-0 right-0 top-0 bg-black/60"
              style={{ height: Math.floor(displayRect.y) }}
            />
            {/* Bottom */}
            <div
              className="absolute left-0 right-0 bottom-0 bg-black/60"
              style={{ top: Math.floor(displayRect.y + displayRect.height) }}
            />
            {/* Left */}
            <div
              className="absolute left-0 bg-black/60"
              style={{
                top: Math.floor(displayRect.y) - 1,
                height: Math.ceil(displayRect.height) + 2,
                width: Math.floor(displayRect.x),
              }}
            />
            {/* Right */}
            <div
              className="absolute right-0 bg-black/60"
              style={{
                top: Math.floor(displayRect.y) - 1,
                height: Math.ceil(displayRect.height) + 2,
                left: Math.floor(displayRect.x + displayRect.width),
              }}
            />
          </div>

          {/* Selection border - premium blue accent (outline doesn't affect size) */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: displayRect.x,
              top: displayRect.y,
              width: displayRect.width,
              height: displayRect.height,
              outline: '2px solid #3B82F6',
              outlineOffset: '-1px',
              boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.3)',
            }}
          >
            {/* Corner handles - white circles with blue border */}
            <div 
              className="absolute rounded-full"
              style={{
                top: -6,
                left: -6,
                width: 12,
                height: 12,
                background: 'white',
                border: '2px solid #3B82F6',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
            <div 
              className="absolute rounded-full"
              style={{
                top: -6,
                right: -6,
                width: 12,
                height: 12,
                background: 'white',
                border: '2px solid #3B82F6',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
            <div 
              className="absolute rounded-full"
              style={{
                bottom: -6,
                left: -6,
                width: 12,
                height: 12,
                background: 'white',
                border: '2px solid #3B82F6',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
            <div 
              className="absolute rounded-full"
              style={{
                bottom: -6,
                right: -6,
                width: 12,
                height: 12,
                background: 'white',
                border: '2px solid #3B82F6',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />

            {/* Dimension badge - monospace glass style */}
            <div
              className="dimension-badge absolute left-1/2 transform -translate-x-1/2 whitespace-nowrap"
              style={{ bottom: -36 }}
            >
              {Math.round(displayRect.width * scaleFactor)} × {Math.round(displayRect.height * scaleFactor)}
            </div>
          </div>
        </>
      )}

      {/* Shared selection from other monitors - only shown when not selecting locally */}
      {!displayRect && (() => {
        const sharedRect = getSharedSelectionRect();
        if (!sharedRect || sharedRect.width <= 0 || sharedRect.height <= 0) return null;

        return (
          <>
            {/* Dark overlay outside shared selection */}
            <div className="absolute inset-0 pointer-events-none">
              {/* Top */}
              <div
                className="absolute left-0 right-0 top-0 bg-black/60"
                style={{ height: Math.floor(sharedRect.y) }}
              />
              {/* Bottom */}
              <div
                className="absolute left-0 right-0 bottom-0 bg-black/60"
                style={{ top: Math.floor(sharedRect.y + sharedRect.height) }}
              />
              {/* Left */}
              <div
                className="absolute left-0 bg-black/60"
                style={{
                  top: Math.floor(sharedRect.y) - 1,
                  height: Math.ceil(sharedRect.height) + 2,
                  width: Math.floor(sharedRect.x),
                }}
              />
              {/* Right */}
              <div
                className="absolute right-0 bg-black/60"
                style={{
                  top: Math.floor(sharedRect.y) - 1,
                  height: Math.ceil(sharedRect.height) + 2,
                  left: Math.floor(sharedRect.x + sharedRect.width),
                }}
              />
            </div>

            {/* Shared selection border - dashed to indicate it's from another monitor */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: sharedRect.x,
                top: sharedRect.y,
                width: sharedRect.width,
                height: sharedRect.height,
                outline: '2px solid #3B82F6',
                outlineOffset: '-1px',
                boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.3)',
              }}
            />
          </>
        );
      })()}

      {/* Instructions toast - dark glass effect for visibility */}
      <div
        className="absolute top-6 left-1/2 pointer-events-none"
        style={{
          transform: 'translateX(-50%)',
          padding: '12px 48px',
          borderRadius: '12px',
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
          fontSize: '13px',
          fontWeight: 500,
        }}
      >
        {mode === 'window' && !isDragging ? (
          <>
            <span style={{ color: '#ffffff' }}>
              {hoveredWindow ? 'Click to capture window' : 'Hover over a window'}
            </span>
            <span style={{ margin: '0 10px', color: 'rgba(255, 255, 255, 0.5)' }}>•</span>
            <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Drag to select region</span>
            <span style={{ margin: '0 10px', color: 'rgba(255, 255, 255, 0.5)' }}>•</span>
            <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>ESC to cancel</span>
          </>
        ) : (
          <>
            <span style={{ color: '#ffffff' }}>Drag to select region</span>
            <span style={{ margin: '0 10px', color: 'rgba(255, 255, 255, 0.5)' }}>•</span>
            <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>ESC to cancel</span>
          </>
        )}
      </div>
    </div>
  );
};
