import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setInvokeResponse, setInvokeError } from '@/test/mocks/tauri';
import { useVideoEditorStore } from '@/stores/videoEditor';
import type { VideoProject, ExportResult, ExportProgress, AutoZoomConfig } from '@/stores/videoEditor/types';

// Mock nanoid
vi.mock('nanoid', () => ({
  nanoid: () => `mock_id_${Date.now()}_${Math.random()}`,
}));

/**
 * Create a minimal valid VideoProject for testing
 */
function createTestProject(overrides: Partial<VideoProject> = {}): VideoProject {
  const durationMs = 10000; // 10 seconds
  return {
    id: 'test-project-id',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: 'Test Recording',
    sources: {
      screenVideo: '/path/to/video.mp4',
      webcamVideo: null,
      cursorData: null,
      audioFile: null,
      systemAudio: null,
      microphoneAudio: null,
      backgroundMusic: null,
      originalWidth: 1920,
      originalHeight: 1080,
      durationMs,
      fps: 30,
    },
    timeline: {
      durationMs,
      inPoint: 0,
      outPoint: durationMs,
      speed: 1.0,
    },
    zoom: {
      mode: 'manual',
      autoZoomScale: 2.0,
      regions: [],
    },
    cursor: {
      visible: true,
      cursorType: 'actual',
      scale: 1.5,
      smoothMovement: true,
      animationStyle: 'smooth',
      tension: 200,
      mass: 1.0,
      friction: 20,
      motionBlur: 0,
      clickHighlight: {
        enabled: true,
        color: '#ff4444',
        size: 48,
        opacity: 0.6,
        duration: 300,
      },
      hideWhenIdle: false,
      idleTimeoutMs: 3000,
    },
    webcam: {
      enabled: false,
      position: 'bottom-right',
      customX: 0,
      customY: 0,
      size: 0.2,
      shape: 'circle',
      rounding: 100,
      cornerStyle: 'squircle',
      shadow: 50,
      shadowConfig: {
        size: 20,
        opacity: 0.3,
        blur: 15,
        offsetX: 0,
        offsetY: 4,
      },
      mirror: false,
      border: {
        enabled: false,
        width: 2,
        color: '#ffffff',
      },
      visibilitySegments: [],
    },
    audio: {
      systemVolume: 1.0,
      microphoneVolume: 1.0,
      musicVolume: 0.5,
      musicFadeInSecs: 2.0,
      musicFadeOutSecs: 2.0,
      normalizeOutput: true,
      systemMuted: false,
      microphoneMuted: false,
      musicMuted: false,
    },
    export: {
      preset: 'social',
      format: 'mp4',
      resolution: 'original',
      quality: 80,
      fps: 30,
      aspectRatio: '16:9',
      background: {
        type: 'solid',
        color: '#000000',
        gradientStart: '#1a1a2e',
        gradientEnd: '#16213e',
        gradientAngle: 135,
        imagePath: null,
        imageScale: 'cover',
        wallpaperName: null,
        blur: 20,
      },
      crop: {
        enabled: false,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      },
      composition: {
        canvasWidth: 1920,
        canvasHeight: 1080,
        videoScale: 1.0,
        videoX: 0,
        videoY: 0,
        aspectRatioLocked: true,
        fitMode: 'fit',
      },
      preferHardwareEncoding: true,
    },
    scene: {
      segments: [],
      defaultMode: 'screen_only',
    },
    text: {
      segments: [],
    },
    mask: {
      segments: [],
    },
    ...overrides,
  };
}

/**
 * Reset the video editor store to its initial state
 */
function resetStore() {
  useVideoEditorStore.getState().clearEditor();
}

