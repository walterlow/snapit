import React, { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ScreenRegionSelection, CaptureType, RecordingMode } from '../../types';
import { useVideoRecordingStore } from '../../stores/videoRecordingStore';
import { CountdownOverlay } from './CountdownOverlay';
import { RecordingToolbar } from './RecordingToolbar';

// Confirmed region for video/gif recording (screen coordinates)
interface ConfirmedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  // For window captures
  windowId?: number;
}

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
  const [isMouseOnMonitor, setIsMouseOnMonitor] = useState(false);
  const [hoveredWindow, setHoveredWindow] = useState<WindowInfo | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [sharedSelection, setSharedSelection] = useState<SharedSelection | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastWindowDetectRef = useRef<number>(0);
  const windowDetectTimeoutRef = useRef<number | null>(null);

  // Video/GIF recording state
  const [captureType, setCaptureType] = useState<CaptureType>('screenshot');
  const [showCountdown, setShowCountdown] = useState(false);
  const [countdownCenter, setCountdownCenter] = useState<{ x: number; y: number } | null>(null);
  const pendingRecordingRef = useRef<RecordingMode | null>(null);
  const pendingRegionRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  
  // Confirmed region - shows toolbar before recording starts (in video/gif mode)
  const [confirmedRegion, setConfirmedRegion] = useState<ConfirmedRegion | null>(null);

  // Video recording store - only use actions, not state
  // Recording state is owned by Rust backend, not frontend
  const {
    settings: recordingSettings,
    initialize: initializeRecording,
    startRecording,
    setFormat,
    setMode: setRecordingMode,
    setCountdown,
    toggleCursor,
    resetToIdle,
  } = useVideoRecordingStore();

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

    const doDetect = () => {
      // Pass monitor index to Rust - it will track which monitor is active
      // and return None if a different monitor has since made a request
      invoke<WindowInfo | null>('get_window_at_point', { x: screenX, y: screenY, monitorIndex })
        .then(setHoveredWindow)
        .catch(() => setHoveredWindow(null));
    };

    if (timeSinceLastCall >= THROTTLE_MS) {
      // Enough time passed, call immediately
      lastWindowDetectRef.current = now;
      doDetect();
    } else {
      // Schedule a trailing call to ensure we get the final position
      windowDetectTimeoutRef.current = window.setTimeout(() => {
        lastWindowDetectRef.current = Date.now();
        doDetect();
        windowDetectTimeoutRef.current = null;
      }, THROTTLE_MS - timeSinceLastCall);
    }
  }, [monitorIndex]);

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

  // Helper to capture screenshot (existing behavior)
  const captureScreenshot = useCallback(async (screenSelection: ScreenRegionSelection) => {
    try {
      await invoke('move_overlays_offscreen');
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
  }, []);

  // Helper to start recording with countdown
  const initiateRecording = useCallback((
    recordingMode: RecordingMode,
    regionX: number,
    regionY: number,
    regionWidth: number,
    regionHeight: number
  ) => {
    // Set format based on capture type
    setFormat(captureType === 'gif' ? 'gif' : 'mp4');
    setRecordingMode(recordingMode);
    
    // Store the pending recording mode and region for controls positioning
    pendingRecordingRef.current = recordingMode;
    pendingRegionRef.current = { x: regionX, y: regionY, width: regionWidth, height: regionHeight };
    
    // Set countdown center position (relative to this monitor)
    const centerX = regionX + regionWidth / 2;
    const centerY = regionY + regionHeight / 2;
    setCountdownCenter({ x: centerX - monitorX, y: centerY - monitorY });
    
    // Show countdown
    setShowCountdown(true);
  }, [captureType, setFormat, setRecordingMode, monitorX, monitorY]);

  // Handle countdown completion - actually start recording
  const handleCountdownComplete = useCallback(async () => {
    setShowCountdown(false);
    
    const recordingMode = pendingRecordingRef.current;
    const region = pendingRegionRef.current;
    if (!recordingMode) return;
    
    pendingRecordingRef.current = null;
    pendingRegionRef.current = null;
    
    // Show the recording controls window at bottom-center of the region
    if (region) {
      await invoke('show_recording_controls', {
        x: region.x,
        y: region.y + region.height,
        regionWidth: region.width,
      });
      
      // Show the recording border around the region
      await invoke('show_recording_border', {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      });
    } else {
      await invoke('show_recording_controls', {});
    }
    
    // Hide the overlay WITHOUT restoring main window (will restore when recording completes)
    await invoke('hide_overlay', { restoreMainWindow: false });
    
    // Set countdown to 0 since we already did the countdown in the frontend
    setCountdown(0);
    
    // Start the actual recording
    const success = await startRecording(recordingMode);
    if (!success) {
      console.error('Failed to start recording');
      await invoke('hide_recording_controls');
      await invoke('hide_recording_border');
      // Restore main window on failure
      await invoke('restore_main_window');
    }
  }, [startRecording, setCountdown]);

  // Handle countdown cancel
  const handleCountdownCancel = useCallback(() => {
    setShowCountdown(false);
    pendingRecordingRef.current = null;
    setCountdownCenter(null);
  }, []);

  // Handle Record button from toolbar - starts recording with countdown
  const handleToolbarRecord = useCallback(() => {
    if (!confirmedRegion) return;
    
    const recordingMode: RecordingMode = confirmedRegion.windowId
      ? { type: 'window', windowId: confirmedRegion.windowId }
      : {
          type: 'region',
          x: confirmedRegion.x,
          y: confirmedRegion.y,
          width: confirmedRegion.width,
          height: confirmedRegion.height,
        };
    
    // Clear the confirmed region since we're starting
    setConfirmedRegion(null);
    
    initiateRecording(
      recordingMode,
      confirmedRegion.x,
      confirmedRegion.y,
      confirmedRegion.width,
      confirmedRegion.height
    );
  }, [confirmedRegion, initiateRecording]);

  // Handle Screenshot button from toolbar - take screenshot instead of recording
  const handleToolbarScreenshot = useCallback(async () => {
    if (!confirmedRegion) return;
    
    const screenSelection: ScreenRegionSelection = {
      x: confirmedRegion.x,
      y: confirmedRegion.y,
      width: confirmedRegion.width,
      height: confirmedRegion.height,
    };
    
    setConfirmedRegion(null);
    await captureScreenshot(screenSelection);
  }, [confirmedRegion, captureScreenshot]);

  // Handle Redo button from toolbar - redraw the region
  const handleToolbarRedo = useCallback(() => {
    setConfirmedRegion(null);
    setSelection(null);
    setSharedSelection(null);
    setIsDragging(false);
    setIsSelecting(false);
    setMode('window');
    // Clear selection on other monitors
    emitSelectionUpdate(null);
  }, [emitSelectionUpdate]);

  // Handle Cancel button from toolbar - close overlay
  const handleToolbarCancel = useCallback(async () => {
    // Clear all visual state immediately
    setConfirmedRegion(null);
    setSelection(null);
    setIsDragging(false);
    setMode('window');
    await invoke('hide_overlay');
  }, []);

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

      const screenSelection: ScreenRegionSelection = {
        x: selLeft,
        y: selTop,
        width: Math.round(width),
        height: Math.round(height),
      };

      if (captureType === 'screenshot') {
        await captureScreenshot(screenSelection);
      } else {
        // Video/GIF - show toolbar and wait for user to click Record
        setConfirmedRegion({
          x: selLeft,
          y: selTop,
          width: Math.round(width),
          height: Math.round(height),
        });
        setSelection(null); // Clear selection to avoid showing both borders
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
      if (captureType === 'screenshot') {
        try {
          await invoke('move_overlays_offscreen');
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
      } else {
        // Video/GIF - show toolbar and wait for user to click Record
        setConfirmedRegion({
          x: hoveredWindow.x,
          y: hoveredWindow.y,
          width: hoveredWindow.width,
          height: hoveredWindow.height,
          windowId: hoveredWindow.id,
        });
        setSelection(null); // Clear selection to avoid showing both borders
      }
      return;
    }

    // If we were in window mode but no window detected, capture current monitor only
    if (mode === 'window' && !isDragging && !hoveredWindow) {
      const screenSelection: ScreenRegionSelection = {
        x: monitorX,
        y: monitorY,
        width: monitorWidth,
        height: monitorHeight,
      };

      if (captureType === 'screenshot') {
        await captureScreenshot(screenSelection);
      } else {
        // Video/GIF - show toolbar and wait for user to click Record
        setConfirmedRegion({
          x: monitorX,
          y: monitorY,
          width: monitorWidth,
          height: monitorHeight,
        });
        setSelection(null); // Clear selection to avoid showing both borders
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
      emitSelectionUpdate(null);
      return;
    }

    const screenSelection: ScreenRegionSelection = {
      x: monitorX + displayRect.x,
      y: monitorY + displayRect.y,
      width: Math.round(displayRect.width),
      height: Math.round(displayRect.height),
    };

    if (captureType === 'screenshot') {
      await captureScreenshot(screenSelection);
    } else {
      // Video/GIF - show toolbar and wait for user to click Record
      setConfirmedRegion({
        x: screenSelection.x,
        y: screenSelection.y,
        width: screenSelection.width,
        height: screenSelection.height,
      });
      setSelection(null); // Clear selection to avoid showing both borders
    }
  }, [isSelecting, selection, getDisplayRect, monitorX, monitorY, monitorWidth, monitorHeight, mode, isDragging, hoveredWindow, sharedSelection, emitSelectionUpdate, captureType, captureScreenshot, monitorIndex]);

  // Handle pointer enter - pick up active drag from another monitor
  const handlePointerEnter = useCallback((e: React.PointerEvent) => {
    setIsMouseOnMonitor(true);
    
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
    setIsMouseOnMonitor(false);
    
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

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCountdown) {
          // Cancel countdown
          setShowCountdown(false);
          pendingRecordingRef.current = null;
        } else if (confirmedRegion) {
          // Cancel confirmed region, go back to selection mode
          setConfirmedRegion(null);
          setSelection(null);
          setIsDragging(false);
          setMode('window');
        } else {
          await invoke('hide_overlay');
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCountdown, confirmedRegion]);

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

  // Listen for clear-hovered-window events from Rust
  // When another monitor becomes active, Rust tells us to clear our hovered window
  useEffect(() => {
    const unlisten = listen<number>('clear-hovered-window', (event) => {
      const targetMonitor = event.payload;

      // Clear if this event is targeting our monitor
      if (targetMonitor === monitorIndex) {
        if (windowDetectTimeoutRef.current) {
          clearTimeout(windowDetectTimeoutRef.current);
          windowDetectTimeoutRef.current = null;
        }
        setHoveredWindow(null);
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

  // Initialize video recording store on mount
  useEffect(() => {
    initializeRecording();
  }, [initializeRecording]);

  // Listen for reset-overlay event (when overlay is reused)
  useEffect(() => {
    const unlisten = listen<{ captureType?: string } | null>('reset-overlay', async (event) => {
      // Reset all state for new capture session
      setMode('window');
      setIsSelecting(false);
      setSelection(null);
      setHoveredWindow(null);
      setIsDragging(false);
      setSharedSelection(null);
      setConfirmedRegion(null);
      dragStartRef.current = null;

      // Reset recording state to idle (in case previous recording didn't clean up)
      resetToIdle();

      // Set capture type from event payload (default to screenshot)
      const payload = event.payload;
      if (payload?.captureType) {
        const ct = payload.captureType as CaptureType;
        setCaptureType(ct);
        if (ct === 'video') setFormat('mp4');
        else if (ct === 'gif') setFormat('gif');
      } else {
        setCaptureType('screenshot');
      }

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
  }, [setFormat, resetToIdle]);

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

  // Calculate the portion of confirmed region visible on this monitor
  const getConfirmedRegionRect = useCallback(() => {
    if (!confirmedRegion) return null;

    const regLeft = confirmedRegion.x;
    const regTop = confirmedRegion.y;
    const regRight = confirmedRegion.x + confirmedRegion.width;
    const regBottom = confirmedRegion.y + confirmedRegion.height;

    const monLeft = monitorX;
    const monTop = monitorY;
    const monRight = monitorX + monitorWidth;
    const monBottom = monitorY + monitorHeight;

    // Check for intersection
    if (regRight <= monLeft || regLeft >= monRight ||
        regBottom <= monTop || regTop >= monBottom) {
      return null; // No intersection
    }

    // Calculate visible portion relative to this monitor
    return {
      x: Math.max(regLeft, monLeft) - monitorX,
      y: Math.max(regTop, monTop) - monitorY,
      width: Math.min(regRight, monRight) - Math.max(regLeft, monLeft),
      height: Math.min(regBottom, monBottom) - Math.max(regTop, monTop),
    };
  }, [confirmedRegion, monitorX, monitorY, monitorWidth, monitorHeight]);

  const confirmedRect = getConfirmedRegionRect();

  // Check if toolbar should appear on this monitor (toolbar at bottom-center of region)
  const shouldShowToolbar = confirmedRegion && (() => {
    const toolbarY = confirmedRegion.y + confirmedRegion.height + 16;
    const toolbarCenterX = confirmedRegion.x + confirmedRegion.width / 2;
    // Show toolbar on this monitor if the toolbar position is within this monitor
    return toolbarCenterX >= monitorX && toolbarCenterX < monitorX + monitorWidth &&
           toolbarY >= monitorY && toolbarY < monitorY + monitorHeight;
  })();

  // For video/gif mode, check if we need different handling
  const isVideoOrGifMode = captureType === 'video' || captureType === 'gif';
  
  // Determine background color based on mode
  // With DWM-based transparency, we can use transparent backgrounds for video/gif
  // that work properly with hardware-accelerated video
  const getBackgroundColor = () => {
    if (isVideoOrGifMode) {
      // Transparent for video/gif - DWM handles this without WS_EX_LAYERED blackout
      return 'transparent';
    }
    // Normal dimming for screenshots
    return mode === 'window' && !isDragging ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.4)';
  };

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 select-none ${showCountdown ? 'cursor-default' : 'cursor-crosshair'}`}
      style={{
        width: monitorWidth,
        height: monitorHeight,
        backgroundColor: getBackgroundColor(),
        touchAction: 'none', // Required for proper pointer capture
      }}
      onPointerDown={showCountdown ? undefined : handlePointerDown}
      onPointerMove={showCountdown ? undefined : handlePointerMove}
      onPointerUp={showCountdown ? undefined : handlePointerUp}
      onPointerEnter={showCountdown ? undefined : handlePointerEnter}
      onPointerLeave={showCountdown ? undefined : handlePointerLeave}
    >
      {/* Window highlight mode with darkening */}
      {windowHighlight && mode === 'window' && !isDragging && !confirmedRegion && (
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

      {/* Crosshair guides - show during selection phase for video/gif mode (no dimming), or in region mode for screenshots */}
      {/* Only show on the monitor where the mouse currently is */}
      {!isSelecting && !confirmedRegion && !showCountdown && isMouseOnMonitor && (isVideoOrGifMode || mode === 'region') && (
        <>
          {/* Horizontal line */}
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{
              top: cursorPos.y,
              height: '1px',
              backgroundImage: isVideoOrGifMode 
                ? 'linear-gradient(to right, rgba(249, 112, 102, 0.7) 50%, transparent 50%)'
                : 'linear-gradient(to right, rgba(59, 130, 246, 0.5) 50%, transparent 50%)',
              backgroundSize: '8px 1px',
            }}
          />
          {/* Vertical line */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: cursorPos.x,
              width: '1px',
              backgroundImage: isVideoOrGifMode
                ? 'linear-gradient(to bottom, rgba(249, 112, 102, 0.7) 50%, transparent 50%)'
                : 'linear-gradient(to bottom, rgba(59, 130, 246, 0.5) 50%, transparent 50%)',
              backgroundSize: '1px 8px',
            }}
          />
        </>
      )}

      {/* Selection rectangle - hide when we have a confirmed region (video/gif mode) */}
      {displayRect && displayRect.width > 0 && displayRect.height > 0 && !confirmedRegion && (
        <>
          {/* Dark overlay outside selection - only for screenshots, not video/gif */}
          {!isVideoOrGifMode && (
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
          )}

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
            {/* Dark overlay outside shared selection - only for screenshots */}
            {!isVideoOrGifMode && (
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
            )}

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
                boxShadow: isVideoOrGifMode 
                  ? '0 0 20px rgba(59, 130, 246, 0.5), 0 0 40px rgba(59, 130, 246, 0.3)'
                  : 'inset 0 0 0 1px rgba(59, 130, 246, 0.3)',
              }}
            />
          </>
        );
      })()}

      {/* Confirmed region for video/gif - shows dashed border and toolbar */}
      {confirmedRect && confirmedRect.width > 0 && confirmedRect.height > 0 && !showCountdown && (
        <>
          {/* Confirmed region border - dashed yellow/orange like Snagit */}
          {/* No darkening overlay for video/gif mode to avoid blacking out hardware-accelerated video */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: confirmedRect.x,
              top: confirmedRect.y,
              width: confirmedRect.width,
              height: confirmedRect.height,
              border: '3px dashed #F59E0B',
              boxShadow: '0 0 20px rgba(245, 158, 11, 0.5), 0 0 40px rgba(245, 158, 11, 0.3)',
            }}
          >
            {/* Corner handles - white circles with yellow border */}
            <div 
              className="absolute rounded-full"
              style={{
                top: -7,
                left: -7,
                width: 14,
                height: 14,
                background: 'white',
                border: '3px solid #F59E0B',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
            <div 
              className="absolute rounded-full"
              style={{
                top: -7,
                right: -7,
                width: 14,
                height: 14,
                background: 'white',
                border: '3px solid #F59E0B',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
            <div 
              className="absolute rounded-full"
              style={{
                bottom: -7,
                left: -7,
                width: 14,
                height: 14,
                background: 'white',
                border: '3px solid #F59E0B',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
            <div 
              className="absolute rounded-full"
              style={{
                bottom: -7,
                right: -7,
                width: 14,
                height: 14,
                background: 'white',
                border: '3px solid #F59E0B',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
              }}
            />
          </div>
        </>
      )}

      {/* Recording toolbar - shown at bottom-center of confirmed region (before recording starts) */}
      {shouldShowToolbar && confirmedRegion && !showCountdown && (
        <div
          className="absolute pointer-events-auto"
          style={{
            left: confirmedRegion.x - monitorX + confirmedRegion.width / 2,
            top: confirmedRegion.y - monitorY + confirmedRegion.height + 16,
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <RecordingToolbar
            captureType={captureType}
            width={confirmedRegion.width}
            height={confirmedRegion.height}
            includeCursor={recordingSettings.includeCursor}
            onToggleCursor={toggleCursor}
            onRecord={handleToolbarRecord}
            onScreenshot={handleToolbarScreenshot}
            onRedo={handleToolbarRedo}
            onCancel={handleToolbarCancel}
          />
        </div>
      )}

      {/* Instructions toast - dark glass effect for visibility */}
      {!showCountdown && !confirmedRegion && (
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
                {hoveredWindow
                  ? `Click to ${captureType === 'screenshot' ? 'capture' : 'record'} window`
                  : `Click for fullscreen ${captureType === 'screenshot' ? 'capture' : 'recording'}`}
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
      )}

      {/* Countdown overlay */}
      <CountdownOverlay
        visible={showCountdown}
        initialCount={recordingSettings.countdownSecs}
        centerX={countdownCenter?.x}
        centerY={countdownCenter?.y}
        onComplete={handleCountdownComplete}
        onCancel={handleCountdownCancel}
      />
    </div>
  );
};
