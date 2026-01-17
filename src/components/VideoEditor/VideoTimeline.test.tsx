import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VideoTimeline } from './VideoTimeline';
import { useVideoEditorStore } from '../../stores/videoEditorStore';
import { setInvokeResponse } from '../../test/mocks/tauri';
import type { VideoProject, AudioWaveform } from '../../types';

// Create a minimal mock project for testing
const createMockProject = (overrides: Partial<VideoProject> = {}): VideoProject => ({
  id: 'test-project-123',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  name: 'Test Recording',
  sources: {
    screenVideo: '/path/to/screen.mp4',
    webcamVideo: null,
    systemAudio: null,
    microphoneAudio: null,
    cursorRecording: null,
  },
  timeline: {
    durationMs: 30000, // 30 seconds
    trimStart: 0,
    trimEnd: 30000,
    inPoint: 0,
    outPoint: 30000,
    cuts: [],
  },
  zoom: {
    regions: [],
    autoZoom: null,
  },
  cursor: {
    enabled: true,
    size: 1.0,
    highlightClicks: true,
    clickColor: '#FF0000',
    clickOpacity: 0.5,
    clickDuration: 300,
    smoothing: 0.5,
    trail: false,
    trailLength: 10,
    trailOpacity: 0.3,
    hideWhenIdle: false,
    idleTimeout: 3000,
    visibility: [],
  },
  webcam: {
    enabled: false,
    position: 'bottom-right',
    size: 0.2,
    shape: 'circle',
    borderEnabled: true,
    borderColor: '#FFFFFF',
    borderWidth: 2,
    offsetX: 20,
    offsetY: 20,
    zIndex: 10,
    fitMode: 'cover',
  },
  audio: {
    systemVolume: 1.0,
    microphoneVolume: 1.0,
    masterVolume: 1.0,
    normalization: false,
    noiseReduction: false,
  },
  export: {
    format: 'mp4',
    resolution: { width: 1920, height: 1080, label: '1080p' },
    fps: 30,
    quality: 'high',
    includeAudio: true,
  },
  scene: {
    segments: [],
    defaultMode: 'screen-only',
  },
  text: {
    segments: [],
  },
  mask: {
    segments: [],
  },
  ...overrides,
});

// Mock waveform data
const mockWaveform: AudioWaveform = {
  samples: [0.1, 0.2, 0.3, 0.2, 0.1],
  sampleRate: 100,
  durationMs: 50,
};

// Reset store state before each test
beforeEach(() => {
  // Set up mock for extract_audio_waveform
  setInvokeResponse('extract_audio_waveform', mockWaveform);

  useVideoEditorStore.setState({
    project: null,
    currentTimeMs: 0,
    isPlaying: false,
    isDraggingPlayhead: false,
    previewTimeMs: null,
    timelineZoom: 0.05,
    timelineScrollLeft: 0,
    timelineContainerWidth: 800,
    trackVisibility: {
      video: true,
      text: true,
      mask: true,
      zoom: true,
      scene: true,
    },
  });
});

