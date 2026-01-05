import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCaptureActions } from './useCaptureActions';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock CaptureService
const mockShowScreenshotOverlay = vi.fn();
const mockCaptureAllMonitorsToEditor = vi.fn();

vi.mock('../services/captureService', () => ({
  CaptureService: {
    showScreenshotOverlay: () => mockShowScreenshotOverlay(),
    captureAllMonitorsToEditor: () => mockCaptureAllMonitorsToEditor(),
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

  it('should trigger fullscreen capture and open editor', async () => {
    const captureResult = {
      file_path: '/path/to/capture.png',
      width: 1920,
      height: 1080,
    };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'capture_fullscreen_fast') return Promise.resolve(captureResult);
      if (cmd === 'open_editor_fast') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useCaptureActions());

    await act(async () => {
      await result.current.triggerFullscreenCapture();
    });

    expect(mockInvoke).toHaveBeenCalledWith('capture_fullscreen_fast');
    expect(mockInvoke).toHaveBeenCalledWith('open_editor_fast', {
      filePath: '/path/to/capture.png',
      width: 1920,
      height: 1080,
    });
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
    expect(result.current.triggerFullscreenCapture).toBe(firstTriggerFullscreenCapture);
    expect(result.current.triggerAllMonitorsCapture).toBe(firstTriggerAllMonitorsCapture);
  });
});
