import { memo, useCallback, useRef, useState, useEffect } from 'react';
import { TIMING } from '@/constants';
import {
  Film,
  Download,
  ZoomIn,
  ZoomOut,
  Maximize2,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Type,
  Video,
  EyeOff,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { videoEditorLogger } from '@/utils/logger';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useVideoEditorStore, formatTimeSimple } from '../../stores/videoEditorStore';
import { usePlaybackTime, usePlaybackControls, getPlaybackState } from '../../hooks/usePlaybackEngine';
import { TimelineRuler } from './TimelineRuler';
import { ZoomTrackContent, SceneTrackContent, MaskTrackContent, TextTrackContent } from './tracks';
import { TrackManager } from './TrackManager';
import type { AudioWaveform } from '../../types';

// Selectors to prevent re-renders from unrelated store changes
const selectProject = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.project;
const selectTimelineZoom = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.timelineZoom;
const selectIsDraggingPlayhead = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isDraggingPlayhead;
const selectIsPlaying = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.isPlaying;
const selectPreviewTimeMs = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.previewTimeMs;
const selectTrackVisibility = (s: ReturnType<typeof useVideoEditorStore.getState>) => s.trackVisibility;

/**
 * Preview scrubber - ghost playhead that follows mouse when not playing.
 */
const PreviewScrubber = memo(function PreviewScrubber({
  previewTimeMs,
  timelineZoom,
  trackLabelWidth,
}: {
  previewTimeMs: number;
  timelineZoom: number;
  trackLabelWidth: number;
}) {
  const position = previewTimeMs * timelineZoom + trackLabelWidth;

  return (
    <div
      className="absolute top-0 bottom-0 w-0.5 z-20 pointer-events-none bg-[var(--ink-muted)]"
      style={{ left: `${position}px` }}
    >
      {/* Scrubber handle */}
      <div
        className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-4 rounded-b-sm bg-[var(--ink-muted)]"
        style={{
          clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
        }}
      />
      {/* Time tooltip */}
      <div
        className="absolute top-5 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-[var(--glass-bg-solid)] border border-[var(--glass-border)] rounded text-[10px] font-mono text-[var(--ink-dark)] whitespace-nowrap shadow-lg"
      >
        {formatTimeSimple(previewTimeMs)}
      </div>
    </div>
  );
});

interface VideoTimelineProps {
  onExport: () => void;
}

/**
 * Time display component - uses usePlaybackTime for smooth updates.
 */
const TimeDisplay = memo(function TimeDisplay({ durationMs }: { durationMs: number }) {
  const currentTimeMs = usePlaybackTime();

  return (
    <div className="px-2 py-0.5 bg-[var(--polar-mist)]/60 rounded text-xs font-mono text-[var(--ink-dark)] tabular-nums">
      {formatTimeSimple(currentTimeMs)}
      <span className="text-[var(--ink-subtle)] mx-1">/</span>
      <span className="text-[var(--ink-subtle)]">{formatTimeSimple(durationMs)}</span>
    </div>
  );
});

/**
 * Memoized playhead component - only re-renders when position changes.
 * Uses usePlaybackTime for 60fps updates without triggering parent re-renders.
 */
