/**
 * Capture Service
 *
 * Unified API for all capture operations (screenshot, video, gif).
 * Single entry point for triggering captures across the application.
 */

import { invoke } from '@tauri-apps/api/core';
import type { MonitorInfo, ScreenRegionSelection, FastCaptureResult, RecordingFormat } from '../types';
import { reportError } from '../utils/errorReporting';

/**
 * Result from a fullscreen capture operation.
 */
interface FullscreenCaptureResult {
  image_data: string;
}

/**
 * Virtual screen bounds for multi-monitor capture.
 */
interface VirtualScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Capture Service - stateless capture operations.
 * Use this for triggering captures from any part of the application.
 */
export const CaptureService = {
  /**
   * Show the region selection overlay for screenshot capture.
   * The overlay handles the actual capture when user confirms selection.
   */
  async showScreenshotOverlay(): Promise<void> {
    try {
      await invoke('show_overlay', { captureType: 'screenshot' });
    } catch (error) {
      reportError(error, { operation: 'capture start' });
      throw error;
    }
  },

  /**
   * Show the region selection overlay for video recording.
   * The toolbar handles recording start, pause, resume, and stop.
   */
  async showVideoOverlay(format: RecordingFormat = 'mp4'): Promise<void> {
    try {
      const captureType = format === 'gif' ? 'gif' : 'video';
      await invoke('show_overlay', { captureType });
    } catch (error) {
      reportError(error, { operation: 'recording start' });
      throw error;
    }
  },

  /**
   * Capture the entire primary monitor (fullscreen).
   * Returns the captured image data as base64.
   */
  async captureFullscreen(): Promise<FullscreenCaptureResult | null> {
    try {
      const result = await invoke<FullscreenCaptureResult>('capture_fullscreen');
      return result?.image_data ? result : null;
    } catch (error) {
      reportError(error, { operation: 'fullscreen capture' });
      throw error;
    }
  },

  /**
   * Capture all monitors combined into a single image.
   * Uses the fast capture path that writes directly to a temp file.
   */
  async captureAllMonitors(): Promise<FastCaptureResult> {
    try {
      // Get virtual screen bounds (calculated in Rust)
      const bounds = await invoke<VirtualScreenBounds>('get_virtual_screen_bounds');

      // Capture full virtual desktop using screen region
      const result = await invoke<FastCaptureResult>('capture_screen_region_fast', {
        selection: bounds,
      });

      return result;
    } catch (error) {
      reportError(error, { operation: 'monitors capture' });
      throw error;
    }
  },

  /**
   * Capture all monitors and open directly in editor.
   * Convenience method that combines capture + open.
   */
  async captureAllMonitorsToEditor(): Promise<void> {
    try {
      const result = await this.captureAllMonitors();
      await invoke('open_editor_fast', {
        filePath: result.file_path,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      // Error already reported in captureAllMonitors
      throw error;
    }
  },

  /**
   * Calculate the bounding box for all monitors.
   * Useful for custom multi-monitor capture logic.
   */
  async calculateAllMonitorsBounds(): Promise<ScreenRegionSelection> {
    try {
      const monitors = await invoke<MonitorInfo[]>('get_monitors');
      if (monitors.length === 0) {
        throw new Error('No monitors found');
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const mon of monitors) {
        minX = Math.min(minX, mon.x);
        minY = Math.min(minY, mon.y);
        maxX = Math.max(maxX, mon.x + mon.width);
        maxY = Math.max(maxY, mon.y + mon.height);
      }

      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    } catch (error) {
      reportError(error, { operation: 'monitor detection' });
      throw error;
    }
  },

  /**
   * Capture a specific screen region.
   * Uses the fast capture path that writes directly to a temp file.
   */
  async captureRegion(selection: ScreenRegionSelection): Promise<FastCaptureResult> {
    try {
      return await invoke<FastCaptureResult>('capture_screen_region_fast', { selection });
    } catch (error) {
      reportError(error, { operation: 'region capture' });
      throw error;
    }
  },

  /**
   * Capture a region and open directly in editor.
   * Convenience method that combines capture + open.
   */
  async captureRegionToEditor(selection: ScreenRegionSelection): Promise<void> {
    try {
      const result = await this.captureRegion(selection);
      await invoke('open_editor_fast', {
        filePath: result.file_path,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      // Error already reported in captureRegion
      throw error;
    }
  },
};

// Export types for consumers
export type { FullscreenCaptureResult, VirtualScreenBounds };
