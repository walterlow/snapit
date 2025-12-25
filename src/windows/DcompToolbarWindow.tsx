/**
 * DcompToolbarWindow - Toolbar for DirectComposition overlay region selection.
 * 
 * This window appears below the selection region when using the DirectComposition
 * overlay for video/GIF recording. It provides controls for:
 * - Starting recording
 * - Taking a screenshot
 * - Redoing region selection
 * - Canceling
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { RecordingToolbar } from '../components/RegionSelector/RecordingToolbar';
import type { CaptureType } from '../types';

const DcompToolbarWindow: React.FC = () => {
  // Parse initial dimensions from URL params (passed when window is created)
  const initialDimensions = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return {
      width: parseInt(urlParams.get('width') || '0', 10),
      height: parseInt(urlParams.get('height') || '0', 10),
    };
  }, []);

  const [dimensions, setDimensions] = useState(initialDimensions);
  const [includeCursor, setIncludeCursor] = useState(true);
  // For now, default to 'video' - could be passed via window label or event
  const captureType: CaptureType = 'video';

  // Expose global function for Rust to call via eval()
  // This bypasses Tauri events which have issues in this context
  useEffect(() => {
    const updateFn = (width: number, height: number) => {
      console.log('[DcompToolbar] __updateDimensions called:', width, height);
      setDimensions({ width, height });
    };
    
    // Set on window object
    (window as unknown as { __updateDimensions: typeof updateFn }).__updateDimensions = updateFn;
    console.log('[DcompToolbar] Global __updateDimensions function registered');
    
    return () => {
      delete (window as unknown as { __updateDimensions?: unknown }).__updateDimensions;
    };
  }, []);

  // Listen for overlay closed event
  useEffect(() => {
    let unlistenClosed: UnlistenFn | null = null;

    const setupListeners = async () => {
      const currentWindow = getCurrentWebviewWindow();
      
      // Listen for overlay closed event
      unlistenClosed = await listen('dcomp-overlay-closed', () => {
        currentWindow.close().catch(console.error);
      });
    };

    setupListeners();

    return () => {
      unlistenClosed?.();
    };
  }, []);

  // Handlers
  const handleRecord = useCallback(async () => {
    try {
      await invoke('dcomp_overlay_confirm', { action: 'recording' });
    } catch (e) {
      console.error('Failed to start recording:', e);
    }
  }, []);

  const handleScreenshot = useCallback(async () => {
    try {
      await invoke('dcomp_overlay_confirm', { action: 'screenshot' });
    } catch (e) {
      console.error('Failed to take screenshot:', e);
    }
  }, []);

  const handleRedo = useCallback(async () => {
    try {
      await invoke('dcomp_overlay_reselect');
    } catch (e) {
      console.error('Failed to reselect:', e);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      await invoke('dcomp_overlay_cancel');
    } catch (e) {
      console.error('Failed to cancel:', e);
    }
  }, []);

  const handleToggleCursor = useCallback(() => {
    setIncludeCursor(prev => !prev);
  }, []);

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-none">
      <RecordingToolbar
        captureType={captureType}
        width={dimensions.width}
        height={dimensions.height}
        includeCursor={includeCursor}
        onToggleCursor={handleToggleCursor}
        onRecord={handleRecord}
        onScreenshot={handleScreenshot}
        onRedo={handleRedo}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default DcompToolbarWindow;