const Playhead = memo(function Playhead({
  timelineZoom,
  trackLabelWidth,
  isDragging,
  onMouseDown,
}: {
  timelineZoom: number;
  trackLabelWidth: number;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const currentTimeMs = usePlaybackTime();
  const playheadPosition = currentTimeMs * timelineZoom + trackLabelWidth;

  return (
    <div
      className={`
        absolute top-0 bottom-0 w-0.5 z-30 pointer-events-auto
        ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}
      `}
      style={{ 
        left: `${playheadPosition}px`,
        backgroundColor: 'var(--coral-400)',
      }}
      onMouseDown={onMouseDown}
    >
      {/* Playhead handle */}
      <div 
        className={`
          absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-4 rounded-b-sm
          shadow-lg
          ${isDragging ? 'scale-110' : 'hover:scale-105'}
          transition-transform
        `}
        style={{
          clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
          backgroundColor: 'var(--coral-400)',
          boxShadow: '0 10px 15px -3px rgba(249, 112, 102, 0.3)',
        }}
      />
      
      {/* Time indicator (shown when dragging) */}
      {isDragging && (
        <PlayheadTimeIndicator />
      )}
    </div>
  );
});

/**
 * Separate component for the time indicator to minimize re-renders.
 */
const PlayheadTimeIndicator = memo(function PlayheadTimeIndicator() {
  const currentTimeMs = usePlaybackTime();
  
  return (
    <div 
      className="absolute top-5 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-[var(--polar-ice)] rounded text-[10px] font-mono whitespace-nowrap shadow-lg"
      style={{ 
        borderColor: 'rgba(249, 112, 102, 0.5)',
        borderWidth: '1px',
        color: 'var(--coral-300)',
      }}
    >
      {Math.floor(currentTimeMs / 60000)}:{String(Math.floor((currentTimeMs % 60000) / 1000)).padStart(2, '0')}
    </div>
  );
});

/**
 * WaveformCanvas - Renders audio waveform on canvas.
 * Samples are normalized linear values (-1.0 to 1.0).
 */
const WaveformCanvas = memo(function WaveformCanvas({
  audioPath,
  width,
  height,
}: {
  audioPath: string;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waveform, setWaveform] = useState<AudioWaveform | null>(null);

  // Fetch waveform data
  useEffect(() => {
    if (!audioPath) return;

    let cancelled = false;

    async function loadWaveform() {
      try {
        const data = await invoke<AudioWaveform>('extract_audio_waveform', {
          audioPath,
          samplesPerSecond: 100,
        });

        if (!cancelled) {
          setWaveform(data);
        }
      } catch (err) {
        videoEditorLogger.error('WaveformCanvas failed to load waveform:', err);
      }
    }

    loadWaveform();

    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  // Render waveform to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform || waveform.samples.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    const { samples } = waveform;
    const centerY = height / 2;
    const maxAmplitude = height / 2 - 2;

    // Find the peak amplitude for normalization
    let peakAmplitude = 0;
    for (const sample of samples) {
      const abs = Math.abs(sample);
      if (abs > peakAmplitude) peakAmplitude = abs;
    }

    // Visual boost - normalize to peak and add minimum visibility
    // If peak is very low, boost more; if peak is high, boost less
    const visualGain = peakAmplitude > 0.01 ? Math.min(1 / peakAmplitude, 10) : 10;

    // Calculate samples per pixel
    const samplesPerPixel = samples.length / width;

    // Create gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(249, 112, 102, 0.7)'); // coral-400
    gradient.addColorStop(0.5, 'rgba(240, 68, 56, 0.5)'); // coral-500
    gradient.addColorStop(1, 'rgba(249, 112, 102, 0.7)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(0, centerY);

    // Draw top half - apply visual gain and clamp to max amplitude
    for (let x = 0; x < width; x++) {
      const sampleIndex = Math.floor(x * samplesPerPixel);
      const sample = samples[Math.min(sampleIndex, samples.length - 1)];
      const amplitude = Math.min(Math.abs(sample) * visualGain, 1) * maxAmplitude;
      ctx.lineTo(x, centerY - amplitude);
    }

    // Draw bottom half (mirror)
    for (let x = width - 1; x >= 0; x--) {
      const sampleIndex = Math.floor(x * samplesPerPixel);
      const sample = samples[Math.min(sampleIndex, samples.length - 1)];
      const amplitude = Math.min(Math.abs(sample) * visualGain, 1) * maxAmplitude;
      ctx.lineTo(x, centerY + amplitude);
    }

    ctx.closePath();
    ctx.fill();
  }, [waveform, width, height]);

  if (!waveform) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width, height }}
    />
  );
});

/**
 * Memoized video track content (without label) with thumbnails and waveform.
 */
