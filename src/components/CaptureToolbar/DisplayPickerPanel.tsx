/**
 * DisplayPickerPanel - Display/monitor selector using native Tauri menu
 * 
 * Shows a button that opens a native OS menu with available displays.
 * Native menus avoid popover clipping issues in transparent windows.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Monitor } from 'lucide-react';
import type { MonitorInfo, FastCaptureResult, CaptureType } from '@/types';

interface DisplayPickerPanelProps {
  disabled?: boolean;
  captureType?: CaptureType;
  onCaptureComplete?: () => void;
}

export const DisplayPickerPanel: React.FC<DisplayPickerPanelProps> = ({
  disabled = false,
  captureType = 'screenshot',
  onCaptureComplete,
}) => {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Load monitors on mount
  useEffect(() => {
    loadMonitors();
  }, []);

  const loadMonitors = async () => {
    try {
      const result = await invoke<MonitorInfo[]>('get_monitors');
      setMonitors(result);
    } catch (error) {
      console.error('Failed to load monitors:', error);
    }
  };

  // Handle selection - capture this display
  const handleSelectDisplay = useCallback(async (monitor: MonitorInfo, monitorIndex: number) => {
    if (isCapturing) return;
    
    setIsCapturing(true);
    
    try {
      if (captureType === 'screenshot') {
        const result = await invoke<FastCaptureResult>('capture_screen_region_fast', {
          selection: {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
          },
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
          sourceMode: 'display',
          preselectMonitor: monitorIndex,
        });
      }
    } catch (error) {
      console.error('Failed to capture display:', error);
    } finally {
      setIsCapturing(false);
    }
  }, [captureType, isCapturing, onCaptureComplete]);

  // Format display name
  const getDisplayName = (monitor: MonitorInfo, index: number) => {
    const baseName = monitor.name && monitor.name !== 'Unknown' 
      ? monitor.name 
      : `Display ${index + 1}`;
    const resolution = `${monitor.width}×${monitor.height}`;
    const primary = monitor.is_primary ? ' (Primary)' : '';
    return `${baseName}${primary} - ${resolution}`;
  };

  // Open native menu
  const openMenu = async () => {
    if (disabled || isCapturing) return;
    
    // Refresh monitors before showing menu
    await loadMonitors();
    
    try {
      // Build menu items
      const items = await Promise.all([
        // Header (disabled item as label)
        MenuItem.new({ 
          id: 'header', 
          text: 'Select Display', 
          enabled: false 
        }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        // Monitor items
        ...monitors.map((monitor, index) => 
          MenuItem.new({
            id: `display-${index}`,
            text: getDisplayName(monitor, index),
            action: () => handleSelectDisplay(monitor, index),
          })
        ),
        // Refresh option
        PredefinedMenuItem.new({ item: 'Separator' }),
        MenuItem.new({
          id: 'refresh',
          text: 'Refresh Displays',
          action: loadMonitors,
        }),
      ]);

      const menu = await Menu.new({ items });
      
      // Position menu below the button
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
      } else {
        await menu.popup();
      }
    } catch (error) {
      console.error('Failed to open display menu:', error);
    }
  };

  return (
    <button
      ref={buttonRef}
      onClick={openMenu}
      className="glass-source-btn"
      disabled={disabled || isCapturing}
      title="Select display"
    >
      <span className="glass-source-icon">
        <Monitor size={18} strokeWidth={1.5} />
      </span>
      <span className="glass-source-label">Display</span>
    </button>
  );
};

export default DisplayPickerPanel;