describe('VideoTimeline', () => {
  const defaultProps = {
    onExport: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render timeline with export button', () => {
      render(<VideoTimeline {...defaultProps} />);

      // Export button is always visible
      expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
    });

    it('should render time display showing 0:00 initially', () => {
      const { container } = render(<VideoTimeline {...defaultProps} />);

      // Time display is in the header with specific class
      const timeDisplay = container.querySelector('.tabular-nums');
      expect(timeDisplay).toBeInTheDocument();
      expect(timeDisplay?.textContent).toContain('0:00');
    });

    it('should render playback control buttons', () => {
      const { container } = render(<VideoTimeline {...defaultProps} />);

      // Find buttons by class
      const glassButtons = container.querySelectorAll('.glass-btn');
      expect(glassButtons.length).toBeGreaterThan(0);

      // Find the play button (tool-button class)
      const playButton = container.querySelector('.tool-button');
      expect(playButton).toBeInTheDocument();
    });

    it('should render Video track label when visible', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        trackVisibility: {
          video: true,
          text: true,
          mask: true,
          zoom: true,
          scene: true,
        },
      });

      await act(async () => {
        render(<VideoTimeline {...defaultProps} />);
      });

      expect(screen.getByText('Video')).toBeInTheDocument();
    });

    it('should render track labels based on visibility', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        trackVisibility: {
          video: true,
          text: true,
          mask: true,
          zoom: true,
          scene: false,
        },
      });

      await act(async () => {
        render(<VideoTimeline {...defaultProps} />);
      });

      expect(screen.getByText('Video')).toBeInTheDocument();
      expect(screen.getByText('Text')).toBeInTheDocument();
      expect(screen.getByText('Mask')).toBeInTheDocument();
      expect(screen.getByText('Zoom')).toBeInTheDocument();
    });

    it('should hide Scene track when no webcam video', async () => {
      useVideoEditorStore.setState({
        project: createMockProject({
          sources: {
            screenVideo: '/path/to/screen.mp4',
            webcamVideo: null,
            systemAudio: null,
            microphoneAudio: null,
            cursorRecording: null,
          },
        }),
        trackVisibility: {
          video: true,
          text: true,
          mask: true,
          zoom: true,
          scene: true,
        },
      });

      await act(async () => {
        render(<VideoTimeline {...defaultProps} />);
      });

      // Scene track requires webcamVideo to be present
      expect(screen.queryByText('Scene')).not.toBeInTheDocument();
    });

    it('should show Scene track when webcam video exists', async () => {
      useVideoEditorStore.setState({
        project: createMockProject({
          sources: {
            screenVideo: '/path/to/screen.mp4',
            webcamVideo: '/path/to/webcam.mp4',
            systemAudio: null,
            microphoneAudio: null,
            cursorRecording: null,
          },
        }),
        trackVisibility: {
          video: true,
          text: true,
          mask: true,
          zoom: true,
          scene: true,
        },
      });

      await act(async () => {
        render(<VideoTimeline {...defaultProps} />);
      });

      expect(screen.getByText('Scene')).toBeInTheDocument();
    });

    it('should display zoom level in px/s', () => {
      useVideoEditorStore.setState({ timelineZoom: 0.05 });

      render(<VideoTimeline {...defaultProps} />);

      // 0.05 zoom = 50px/s
      expect(screen.getByText('50px/s')).toBeInTheDocument();
    });
  });

  describe('playback interactions', () => {
    it('should toggle playback when play button is clicked', () => {
      const { container } = render(<VideoTimeline {...defaultProps} />);

      // Find play button by its class
      const playButton = container.querySelector('.tool-button');
      expect(playButton).toBeInTheDocument();

      if (playButton) {
        fireEvent.click(playButton);
      }

      // After clicking, isPlaying should be toggled
      expect(useVideoEditorStore.getState().isPlaying).toBe(true);
    });

    it('should call onExport when export button is clicked', () => {
      const onExport = vi.fn();
      render(<VideoTimeline {...defaultProps} onExport={onExport} />);

      const exportButton = screen.getByRole('button', { name: /export/i });
      fireEvent.click(exportButton);

      expect(onExport).toHaveBeenCalledTimes(1);
    });
  });

  describe('zoom controls', () => {
    it('should increase zoom when zoom in button is clicked', () => {
      const initialZoom = 0.05;
      useVideoEditorStore.setState({ timelineZoom: initialZoom });

      const { container } = render(<VideoTimeline {...defaultProps} />);

      // Zoom buttons are glass-btn with size h-7 w-7
      const zoomButtons = container.querySelectorAll('.glass-btn.h-7.w-7');
      // Zoom in is the second one (after zoom out)
      const zoomInButton = zoomButtons[1];

      if (zoomInButton) {
        fireEvent.click(zoomInButton);
      }

      // Zoom should increase by factor of 1.5
      expect(useVideoEditorStore.getState().timelineZoom).toBeGreaterThan(initialZoom);
    });

    it('should decrease zoom when zoom out button is clicked', () => {
      const initialZoom = 0.05;
      useVideoEditorStore.setState({ timelineZoom: initialZoom });

      const { container } = render(<VideoTimeline {...defaultProps} />);

      // Zoom buttons are glass-btn with size h-7 w-7
      const zoomButtons = container.querySelectorAll('.glass-btn.h-7.w-7');
      // Zoom out is the first one
      const zoomOutButton = zoomButtons[0];

      if (zoomOutButton) {
        fireEvent.click(zoomOutButton);
      }

      // Zoom should decrease by factor of 1.5
      expect(useVideoEditorStore.getState().timelineZoom).toBeLessThan(initialZoom);
    });

    it('should handle ctrl+wheel to zoom timeline', () => {
      const initialZoom = 0.05;
      useVideoEditorStore.setState({ timelineZoom: initialZoom });

      const { container } = render(<VideoTimeline {...defaultProps} />);

      // Find the scrollable container
      const scrollContainer = container.querySelector('.overflow-x-auto');
      expect(scrollContainer).toBeInTheDocument();

      if (scrollContainer) {
        // Scroll up (zoom in) with ctrl key
        fireEvent.wheel(scrollContainer, { deltaY: -100, ctrlKey: true });

        // Zoom should increase
        expect(useVideoEditorStore.getState().timelineZoom).toBeGreaterThan(initialZoom);
      }
    });

    it('should not zoom when wheel without ctrl key', () => {
      const initialZoom = 0.05;
      useVideoEditorStore.setState({ timelineZoom: initialZoom });

      const { container } = render(<VideoTimeline {...defaultProps} />);

      const scrollContainer = container.querySelector('.overflow-x-auto');

      if (scrollContainer) {
        // Scroll without ctrl key
        fireEvent.wheel(scrollContainer, { deltaY: -100 });

        // Zoom should remain the same
        expect(useVideoEditorStore.getState().timelineZoom).toBe(initialZoom);
      }
    });
  });

  describe('time display', () => {
    it('should display formatted current time and duration', async () => {
      useVideoEditorStore.setState({
        project: createMockProject({
          timeline: {
            durationMs: 65000, // 1:05
            trimStart: 0,
            trimEnd: 65000,
            inPoint: 0,
            outPoint: 65000,
            cuts: [],
          },
        }),
        currentTimeMs: 5000, // 0:05
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      // Time display is in the header with tabular-nums class
      const timeDisplay = container!.querySelector('.tabular-nums');
      expect(timeDisplay).toBeInTheDocument();
      // Should show current time (0:05) and duration (1:05)
      expect(timeDisplay?.textContent).toContain('0:05');
      expect(timeDisplay?.textContent).toContain('1:05');
    });
  });

  describe('track visibility', () => {
    it('should hide tracks when visibility is false', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        trackVisibility: {
          video: true,
          text: false,
          mask: false,
          zoom: false,
          scene: true,
        },
      });

      await act(async () => {
        render(<VideoTimeline {...defaultProps} />);
      });

      expect(screen.getByText('Video')).toBeInTheDocument();
      expect(screen.queryByText('Text')).not.toBeInTheDocument();
      expect(screen.queryByText('Mask')).not.toBeInTheDocument();
      expect(screen.queryByText('Zoom')).not.toBeInTheDocument();
    });
  });

  describe('preview scrubber', () => {
    it('should not show preview scrubber when playing', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        isPlaying: true,
        previewTimeMs: 5000,
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      // Preview scrubber has a specific structure with ink-muted background
      // When playing, the preview scrubber should not be rendered even if previewTimeMs is set
      // The PreviewScrubber component is conditionally rendered based on !isPlaying
      // Look for the specific preview scrubber element (z-20 with ink-muted background)
      const previewScrubber = container!.querySelector('.z-20.bg-\\[var\\(--ink-muted\\)\\]');
      expect(previewScrubber).not.toBeInTheDocument();
    });

    it('should show preview scrubber when not playing and preview time is set', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        isPlaying: false,
        previewTimeMs: 5000,
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      // Preview scrubber should be visible when not playing
      // It has z-20 class and ink-muted background
      const previewScrubber = container!.querySelector('.z-20.pointer-events-none');
      expect(previewScrubber).toBeInTheDocument();
    });
  });

  describe('playhead dragging', () => {
    it('should set isDraggingPlayhead when playhead is mousedown', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        currentTimeMs: 5000,
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      // Find the playhead (coral colored vertical line with cursor-grab)
      const playhead = container!.querySelector('.cursor-grab');
      expect(playhead).toBeInTheDocument();

      if (playhead) {
        fireEvent.mouseDown(playhead);
        expect(useVideoEditorStore.getState().isDraggingPlayhead).toBe(true);
      }
    });

    it('should change cursor style when dragging playhead', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        currentTimeMs: 5000,
        isDraggingPlayhead: true,
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      // When dragging, the playhead should have cursor-grabbing class
      const playhead = container!.querySelector('.cursor-grabbing');
      expect(playhead).toBeInTheDocument();
    });
  });

  describe('video track content', () => {
    it('should display Recording label in video track', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        trackVisibility: {
          video: true,
          text: true,
          mask: true,
          zoom: true,
          scene: true,
        },
      });

      await act(async () => {
        render(<VideoTimeline {...defaultProps} />);
      });

      expect(screen.getByText('Recording')).toBeInTheDocument();
    });
  });

  describe('scroll handling', () => {
    it('should update scroll position in store when scrolling', async () => {
      useVideoEditorStore.setState({
        project: createMockProject(),
        timelineScrollLeft: 0,
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      const scrollContainer = container!.querySelector('.overflow-x-auto');
      expect(scrollContainer).toBeInTheDocument();

      if (scrollContainer) {
        // Simulate scroll event
        Object.defineProperty(scrollContainer, 'scrollLeft', { value: 100, writable: true });
        fireEvent.scroll(scrollContainer);

        expect(useVideoEditorStore.getState().timelineScrollLeft).toBe(100);
      }
    });
  });

  describe('timeline click to seek', () => {
    it('should update current time when clicking on timeline', async () => {
      useVideoEditorStore.setState({
        project: createMockProject({
          timeline: {
            durationMs: 10000,
            trimStart: 0,
            trimEnd: 10000,
            inPoint: 0,
            outPoint: 10000,
            cuts: [],
          },
        }),
        currentTimeMs: 0,
        timelineZoom: 0.1, // 100px per second
      });

      let container: HTMLElement;
      await act(async () => {
        const result = render(<VideoTimeline {...defaultProps} />);
        container = result.container;
      });

      // Find the clickable timeline area (the relative container inside scroll area)
      const scrollContainer = container!.querySelector('.overflow-x-auto');
      const timelineArea = scrollContainer?.querySelector('.relative');
      expect(timelineArea).toBeInTheDocument();

      if (timelineArea) {
        // Mock getBoundingClientRect for the click calculation
        const originalGetBoundingClientRect = timelineArea.getBoundingClientRect;
        timelineArea.getBoundingClientRect = () => ({
          left: 0,
          top: 0,
          right: 1000,
          bottom: 200,
          width: 1000,
          height: 200,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        });

        // Click at x=500 with zoom 0.1 (100px/s) = 5000ms
        fireEvent.click(timelineArea, { clientX: 500 });

        // Restore
        timelineArea.getBoundingClientRect = originalGetBoundingClientRect;

        // Current time should be updated (approximately 5000ms)
        expect(useVideoEditorStore.getState().currentTimeMs).toBe(5000);
      }
    });
  });
});