const VideoTrackContent = memo(function VideoTrackContent({
  durationMs,
  timelineZoom,
  width,
  audioPath,
}: {
  durationMs: number;
  timelineZoom: number;
  width: number;
  audioPath?: string;
}) {
  const clipWidth = durationMs * timelineZoom;

  return (
    <div
      className="relative h-12 bg-[var(--polar-mist)]/60 border-b border-[var(--glass-border)]"
      style={{ width: `${width}px` }}
    >
      {/* Video clip item */}
      <div
        className="absolute top-1 bottom-1 rounded-md bg-[var(--coral-100)] border border-[var(--coral-200)] overflow-hidden"
        style={{ left: 0, width: `${clipWidth}px` }}
      >
        {/* Waveform overlay */}
        {audioPath && clipWidth > 0 && (
          <WaveformCanvas
            audioPath={audioPath}
            width={clipWidth}
            height={40}
          />
        )}

        {/* Clip label */}
        <div className="absolute top-0 left-0 right-0 flex items-center px-2 h-full pointer-events-none">
          <span className="text-[10px] text-[var(--coral-300)]/80 font-medium truncate drop-shadow-sm">
            Recording
          </span>
        </div>
      </div>
    </div>
  );
});

/**
 * VideoTimeline - Main timeline component with ruler, tracks, and playhead.
 * Optimized to prevent re-renders during playback.
 */