describe('Video Export Flow Integration', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe('Export Video', () => {
    it('should complete full export workflow successfully', async () => {
      const mockExportResult: ExportResult = {
        outputPath: '/output/video.mp4',
        durationSecs: 10.5,
        fileSizeBytes: 5242880, // 5MB
        format: 'mp4',
      };

      setInvokeResponse('export_video', mockExportResult);

      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // 1. Verify project loaded
      const storeAfterLoad = useVideoEditorStore.getState();
      expect(storeAfterLoad.project).not.toBeNull();

      // 2. Start export
      expect(storeAfterLoad.isExporting).toBe(false);
      const exportPromise = storeAfterLoad.exportVideo('/output/video.mp4');

      // 3. Verify exporting state is set
      expect(useVideoEditorStore.getState().isExporting).toBe(true);

      // 4. Wait for export to complete
      const result = await exportPromise;

      // 5. Verify result
      expect(result).toEqual(mockExportResult);
      expect(result.outputPath).toBe('/output/video.mp4');
      expect(result.format).toBe('mp4');

      // 6. Verify exporting state is cleared
      expect(useVideoEditorStore.getState().isExporting).toBe(false);
      expect(useVideoEditorStore.getState().exportProgress).toBeNull();
    });

    it('should infer format from file extension', async () => {
      const testProject = createTestProject();

      setInvokeResponse('export_video', {
        outputPath: '/output/video.webm',
        durationSecs: 10,
        fileSizeBytes: 1000000,
        format: 'webm',
      });

      useVideoEditorStore.getState().setProject(testProject);

      // Export with .webm extension - should override project format
      await useVideoEditorStore.getState().exportVideo('/output/video.webm');

      // Check that store's project still has original format (export infers format internally)
      expect(useVideoEditorStore.getState().project?.export.format).toBe('mp4');
    });

    it('should handle export failure gracefully', async () => {
      setInvokeError('export_video', 'Encoding failed: insufficient disk space');

      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // Start export
      await expect(useVideoEditorStore.getState().exportVideo('/output/video.mp4')).rejects.toThrow(
        'Encoding failed: insufficient disk space'
      );

      // Verify state is cleaned up after failure
      expect(useVideoEditorStore.getState().isExporting).toBe(false);
      expect(useVideoEditorStore.getState().exportProgress).toBeNull();
    });

    it('should throw error when no project is loaded', async () => {
      // No project loaded
      expect(useVideoEditorStore.getState().project).toBeNull();

      // Try to export without loading a project
      await expect(useVideoEditorStore.getState().exportVideo('/output/video.mp4')).rejects.toThrow(
        'No project loaded'
      );

      // Verify state remains clean
      expect(useVideoEditorStore.getState().isExporting).toBe(false);
    });

    it('should support different export formats', async () => {
      const formats = ['mp4', 'webm', 'gif'] as const;

      for (const format of formats) {
        resetStore();

        const mockResult: ExportResult = {
          outputPath: `/output/video.${format}`,
          durationSecs: 5,
          fileSizeBytes: 1000000,
          format,
        };

        setInvokeResponse('export_video', mockResult);

        const testProject = createTestProject({
          export: {
            ...createTestProject().export,
            format,
          },
        });

        useVideoEditorStore.getState().setProject(testProject);

        const result = await useVideoEditorStore.getState().exportVideo(`/output/video.${format}`);
        expect(result.format).toBe(format);
      }
    });
  });

  describe('Export Progress', () => {
    it('should update export progress correctly', () => {
      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // Initial state
      expect(useVideoEditorStore.getState().exportProgress).toBeNull();

      // Update progress - preparing
      const preparingProgress: ExportProgress = {
        progress: 0.1,
        stage: 'preparing',
        message: 'Initializing encoder...',
      };
      useVideoEditorStore.getState().setExportProgress(preparingProgress);
      expect(useVideoEditorStore.getState().exportProgress).toEqual(preparingProgress);

      // Update progress - encoding
      const encodingProgress: ExportProgress = {
        progress: 0.5,
        stage: 'encoding',
        message: 'Encoding frame 150/300...',
      };
      useVideoEditorStore.getState().setExportProgress(encodingProgress);
      expect(useVideoEditorStore.getState().exportProgress).toEqual(encodingProgress);

      // Update progress - finalizing
      const finalizingProgress: ExportProgress = {
        progress: 0.95,
        stage: 'finalizing',
        message: 'Writing output file...',
      };
      useVideoEditorStore.getState().setExportProgress(finalizingProgress);
      expect(useVideoEditorStore.getState().exportProgress).toEqual(finalizingProgress);

      // Complete
      const completeProgress: ExportProgress = {
        progress: 1.0,
        stage: 'complete',
        message: 'Export complete!',
      };
      useVideoEditorStore.getState().setExportProgress(completeProgress);
      expect(useVideoEditorStore.getState().exportProgress).toEqual(completeProgress);
    });

    it('should handle progress events during export', async () => {
      const mockResult: ExportResult = {
        outputPath: '/output/video.mp4',
        durationSecs: 10,
        fileSizeBytes: 5000000,
        format: 'mp4',
      };

      setInvokeResponse('export_video', mockResult);

      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // Start export
      const exportPromise = useVideoEditorStore.getState().exportVideo('/output/video.mp4');

      // Simulate progress events coming from backend
      useVideoEditorStore.getState().setExportProgress({
        progress: 0.25,
        stage: 'encoding',
        message: 'Processing...',
      });

      expect(useVideoEditorStore.getState().exportProgress?.progress).toBe(0.25);

      useVideoEditorStore.getState().setExportProgress({
        progress: 0.75,
        stage: 'encoding',
        message: 'Almost done...',
      });

      expect(useVideoEditorStore.getState().exportProgress?.progress).toBe(0.75);

      // Complete export
      await exportPromise;

      // Progress should be cleared after successful export
      expect(useVideoEditorStore.getState().exportProgress).toBeNull();
    });
  });

  describe('Cancel Export', () => {
    it('should cancel export and reset state', () => {
      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // Simulate export in progress
      useVideoEditorStore.setState({
        isExporting: true,
        exportProgress: {
          progress: 0.5,
          stage: 'encoding',
          message: 'Encoding...',
        },
      });

      expect(useVideoEditorStore.getState().isExporting).toBe(true);

      // Cancel export
      useVideoEditorStore.getState().cancelExport();

      // Verify state is reset
      expect(useVideoEditorStore.getState().isExporting).toBe(false);
      expect(useVideoEditorStore.getState().exportProgress).toBeNull();
    });
  });

  describe('Export Config', () => {
    it('should update export configuration', () => {
      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // Initial format - get fresh state after setProject
      const initialState = useVideoEditorStore.getState();
      expect(initialState.project?.export.format).toBe('mp4');
      expect(initialState.project?.export.quality).toBe(80);

      // Update export config
      useVideoEditorStore.getState().updateExportConfig({
        format: 'webm',
        quality: 90,
        fps: 60,
      });

      const updatedState = useVideoEditorStore.getState();
      expect(updatedState.project?.export.format).toBe('webm');
      expect(updatedState.project?.export.quality).toBe(90);
      expect(updatedState.project?.export.fps).toBe(60);

      // Other settings should remain unchanged
      expect(updatedState.project?.export.resolution).toBe('original');
    });

    it('should not update config when no project is loaded', () => {
      // No project loaded
      expect(useVideoEditorStore.getState().project).toBeNull();

      // Try to update config - should do nothing
      useVideoEditorStore.getState().updateExportConfig({ format: 'webm' });

      // Still no project
      expect(useVideoEditorStore.getState().project).toBeNull();
    });
  });

  describe('Auto-Zoom Generation', () => {
    it('should generate auto-zoom regions from cursor data', async () => {
      // Mock cursor recording response first (setProject auto-loads cursor data)
      setInvokeResponse('load_cursor_recording_cmd', {
        width: 1920,
        height: 1080,
        events: [
          { timeMs: 1000, x: 960, y: 540, eventType: 'click' },
          { timeMs: 5000, x: 1440, y: 810, eventType: 'click' },
        ],
        videoStartOffsetMs: 0,
      });

      const projectWithCursorData = createTestProject({
        sources: {
          ...createTestProject().sources,
          cursorData: '/path/to/cursor.json',
        },
      });

      // Mock the generate_auto_zoom command to return updated project with zoom regions
      const updatedProject: VideoProject = {
        ...projectWithCursorData,
        zoom: {
          ...projectWithCursorData.zoom,
          regions: [
            {
              id: 'zoom-1',
              startMs: 1000,
              endMs: 2000,
              targetX: 960,
              targetY: 540,
              scale: 2.0,
              easing: 'ease-in-out',
              source: 'auto',
            },
            {
              id: 'zoom-2',
              startMs: 5000,
              endMs: 6500,
              targetX: 1440,
              targetY: 810,
              scale: 2.0,
              easing: 'ease-in-out',
              source: 'auto',
            },
          ],
        },
      };

      setInvokeResponse('generate_auto_zoom', updatedProject);

      useVideoEditorStore.getState().setProject(projectWithCursorData);

      // Wait for cursor data to load asynchronously
      await vi.waitFor(() => {
        expect(useVideoEditorStore.getState().cursorRecording).not.toBeNull();
      });

      // Initial state - project should have empty zoom regions
      const storeAfterLoad = useVideoEditorStore.getState();
      expect(storeAfterLoad.project?.zoom.regions).toHaveLength(0);
      expect(storeAfterLoad.isGeneratingAutoZoom).toBe(false);

      // Generate auto-zoom
      const generatePromise = useVideoEditorStore.getState().generateAutoZoom();

      // Should be generating
      expect(useVideoEditorStore.getState().isGeneratingAutoZoom).toBe(true);

      await generatePromise;

      // Verify result
      const finalState = useVideoEditorStore.getState();
      expect(finalState.isGeneratingAutoZoom).toBe(false);
      expect(finalState.project?.zoom.regions).toHaveLength(2);
      expect(finalState.project?.zoom.regions[0].source).toBe('auto');
    });

    it('should throw error when cursor data is not available', async () => {
      const projectWithoutCursorData = createTestProject();

      useVideoEditorStore.getState().setProject(projectWithoutCursorData);

      // Try to generate auto-zoom without cursor data
      await expect(useVideoEditorStore.getState().generateAutoZoom()).rejects.toThrow(
        'No cursor data available for this recording'
      );

      // State should be reset
      expect(useVideoEditorStore.getState().isGeneratingAutoZoom).toBe(false);
    });

    it('should apply custom auto-zoom config', async () => {
      // Mock cursor recording response first
      setInvokeResponse('load_cursor_recording_cmd', {
        width: 1920,
        height: 1080,
        events: [{ timeMs: 1000, x: 960, y: 540, eventType: 'click' }],
        videoStartOffsetMs: 0,
      });

      const projectWithCursorData = createTestProject({
        sources: {
          ...createTestProject().sources,
          cursorData: '/path/to/cursor.json',
        },
      });

      const customConfig: AutoZoomConfig = {
        scale: 3.0,
        holdDurationMs: 2000,
        minGapMs: 500,
        transitionInMs: 300,
        transitionOutMs: 300,
        easing: 'ease-in',
        leftClicksOnly: true,
      };

      const updatedProject: VideoProject = {
        ...projectWithCursorData,
        zoom: {
          ...projectWithCursorData.zoom,
          regions: [
            {
              id: 'zoom-custom',
              startMs: 1000,
              endMs: 3000,
              targetX: 960,
              targetY: 540,
              scale: 3.0,
              easing: 'ease-in',
              source: 'auto',
            },
          ],
        },
      };

      setInvokeResponse('generate_auto_zoom', updatedProject);

      useVideoEditorStore.getState().setProject(projectWithCursorData);

      // Wait for cursor data to load
      await vi.waitFor(() => {
        expect(useVideoEditorStore.getState().cursorRecording).not.toBeNull();
      });

      await useVideoEditorStore.getState().generateAutoZoom(customConfig);

      const finalState = useVideoEditorStore.getState();
      expect(finalState.project?.zoom.regions).toHaveLength(1);
      expect(finalState.project?.zoom.regions[0].scale).toBe(3.0);
    });

    it('should handle auto-zoom generation failure', async () => {
      // Mock cursor recording response first
      setInvokeResponse('load_cursor_recording_cmd', {
        width: 1920,
        height: 1080,
        events: [],
        videoStartOffsetMs: 0,
      });

      const projectWithCursorData = createTestProject({
        sources: {
          ...createTestProject().sources,
          cursorData: '/path/to/cursor.json',
        },
      });

      setInvokeError('generate_auto_zoom', 'Failed to parse cursor data');

      useVideoEditorStore.getState().setProject(projectWithCursorData);

      // Wait for cursor data to load
      await vi.waitFor(() => {
        expect(useVideoEditorStore.getState().cursorRecording).not.toBeNull();
      });

      await expect(useVideoEditorStore.getState().generateAutoZoom()).rejects.toThrow(
        'Failed to parse cursor data'
      );

      // State should be reset
      expect(useVideoEditorStore.getState().isGeneratingAutoZoom).toBe(false);
    });

    it('should do nothing when no project is loaded', async () => {
      // No project loaded
      expect(useVideoEditorStore.getState().project).toBeNull();

      // Generate should return early without error
      await useVideoEditorStore.getState().generateAutoZoom();

      // State unchanged
      expect(useVideoEditorStore.getState().isGeneratingAutoZoom).toBe(false);
    });
  });

  describe('Clear Editor', () => {
    it('should reset all export-related state when clearing editor', () => {
      const testProject = createTestProject();
      useVideoEditorStore.getState().setProject(testProject);

      // Set export state
      useVideoEditorStore.setState({
        isExporting: true,
        exportProgress: {
          progress: 0.5,
          stage: 'encoding',
          message: 'Encoding...',
        },
        isGeneratingAutoZoom: true,
      });

      // Clear editor
      useVideoEditorStore.getState().clearEditor();

      const clearedState = useVideoEditorStore.getState();
      expect(clearedState.project).toBeNull();
      expect(clearedState.isExporting).toBe(false);
      expect(clearedState.exportProgress).toBeNull();
      expect(clearedState.isGeneratingAutoZoom).toBe(false);
    });
  });
});

