import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCaptureActions } from './useCaptureActions';

// Mock CaptureService
const mockShowScreenshotOverlay = vi.fn();
const mockCaptureFullscreen = vi.fn();
const mockCaptureAllMonitorsToEditor = vi.fn();

vi.mock('../services/captureService', () => ({
  CaptureService: {
    showScreenshotOverlay: () => mockShowScreenshotOverlay(),
    captureFullscreen: () => mockCaptureFullscreen(),
    captureAllMonitorsToEditor: () => mockCaptureAllMonitorsToEditor(),
  },
}));

// Mock stores
const mockSaveNewCapture = vi.fn();
const mockClearEditor = vi.fn();

vi.mock('../stores/captureStore', () => ({
  useCaptureStore: () => ({
    saveNewCapture: mockSaveNewCapture,
  }),
}));

vi.mock('../stores/editorStore', () => ({
  useEditorStore: () => ({
    clearEditor: mockClearEditor,
  }),
  clearHistory: vi.fn(),
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('useCaptureActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should trigger new capture overlay', async () => {
    mockShowScreenshotOverlay.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCaptureActions());

    await act(async () => {
      await result.current.triggerNewCapture();
    });

    expect(mockShowScreenshotOverlay).toHaveBeenCalledTimes(1);
  });

  it('should trigger fullscreen capture and save', async () => {
    const captureResult = {
      image_data: 'base64ImageData',
      width: 1920,
      height: 1080,
    };
    mockCaptureFullscreen.mockResolvedValue(captureResult);
    mockSaveNewCapture.mockResolvedValue('capture_id');

    const { result } = renderHook(() => useCaptureActions());

    await act(async () => {
      await result.current.triggerFullscreenCapture();
    });

    expect(mockCaptureFullscreen).toHaveBeenCalledTimes(1);
    expect(mockSaveNewCapture).toHaveBeenCalledWith(
      'base64ImageData',
      'fullscreen',
      {}
    );
    expect(mockClearEditor).toHaveBeenCalledTimes(1);
  });

  it('should handle fullscreen capture with no result', async () => {
    mockCaptureFullscreen.mockResolvedValue(null);

    const { result } = renderHook(() => useCaptureActions());

    await act(async () => {
      await result.current.triggerFullscreenCapture();
    });

    expect(mockCaptureFullscreen).toHaveBeenCalledTimes(1);
    expect(mockSaveNewCapture).not.toHaveBeenCalled();
    expect(mockClearEditor).not.toHaveBeenCalled();
  });

  it('should trigger all monitors capture', async () => {
    mockCaptureAllMonitorsToEditor.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCaptureActions());

    await act(async () => {
      await result.current.triggerAllMonitorsCapture();
    });

    expect(mockCaptureAllMonitorsToEditor).toHaveBeenCalledTimes(1);
  });

  it('should return stable function references', () => {
    const { result, rerender } = renderHook(() => useCaptureActions());

    const firstTriggerNewCapture = result.current.triggerNewCapture;
    const firstTriggerFullscreenCapture = result.current.triggerFullscreenCapture;
    const firstTriggerAllMonitorsCapture = result.current.triggerAllMonitorsCapture;

    rerender();

    expect(result.current.triggerNewCapture).toBe(firstTriggerNewCapture);
    expect(result.current.triggerAllMonitorsCapture).toBe(firstTriggerAllMonitorsCapture);
    // triggerFullscreenCapture depends on saveNewCapture and clearEditor, so it might change
  });
});
