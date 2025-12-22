import React, { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // Calculate display rect from selection
  const getDisplayRect = useCallback(() => {
    if (!selection) return null;

    const x = Math.min(selection.startX, selection.endX);
    const y = Math.min(selection.startY, selection.endY);
    const width = Math.abs(selection.endX - selection.startX);
    const height = Math.abs(selection.endY - selection.startY);

    return { x, y, width, height };
  }, [selection]);

  // Detect window under cursor
  const detectWindowAtPoint = useCallback(async (screenX: number, screenY: number) => {
    try {
      const windowInfo = await invoke<WindowInfo | null>('get_window_at_point', {
        x: screenX,
        y: screenY,
      });
      setHoveredWindow(windowInfo);
    } catch {
      setHoveredWindow(null);
    }
  }, []);

  // Handle mouse down - start selection or prepare for window capture
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
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
  }, []);

  // Handle mouse move - update selection or detect windows
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const screenX = monitorX + x;
    const screenY = monitorY + y;

    setCursorPos({ x, y });

    if (isSelecting && selection && dragStartRef.current) {
      const dx = Math.abs(x - dragStartRef.current.x);
      const dy = Math.abs(y - dragStartRef.current.y);

      // If dragged more than 5px, switch to region mode
      if (dx > 5 || dy > 5) {
        setIsDragging(true);
        setMode('region');
        setHoveredWindow(null);
      }

      setSelection({
        ...selection,
        endX: x,
        endY: y,
      });
    } else if (mode === 'window' && !isDragging) {
      // Detect window under cursor (throttled)
      detectWindowAtPoint(screenX, screenY);
    }
  }, [isSelecting, selection, mode, isDragging, monitorX, monitorY, detectWindowAtPoint]);

  // Handle mouse up - complete selection or capture window
  const handleMouseUp = useCallback(async () => {
    if (!isSelecting) return;

    setIsSelecting(false);
    dragStartRef.current = null;

    // If we were in window mode and didn't drag, capture the window
    if (mode === 'window' && !isDragging && hoveredWindow) {
      try {
        // Move overlays off-screen first - needed for screen-crop fallback
        await invoke('move_overlays_offscreen');
        // Small delay to ensure overlay is moved
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const result = await invoke<{ image_data: string; width: number; height: number }>(
          'capture_window',
          { windowId: hoveredWindow.id }
        );
        await invoke('open_editor', { imageData: result.image_data });
      } catch {
        // Fallback to fullscreen
        try {
          const result = await invoke<{ image_data: string; width: number; height: number }>(
            'capture_fullscreen'
          );
          await invoke('open_editor', { imageData: result.image_data });
        } catch {
          await invoke('hide_overlay');
        }
      }
      return;
    }

    // If we were in window mode but no window detected, capture fullscreen
    if (mode === 'window' && !isDragging && !hoveredWindow) {
      try {
        // Move overlays off-screen first (instant, reliable)
        await invoke('move_overlays_offscreen');
        
        const result = await invoke<{ image_data: string; width: number; height: number }>(
          'capture_fullscreen'
        );
        await invoke('open_editor', { imageData: result.image_data });
      } catch {
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
      return;
    }

    try {
      // Move overlays off-screen first (instant, reliable)
      await invoke('move_overlays_offscreen');

      // Now capture the region
      const result = await invoke<{ image_data: string; width: number; height: number }>(
        'capture_region',
        {
          selection: {
            x: monitorX + displayRect.x,
            y: monitorY + displayRect.y,
            width: Math.round(displayRect.width),
            height: Math.round(displayRect.height),
            monitor_id: monitorIndex,
          }
        }
      );

      await invoke('open_editor', { imageData: result.image_data });
    } catch {
      await invoke('hide_overlay');
    }
  }, [isSelecting, selection, getDisplayRect, monitorX, monitorY, monitorIndex, mode, isDragging, hoveredWindow]);

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

  // Focus the window on mount
  useEffect(() => {
    const focusWindow = async () => {
      try {
        const window = getCurrentWindow();
        await window.setFocus();
      } catch (e) {
        console.error('Failed to focus window:', e);
      }
    };
    focusWindow();
  }, []);

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
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
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

      {/* Instructions toast - glass effect */}
      <div
        className="glass absolute top-6 left-1/2 transform -translate-x-1/2 px-5 py-3 rounded-xl pointer-events-none animate-fade-in"
        style={{
          color: 'var(--text-primary)',
          fontSize: '13px',
          fontWeight: 500,
        }}
      >
        {mode === 'window' && !isDragging ? (
          <>
            <span style={{ color: 'var(--text-secondary)' }}>
              {hoveredWindow ? 'Click to capture window' : 'Hover over a window'}
            </span>
            <span style={{ margin: '0 10px', color: 'var(--text-tertiary)' }}>•</span>
            <span style={{ color: 'var(--text-tertiary)' }}>Drag to select region</span>
            <span style={{ margin: '0 10px', color: 'var(--text-tertiary)' }}>•</span>
            <span style={{ color: 'var(--text-tertiary)' }}>ESC to cancel</span>
          </>
        ) : (
          <>
            <span style={{ color: 'var(--text-secondary)' }}>Drag to select region</span>
            <span style={{ margin: '0 10px', color: 'var(--text-tertiary)' }}>•</span>
            <span style={{ color: 'var(--text-tertiary)' }}>ESC to cancel</span>
          </>
        )}
      </div>
    </div>
  );
};