describe('Video Export with Timeline Trim', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('should export only the trimmed portion of the video', async () => {
    const testProject = createTestProject({
      timeline: {
        durationMs: 60000, // 60 seconds
        inPoint: 10000, // Start at 10s
        outPoint: 30000, // End at 30s
        speed: 1.0,
      },
    });

    const mockResult: ExportResult = {
      outputPath: '/output/trimmed.mp4',
      durationSecs: 20, // 20 seconds (30s - 10s)
      fileSizeBytes: 10000000,
      format: 'mp4',
    };

    setInvokeResponse('export_video', mockResult);

    useVideoEditorStore.getState().setProject(testProject);

    const result = await useVideoEditorStore.getState().exportVideo('/output/trimmed.mp4');

    expect(result.durationSecs).toBe(20);
  });
});

describe('Video Export with Zoom Regions', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('should export video with zoom regions applied', async () => {
    const testProject = createTestProject({
      zoom: {
        mode: 'manual',
        autoZoomScale: 2.0,
        regions: [
          {
            id: 'zoom-1',
            startMs: 2000,
            endMs: 5000,
            targetX: 960,
            targetY: 540,
            scale: 2.5,
            easing: 'ease-in-out',
            source: 'manual',
          },
        ],
      },
    });

    const mockResult: ExportResult = {
      outputPath: '/output/zoomed.mp4',
      durationSecs: 10,
      fileSizeBytes: 8000000,
      format: 'mp4',
    };

    setInvokeResponse('export_video', mockResult);

    useVideoEditorStore.getState().setProject(testProject);

    // Get fresh state after setProject
    const storeAfterLoad = useVideoEditorStore.getState();
    expect(storeAfterLoad.project?.zoom.regions).toHaveLength(1);

    const result = await useVideoEditorStore.getState().exportVideo('/output/zoomed.mp4');

    expect(result.outputPath).toBe('/output/zoomed.mp4');
  });
});
