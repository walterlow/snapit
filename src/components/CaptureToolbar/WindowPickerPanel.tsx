/**
 * WindowPickerPanel - Window selector using native Tauri menu
 *
 * Shows a button that opens a native OS menu with capturable windows.
 * Native menus avoid popover clipping issues in transparent windows.
 */

import React, { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppWindow } from 'lucide-react';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import type { WindowInfo, FastCaptureResult, CaptureType } from '@/types';

interface WindowPickerPanelProps {
  disabled?: boolean;
  captureType?: CaptureType;
  onCaptureComplete?: () => void;
}

export const WindowPickerPanel: React.FC<WindowPickerPanelProps> = ({
  disabled = false,
  captureType = 'screenshot',
  onCaptureComplete,
}) => {
  const [isCapturing, setIsCapturing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Load windows
  const loadWindows = async (): Promise<WindowInfo[]> => {
    try {
      const result = await invoke<WindowInfo[]>('get_windows');
      // Filter out minimized windows
      return result.filter(w => !w.is_minimized);
    } catch (error) {
      console.error('Failed to load windows:', error);
      return [];
    }
  };

  // Handle click - capture this window
  const handleSelectWindow = useCallback(async (window: WindowInfo) => {
    if (isCapturing) return;

    setIsCapturing(true);

    try {
      if (captureType === 'screenshot') {
        const result = await invoke<FastCaptureResult>('capture_window_fast', {
          hwnd: window.id,
        });

        await invoke('open_editor_fast', {
          filePath: result.file_path,
          width: result.width,
          height: result.height,
        });

        onCaptureComplete?.();
      } else {
        const ctStr = captureType === 'gif' ? 'gif' : 'video';
        await invoke('show_capture_overlay', {
          captureType: ctStr,
          sourceMode: 'window',
          preselectWindow: window.id,
        });
      }
    } catch (error) {
      console.error('Failed to capture window:', error);
    } finally {
      setIsCapturing(false);
    }
  }, [captureType, isCapturing, onCaptureComplete]);

  // Get display name for window
  const getDisplayName = (window: WindowInfo) => {
    const title = window.title || window.app_name || 'Unknown Window';
    const appName = window.app_name?.replace('.exe', '') || '';

    // Format: "Title - AppName" or just "Title"
    if (appName && title !== appName) {
      const maxTitleLen = 40;
      const truncatedTitle = title.length > maxTitleLen
        ? title.substring(0, maxTitleLen) + '…'
        : title;
      return `${truncatedTitle} — ${appName}`;
    }

    return title.length > 50 ? title.substring(0, 50) + '…' : title;
  };

  // Handle pick window - show D2D overlay for interactive window selection
  const handlePickWindow = useCallback(async () => {
    if (isCapturing) return;

    setIsCapturing(true);

    try {
      const ctStr = captureType === 'gif' ? 'gif' : captureType === 'screenshot' ? 'screenshot' : 'video';
      await invoke('show_capture_overlay', {
        captureType: ctStr,
        sourceMode: 'window',
        // No preselectWindow - user will click to select
      });

      if (captureType === 'screenshot') {
        onCaptureComplete?.();
      }
    } catch (error) {
      console.error('Failed to start window picker:', error);
    } finally {
      setIsCapturing(false);
    }
  }, [captureType, isCapturing, onCaptureComplete]);

  // Open native menu
  const openMenu = useCallback(async () => {
    if (disabled || isCapturing) return;

    const windows = await loadWindows();

    try {
      const items = await Promise.all([
        // Header
        MenuItem.new({
          id: 'header',
          text: 'Select Window',
          enabled: false
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // Pick window option - interactive D2D selection
        MenuItem.new({
          id: 'pick-window',
          text: 'Pick Window...',
          action: handlePickWindow,
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // Window list
        ...windows.map((window) =>
          MenuItem.new({
            id: `window-${window.id}`,
            text: getDisplayName(window),
            action: () => handleSelectWindow(window),
          })
        ),
        // Empty state or refresh
        ...(windows.length === 0 ? [
          MenuItem.new({
            id: 'empty',
            text: 'No windows found',
            enabled: false,
          })
        ] : []),
        PredefinedMenuItem.new({ item: 'Separator' }),
        MenuItem.new({
          id: 'refresh',
          text: 'Refresh Windows',
          action: () => openMenu(),
        }),
      ]);

      const menu = await Menu.new({ items });

      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
      } else {
        await menu.popup();
      }
    } catch (error) {
      console.error('Failed to open window menu:', error);
    }
  }, [disabled, isCapturing, handleSelectWindow, handlePickWindow]);

  return (
    <button
      ref={buttonRef}
      onClick={openMenu}
      className="glass-source-btn"
      disabled={disabled || isCapturing}
      title="Select window"
    >
      <span className="glass-source-icon">
        <AppWindow size={18} strokeWidth={1.5} />
      </span>
      <span className="glass-source-label">Window</span>
    </button>
  );
};

export default WindowPickerPanel;