export function VideoTimeline({ onExport }: VideoTimelineProps) {
  const project = useVideoEditorStore(selectProject);
  const timelineZoom = useVideoEditorStore(selectTimelineZoom);
  const isDraggingPlayhead = useVideoEditorStore(selectIsDraggingPlayhead);
  const isPlaying = useVideoEditorStore(selectIsPlaying);
  const previewTimeMs = useVideoEditorStore(selectPreviewTimeMs);
  const trackVisibility = useVideoEditorStore(selectTrackVisibility);

  const {
    setTimelineScrollLeft,
    setTimelineContainerWidth,
    setDraggingPlayhead,
    setTimelineZoom,
    setPreviewTime,
    togglePlayback,
    fitTimelineToWindow,
  } = useVideoEditorStore();

  const controls = usePlaybackControls();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Measure container width and sync to store (debounced to avoid resize lag)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const updateWidth = (width: number) => {
      setContainerWidth(width);
      setTimelineContainerWidth(width);
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => updateWidth(width), TIMING.RESIZE_DEBOUNCE_MS);
      }
    });

    observer.observe(container);
    // Set initial width without debounce
    const initialWidth = container.clientWidth;
    updateWidth(initialWidth);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      observer.disconnect();
    };
  }, [setTimelineContainerWidth]);

  // Fit timeline to window when project loads and container is measured
  const projectId = project?.id;
  const hasContainerWidth = containerWidth > 0;
  useEffect(() => {
    if (projectId && hasContainerWidth) {
      fitTimelineToWindow();
    }
  }, [projectId, hasContainerWidth, fitTimelineToWindow]);

  // Clear preview time when playback starts
  useEffect(() => {
    if (isPlaying) {
      setPreviewTime(null);
    }
  }, [isPlaying, setPreviewTime]);

  // Calculate timeline dimensions - extend to fill container width at minimum
  const durationMs = project?.timeline.durationMs ?? 60000;
  const trackLabelWidth = 80;
  const durationWidth = durationMs * timelineZoom;
  const timelineWidth = Math.max(durationWidth, containerWidth - trackLabelWidth);

  // Handle clicking on timeline to seek (event is on content div which moves with scroll)
  // Keep any selected segments - user can click empty track area to deselect
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // No scroll offset needed - event target already accounts for scroll position
    const x = e.clientX - rect.left;
    const newTimeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
    controls.seek(newTimeMs);
  }, [durationMs, timelineZoom, controls]);

  // Handle mouse move for preview scrubber (event is on content div which moves with scroll)
  const handleTimelineMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isPlaying) {
      setPreviewTime(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // No scroll offset needed - event target already accounts for scroll position
    const x = e.clientX - rect.left;
    if (x < 0) {
      setPreviewTime(null);
      return;
    }
    const timeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
    setPreviewTime(timeMs);
  }, [isPlaying, durationMs, timelineZoom, setPreviewTime]);

  // Clear preview on mouse leave
  const handleTimelineMouseLeave = useCallback(() => {
    setPreviewTime(null);
  }, [setPreviewTime]);

  // Handle playhead dragging (content area, account for label column offset)
  const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingPlayhead(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const scrollContainer = scrollRef.current;
      if (!scrollContainer) return;

      const rect = scrollContainer.getBoundingClientRect();
      const scrollLeft = scrollContainer.scrollLeft;
      const x = moveEvent.clientX - rect.left + scrollLeft;
      const newTimeMs = Math.max(0, Math.min(durationMs, x / timelineZoom));
      controls.seek(newTimeMs);
    };

    const handleMouseUp = () => {
      setDraggingPlayhead(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [durationMs, timelineZoom, controls, setDraggingPlayhead]);

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setTimelineScrollLeft(e.currentTarget.scrollLeft);
  }, [setTimelineScrollLeft]);

  // Playback controls
  const handleGoToStart = useCallback(() => {
    controls.seek(0);
  }, [controls]);

  const handleGoToEnd = useCallback(() => {
    controls.seek(durationMs);
  }, [controls, durationMs]);

  const handleSkipBack = useCallback(() => {
    const { currentTimeMs } = getPlaybackState();
    controls.seek(Math.max(0, currentTimeMs - 5000));
  }, [controls]);

  const handleSkipForward = useCallback(() => {
    const { currentTimeMs } = getPlaybackState();
    controls.seek(Math.min(durationMs, currentTimeMs + 5000));
  }, [controls, durationMs]);

  // Timeline zoom controls
  const handleZoomIn = useCallback(() => {
    setTimelineZoom(timelineZoom * 1.5);
  }, [timelineZoom, setTimelineZoom]);

  const handleZoomOut = useCallback(() => {
    setTimelineZoom(timelineZoom / 1.5);
  }, [timelineZoom, setTimelineZoom]);

  // Ctrl + Mouse wheel to zoom timeline
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return;

    e.preventDefault();

    // Zoom factor - smaller for smoother zooming
    const zoomFactor = 1.15;

    if (e.deltaY < 0) {
      // Scroll up = zoom in
      setTimelineZoom(timelineZoom * zoomFactor);
    } else {
      // Scroll down = zoom out
      setTimelineZoom(timelineZoom / zoomFactor);
    }
  }, [timelineZoom, setTimelineZoom]);

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col bg-[var(--polar-ice)] border-t border-[var(--glass-border)]/50 select-none"
    >
      {/* Timeline Header with Controls */}
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center h-11 px-3 bg-[var(--glass-surface-dark)] border-b border-[var(--glass-border)]">
          {/* Left Section */}
          <div className="flex items-center gap-2">
            {/* Track Manager */}
            <TrackManager />
          </div>

          {/* Center Section - Playback Controls */}
          <div className="flex-1 flex items-center justify-center gap-1">
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleGoToStart} className="glass-btn h-8 w-8">
                    <SkipBack className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Go to Start</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">Home</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleSkipBack} className="glass-btn h-8 w-8">
                    <SkipBack className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Skip Back 5s</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">←</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={togglePlayback}
                    className="tool-button h-9 w-9 active"
                  >
                    {isPlaying ? (
                      <Pause className="w-4 h-4 relative z-10" />
                    ) : (
                      <Play className="w-4 h-4 ml-0.5 relative z-10" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{isPlaying ? 'Pause' : 'Play'}</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">Space</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleSkipForward} className="glass-btn h-8 w-8">
                    <SkipForward className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Skip Forward 5s</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">→</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleGoToEnd} className="glass-btn h-8 w-8">
                    <SkipForward className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Go to End</span>
                    <kbd className="kbd text-[10px] px-1.5 py-0.5">End</kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>

            <TimeDisplay durationMs={durationMs} />
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-2">
            {/* Timeline Zoom Controls */}
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleZoomOut} className="glass-btn h-7 w-7">
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Zoom Out Timeline</p>
                </TooltipContent>
              </Tooltip>

              <span className="text-[10px] text-[var(--ink-subtle)] font-mono w-12 text-center">
                {Math.round(timelineZoom * 1000)}px/s
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleZoomIn} className="glass-btn h-7 w-7">
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Zoom In Timeline</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={fitTimelineToWindow} className="glass-btn h-7 w-7">
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Fit Timeline to Window</p>
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="w-px h-5 bg-[var(--glass-border)]" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onExport}
                  className="btn-coral h-8 px-3 rounded-md flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">Export</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="flex items-center gap-2">
                  <span className="text-xs">Export Video</span>
                  <kbd className="kbd text-[10px] px-1.5 py-0.5">Ctrl+E</kbd>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* Two-Column Timeline Layout */}
      <div className="flex-1 flex min-h-0 min-w-0">
        {/* Fixed Track Labels Column */}
        <div className="flex-shrink-0 w-20 bg-[var(--polar-mist)] border-r border-[var(--glass-border)] z-20">
          {/* Ruler spacer */}
          <div className="h-8 border-b border-[var(--glass-border)]" />

          {/* Video label */}
          {trackVisibility.video && (
            <div className="h-12 border-b border-[var(--glass-border)] flex items-center justify-center">
              <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
                <Film className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">Video</span>
              </div>
            </div>
          )}

          {/* Text label */}
          {project && trackVisibility.text && (
            <div className="h-12 border-b border-[var(--glass-border)] flex items-center justify-center">
              <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
                <Type className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">Text</span>
              </div>
            </div>
          )}

          {/* Zoom label */}
          {project && trackVisibility.zoom && (
            <div className="h-12 border-b border-[var(--glass-border)] flex items-center justify-center">
              <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
                <ZoomIn className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">Zoom</span>
              </div>
            </div>
          )}

          {/* Scene label */}
          {project && project.sources.webcamVideo && trackVisibility.scene && (
            <div className="h-12 border-b border-[var(--glass-border)] flex items-center justify-center">
              <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
                <Video className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">Scene</span>
              </div>
            </div>
          )}

          {/* Mask label */}
          {project && trackVisibility.mask && (
            <div className="h-12 border-b border-[var(--glass-border)] flex items-center justify-center">
              <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
                <EyeOff className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">Mask</span>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Timeline Content */}
        <div
          ref={scrollRef}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-auto"
          onScroll={handleScroll}
          onWheel={handleWheel}
        >
          <div
            className="relative"
            style={{ width: `${timelineWidth}px` }}
            onClick={handleTimelineClick}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
          >
            {/* Time Ruler */}
            <TimelineRuler
              durationMs={durationMs}
              timelineZoom={timelineZoom}
              width={timelineWidth}
            />

            {/* Video Track Content */}
            {trackVisibility.video && (
              <VideoTrackContent
                durationMs={durationMs}
                timelineZoom={timelineZoom}
                width={timelineWidth}
                audioPath={project?.sources.systemAudio ?? project?.sources.microphoneAudio ?? project?.sources.screenVideo ?? undefined}
              />
            )}

            {/* Text Track Content */}
            {project && trackVisibility.text && (
              <TextTrackContent
                segments={project.text.segments}
                durationMs={durationMs}
                timelineZoom={timelineZoom}
                width={timelineWidth}
              />
            )}

            {/* Zoom Track Content */}
            {project && trackVisibility.zoom && (
              <ZoomTrackContent
                regions={project.zoom.regions}
                durationMs={durationMs}
                timelineZoom={timelineZoom}
                width={timelineWidth}
              />
            )}

            {/* Scene Track Content */}
            {project && project.sources.webcamVideo && trackVisibility.scene && (
              <SceneTrackContent
                segments={project.scene.segments}
                defaultMode={project.scene.defaultMode}
                durationMs={durationMs}
                timelineZoom={timelineZoom}
                width={timelineWidth}
              />
            )}

            {/* Mask Track Content */}
            {project && trackVisibility.mask && (
              <MaskTrackContent
                segments={project.mask.segments}
                durationMs={durationMs}
                timelineZoom={timelineZoom}
                width={timelineWidth}
              />
            )}

            {/* Preview Scrubber - only when not playing */}
            {!isPlaying && previewTimeMs !== null && (
              <PreviewScrubber
                previewTimeMs={previewTimeMs}
                timelineZoom={timelineZoom}
                trackLabelWidth={0}
              />
            )}

            {/* Playhead */}
            <Playhead
              timelineZoom={timelineZoom}
              trackLabelWidth={0}
              isDragging={isDraggingPlayhead}
              onMouseDown={handlePlayheadMouseDown}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
