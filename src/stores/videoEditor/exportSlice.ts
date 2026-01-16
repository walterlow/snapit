import { invoke } from '@tauri-apps/api/core';
import type { SliceCreator, ExportProgress, ExportResult, ExportConfig, AutoZoomConfig, VideoProject } from './types';
import { videoEditorLogger } from '../../utils/logger';

/**
 * Export state and actions for video export and auto-zoom generation
 */
export interface ExportSlice {
  // Export state
  isExporting: boolean;
  exportProgress: ExportProgress | null;

  // Auto-zoom state
  isGeneratingAutoZoom: boolean;

  // Export config actions
  updateExportConfig: (updates: Partial<ExportConfig>) => void;

  // Export actions
  exportVideo: (outputPath: string) => Promise<ExportResult>;
  setExportProgress: (progress: ExportProgress | null) => void;
  cancelExport: () => void;

  // Auto-zoom generation
  generateAutoZoom: (config?: AutoZoomConfig) => Promise<void>;
}

export const createExportSlice: SliceCreator<ExportSlice> = (set, get) => ({
  // Initial state
  isExporting: false,
  exportProgress: null,
  isGeneratingAutoZoom: false,

  // Export config actions
  updateExportConfig: (updates) => {
    const { project } = get();
    if (!project) return;

    set({
      project: {
        ...project,
        export: {
          ...project.export,
          ...updates,
        },
      },
    });
  },

  // Export actions
  exportVideo: async (outputPath: string): Promise<ExportResult> => {
    const { project } = get();
    if (!project) {
      throw new Error('No project loaded');
    }

    // Infer format from file extension to ensure consistency
    const ext = outputPath.split('.').pop()?.toLowerCase();
    const formatMap: Record<string, 'mp4' | 'webm' | 'gif'> = {
      mp4: 'mp4',
      webm: 'webm',
      gif: 'gif',
    };
    const selectedFormat = formatMap[ext ?? 'mp4'] ?? 'mp4';

    // Create project with correct format for the chosen file extension
    const projectWithFormat =
      selectedFormat !== project.export.format
        ? {
            ...project,
            export: {
              ...project.export,
              format: selectedFormat,
            },
          }
        : project;

    videoEditorLogger.info(`Exporting to: ${outputPath}`);
    videoEditorLogger.debug(
      `Format: ${selectedFormat}, Quality: ${projectWithFormat.export.quality}, FPS: ${projectWithFormat.export.fps}`
    );
    videoEditorLogger.debug('Scene config:', projectWithFormat.scene);
    videoEditorLogger.debug('Zoom config:', projectWithFormat.zoom);

    set({ isExporting: true, exportProgress: null });

    try {
      const result = await invoke<ExportResult>('export_video', {
        project: projectWithFormat,
        outputPath,
      });

      videoEditorLogger.info('Export success:', result);
      set({ isExporting: false, exportProgress: null });
      return result;
    } catch (error) {
      videoEditorLogger.error('Export failed:', error);
      set({ isExporting: false, exportProgress: null });
      throw error;
    }
  },

  setExportProgress: (progress: ExportProgress | null) => {
    set({ exportProgress: progress });
  },

  cancelExport: () => {
    // TODO: Implement cancel via Tauri command when backend supports it
    set({ isExporting: false, exportProgress: null });
  },

  // Auto-zoom generation
  generateAutoZoom: async (config?: AutoZoomConfig) => {
    const { project } = get();
    if (!project) return;

    // Check if cursor data exists
    if (!project.sources.cursorData) {
      throw new Error(
        'No cursor data available for this recording. Auto-zoom requires cursor data to be recorded.'
      );
    }

    set({ isGeneratingAutoZoom: true });

    try {
      const updatedProject = await invoke<VideoProject>('generate_auto_zoom', {
        project,
        config: config ?? null,
      });

      set({
        project: updatedProject,
        isGeneratingAutoZoom: false,
      });
    } catch (error) {
      set({ isGeneratingAutoZoom: false });
      throw error;
    }
  },
});
