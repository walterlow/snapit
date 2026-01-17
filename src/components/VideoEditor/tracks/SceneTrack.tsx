import { memo, useCallback, useMemo, useRef } from 'react';
import { Camera, Monitor, Video, Plus, GripVertical } from 'lucide-react';
import type { SceneSegment, SceneMode } from '../../../types';
import { useVideoEditorStore, formatTimeSimple } from '../../../stores/videoEditorStore';
import type { DragEdge } from './BaseTrack';

// Drag state stored in ref to avoid re-renders during drag
interface DragState {
  startMs: number;
  endMs: number;
}

interface SceneTrackProps {
  segments: SceneSegment[];
  defaultMode: SceneMode;
  durationMs: number;
  timelineZoom: number;
  width?: number;
}

// Generate unique IDs for segments
let segmentIdCounter = 0;
const generateSegmentId = () => `scene-${Date.now()}-${++segmentIdCounter}`;

// Default segment duration when adding new segments (3 seconds)
const DEFAULT_SEGMENT_DURATION_MS = 3000;
// Minimum duration to allow adding a segment (500ms)
const MIN_SEGMENT_DURATION_MS = 500;

// CSS variable keys for different scene modes (theme-aware)
const SCENE_MODE_VARS: Record<SceneMode, { bg: string; border: string; text: string }> = {
  default: {
    bg: 'var(--track-scene-default-bg)',
    border: 'var(--track-scene-default-border)',
    text: 'var(--track-scene-default-text)',
  },
  cameraOnly: {
    bg: 'var(--track-scene-camera-bg)',
    border: 'var(--track-scene-camera-border)',
    text: 'var(--track-scene-camera-text)',
  },
  screenOnly: {
    bg: 'var(--track-scene-screen-bg)',
    border: 'var(--track-scene-screen-border)',
    text: 'var(--track-scene-screen-text)',
  },
};

const SCENE_MODE_ICONS: Record<SceneMode, typeof Camera> = {
  default: Video,
  cameraOnly: Camera,
  screenOnly: Monitor,
};

/**
 * SceneSegmentItem component for rendering individual scene segments.
 * Uses refs for intermediate drag state to avoid re-renders during drag.
 *
 * Note: SceneTrack has unique styling per mode, so we use a custom implementation
 * rather than BaseSegmentItem to handle the mode-specific colors.
 */
const SceneSegmentItem = memo(function SceneSegmentItem({
  segment,
  isSelected,
  timelineZoom,
  durationMs,
  onSelect,
  onUpdate,
  onDelete,
  onDragStart,
}: {
  segment: SceneSegment;
  isSelected: boolean;
  timelineZoom: number;
  durationMs: number;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<SceneSegment>) => void;
  onDelete: (id: string) => void;
  onDragStart: (dragging: boolean, edge?: DragEdge) => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const left = segment.startMs * timelineZoom;
  const segmentWidth = (segment.endMs - segment.startMs) * timelineZoom;
  const vars = SCENE_MODE_VARS[segment.mode];
  const Icon = SCENE_MODE_ICONS[segment.mode];

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [onSelect, segment.id]);

  const handlePointerDown = useCallback((
    e: React.PointerEvent,
    edge: DragEdge
  ) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer to prevent flickering when cursor leaves element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    onSelect(segment.id);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? segment.endMs : segment.startMs;
    const segmentDuration = segment.endMs - segment.startMs;

    // Initialize drag state
    dragStateRef.current = { startMs: segment.startMs, endMs: segment.endMs };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;

      let newStartMs = dragStateRef.current!.startMs;
      let newEndMs = dragStateRef.current!.endMs;

      if (edge === 'start') {
        newStartMs = Math.max(0, Math.min(segment.endMs - MIN_SEGMENT_DURATION_MS, startTimeMs + deltaMs));
        newEndMs = segment.endMs;
      } else if (edge === 'end') {
        newStartMs = segment.startMs;
        newEndMs = Math.max(segment.startMs + MIN_SEGMENT_DURATION_MS, Math.min(durationMs, startTimeMs + deltaMs));
      } else {
        newStartMs = startTimeMs + deltaMs;
        newEndMs = newStartMs + segmentDuration;

        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = segmentDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - segmentDuration;
        }
      }

      // Update ref state
      dragStateRef.current = { startMs: newStartMs, endMs: newEndMs };

      // Update DOM directly (no re-render)
      if (elementRef.current) {
        const newLeft = newStartMs * timelineZoom;
        const newWidth = (newEndMs - newStartMs) * timelineZoom;
        elementRef.current.style.left = `${newLeft}px`;
        elementRef.current.style.width = `${Math.max(newWidth, 20)}px`;
      }

      // Update tooltip if visible
      if (tooltipRef.current) {
        tooltipRef.current.textContent = `${formatTimeSimple(newStartMs)} - ${formatTimeSimple(newEndMs)}`;
      }
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      // Release pointer capture
      (upEvent.target as HTMLElement).releasePointerCapture(upEvent.pointerId);

      // Commit final state to store
      if (dragStateRef.current) {
        const { startMs, endMs } = dragStateRef.current;
        if (startMs !== segment.startMs || endMs !== segment.endMs) {
          onUpdate(segment.id, { startMs, endMs });
        }
      }
      dragStateRef.current = null;
      onDragStart(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [segment, durationMs, timelineZoom, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(segment.id);
  }, [onDelete, segment.id]);

  return (
    <div
      ref={elementRef}
      data-segment
      className={`absolute top-1 bottom-1 rounded-md cursor-pointer
        ${isSelected ? 'ring-2 border-transparent shadow-lg' : 'border'}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(segmentWidth, 20)}px`,
        backgroundColor: vars.bg,
        borderColor: vars.border,
        '--tw-ring-color': vars.border,
      } as React.CSSProperties}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'start')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = vars.bg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'move')}
      >
        {segmentWidth > 60 && (
          <div className="flex items-center gap-1" style={{ color: vars.text }}>
            <GripVertical className="w-3 h-3" />
            <Icon className="w-3 h-3" />
          </div>
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'end')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = vars.bg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Delete button (shown when selected) */}
      {isSelected && (
        <button
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-xs shadow-md"
          onClick={handleDelete}
        >
          x
        </button>
      )}

      {/* Tooltip showing time range */}
      {isSelected && (
        <div
          ref={tooltipRef}
          className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-[var(--glass-bg-solid)] border border-[var(--glass-border)] text-[var(--ink-dark)] text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-20 shadow-sm"
        >
          {formatTimeSimple(segment.startMs)} - {formatTimeSimple(segment.endMs)}
        </div>
      )}
    </div>
  );
});

/**
 * Preview segment shown when hovering over empty track space.
 */
const PreviewSegment = memo(function PreviewSegment({
  startMs,
  endMs,
  mode,
  timelineZoom,
}: {
  startMs: number;
  endMs: number;
  mode: SceneMode;
  timelineZoom: number;
}) {
  const left = startMs * timelineZoom;
  const width = (endMs - startMs) * timelineZoom;
  const vars = SCENE_MODE_VARS[mode];

  return (
    <div
      className="absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none opacity-70"
      style={{
        left,
        width: Math.max(width, 40),
        backgroundColor: vars.bg,
        borderColor: vars.border,
      }}
    >
      <div className="flex items-center justify-center h-full" style={{ color: vars.text }}>
        <Plus className="h-4 w-4" />
      </div>
    </div>
  );
});

/**
 * Hook for scene track preview segment calculation.
 * Shared between SceneTrack and SceneTrackContent.
 */
function useScenePreviewSegment(
  segments: SceneSegment[],
  defaultMode: SceneMode,
  durationMs: number,
  hoveredTrack: string | null,
  previewTimeMs: number | null,
  isPlaying: boolean,
  isDraggingAny: boolean
) {
  return useMemo(() => {
    // Only show preview when hovering over this track, not playing, and not dragging
    if (hoveredTrack !== 'scene' || previewTimeMs === null || isPlaying || isDraggingAny) {
      return null;
    }

    // Check if hovering over an existing segment
    const isOnSegment = segments.some(
      (seg) => previewTimeMs >= seg.startMs && previewTimeMs <= seg.endMs
    );

    if (isOnSegment) {
      return null;
    }

    // Calculate preview segment bounds - left edge at playhead
    const startMs = previewTimeMs;
    const endMs = Math.min(durationMs, startMs + DEFAULT_SEGMENT_DURATION_MS);

    // Don't allow if there's not enough space for minimum duration
    if (endMs - startMs < MIN_SEGMENT_DURATION_MS) {
      return null;
    }

    // Check for collisions with existing segments and adjust
    for (const seg of segments) {
      // If preview would overlap with an existing segment, don't show it
      if (startMs < seg.endMs && endMs > seg.startMs) {
        return null;
      }
    }

    // Determine the mode for new segment (opposite of default for visibility)
    const newMode: SceneMode = defaultMode === 'default' ? 'cameraOnly' : 'default';

    return { startMs, endMs, mode: newMode };
  }, [hoveredTrack, previewTimeMs, isPlaying, isDraggingAny, segments, durationMs, defaultMode]);
}

/**
 * SceneTrack component for displaying and editing scene mode segments.
 *
 * Scene modes control how the video is displayed:
 * - Default: Screen with webcam overlay
 * - Camera Only: Fullscreen webcam
 * - Screen Only: Hide webcam
 */
export const SceneTrack = memo(function SceneTrack({
  segments,
  defaultMode,
  durationMs,
  timelineZoom,
}: SceneTrackProps) {
  const selectSceneSegment = useVideoEditorStore((s) => s.selectSceneSegment);
  const addSceneSegment = useVideoEditorStore((s) => s.addSceneSegment);
  const updateSceneSegment = useVideoEditorStore((s) => s.updateSceneSegment);
  const deleteSceneSegment = useVideoEditorStore((s) => s.deleteSceneSegment);
  const setDraggingSceneSegment = useVideoEditorStore((s) => s.setDraggingSceneSegment);
  const selectedSceneSegmentId = useVideoEditorStore((s) => s.selectedSceneSegmentId);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);
  const hoveredTrack = useVideoEditorStore((s) => s.hoveredTrack);
  const setHoveredTrack = useVideoEditorStore((s) => s.setHoveredTrack);
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);

  const totalWidth = durationMs * timelineZoom;

  // Check if any segment is being dragged
  const isDraggingAny = useVideoEditorStore((s) =>
    s.isDraggingZoomRegion || s.isDraggingSceneSegment || s.isDraggingMaskSegment || s.isDraggingTextSegment
  );

  const previewSegmentDetails = useScenePreviewSegment(
    segments, defaultMode, durationMs, hoveredTrack, previewTimeMs, isPlaying, isDraggingAny
  );

  // Handle track hover
  const handleMouseEnter = useCallback(() => {
    setHoveredTrack('scene');
  }, [setHoveredTrack]);

  const handleMouseLeave = useCallback(() => {
    setHoveredTrack(null);
  }, [setHoveredTrack]);

  // Handle click to add segment
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    // Only add if we have a valid preview segment
    if (!previewSegmentDetails) return;

    // Don't add if clicking on a segment
    if ((e.target as HTMLElement).closest('[data-segment]')) return;

    const newSegment: SceneSegment = {
      id: generateSegmentId(),
      startMs: previewSegmentDetails.startMs,
      endMs: previewSegmentDetails.endMs,
      mode: previewSegmentDetails.mode,
    };

    addSceneSegment(newSegment);
  }, [previewSegmentDetails, addSceneSegment]);

  return (
    <div className="h-full flex items-stretch border-b border-[var(--glass-border)]">
      {/* Track label - sticky to stay visible during horizontal scroll */}
      <div className="sticky left-0 flex-shrink-0 w-20 h-full bg-[var(--polar-mist)] border-r border-[var(--glass-border)] flex items-center justify-center z-10">
        <div className="flex items-center gap-1.5 text-[var(--ink-dark)]">
          <Video className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Scene</span>
        </div>
      </div>

      {/* Scene Segments */}
      <div
        className={`flex-1 relative bg-[var(--polar-mist)]/60 transition-colors ${
          hoveredTrack === 'scene' && previewSegmentDetails ? 'cursor-pointer' : ''
        }`}
        style={{ width: totalWidth }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleTrackClick}
      >
          {/* Render segments */}
        {segments.map((segment) => (
          <SceneSegmentItem
            key={segment.id}
            segment={segment}
            isSelected={selectedSceneSegmentId === segment.id}
            timelineZoom={timelineZoom}
            durationMs={durationMs}
            onSelect={selectSceneSegment}
            onUpdate={updateSceneSegment}
            onDelete={deleteSceneSegment}
            onDragStart={setDraggingSceneSegment}
          />
        ))}

        {/* Preview segment (ghost) when hovering over empty space */}
        {previewSegmentDetails && (
          <PreviewSegment
            startMs={previewSegmentDetails.startMs}
            endMs={previewSegmentDetails.endMs}
            mode={previewSegmentDetails.mode}
            timelineZoom={timelineZoom}
          />
        )}

        {/* Empty state hint */}
        {segments.length === 0 && !previewSegmentDetails && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-[10px] text-[var(--ink-subtle)]">
              Hover to add scene modes
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * SceneTrackContent - Track content without label for two-column layout.
 */
export const SceneTrackContent = memo(function SceneTrackContent({
  segments,
  defaultMode,
  durationMs,
  timelineZoom,
  width,
}: SceneTrackProps) {
  const selectSceneSegment = useVideoEditorStore((s) => s.selectSceneSegment);
  const addSceneSegment = useVideoEditorStore((s) => s.addSceneSegment);
  const updateSceneSegment = useVideoEditorStore((s) => s.updateSceneSegment);
  const deleteSceneSegment = useVideoEditorStore((s) => s.deleteSceneSegment);
  const setDraggingSceneSegment = useVideoEditorStore((s) => s.setDraggingSceneSegment);
  const selectedSceneSegmentId = useVideoEditorStore((s) => s.selectedSceneSegmentId);
  const previewTimeMs = useVideoEditorStore((s) => s.previewTimeMs);
  const hoveredTrack = useVideoEditorStore((s) => s.hoveredTrack);
  const setHoveredTrack = useVideoEditorStore((s) => s.setHoveredTrack);
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);

  // Check if any segment is being dragged
  const isDraggingAny = useVideoEditorStore((s) =>
    s.isDraggingZoomRegion || s.isDraggingSceneSegment || s.isDraggingMaskSegment || s.isDraggingTextSegment
  );

  const previewSegmentDetails = useScenePreviewSegment(
    segments, defaultMode, durationMs, hoveredTrack, previewTimeMs, isPlaying, isDraggingAny
  );

  // Handle track hover
  const handleMouseEnter = useCallback(() => {
    setHoveredTrack('scene');
  }, [setHoveredTrack]);

  const handleMouseLeave = useCallback(() => {
    setHoveredTrack(null);
  }, [setHoveredTrack]);

  // Handle click to add segment
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    // Only add if we have a valid preview segment
    if (!previewSegmentDetails) return;

    // Don't add if clicking on a segment
    if ((e.target as HTMLElement).closest('[data-segment]')) return;

    const newSegment: SceneSegment = {
      id: generateSegmentId(),
      startMs: previewSegmentDetails.startMs,
      endMs: previewSegmentDetails.endMs,
      mode: previewSegmentDetails.mode,
    };

    addSceneSegment(newSegment);
  }, [previewSegmentDetails, addSceneSegment]);

  return (
    <div
      className={`relative h-12 bg-[var(--polar-mist)]/60 border-b border-[var(--glass-border)] ${
        hoveredTrack === 'scene' && previewSegmentDetails ? 'cursor-pointer' : ''
      }`}
      style={{ width: width ? `${width}px` : undefined }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTrackClick}
    >
      {segments.map((segment) => (
        <SceneSegmentItem
          key={segment.id}
          segment={segment}
          isSelected={selectedSceneSegmentId === segment.id}
          timelineZoom={timelineZoom}
          durationMs={durationMs}
          onSelect={selectSceneSegment}
          onUpdate={updateSceneSegment}
          onDelete={deleteSceneSegment}
          onDragStart={setDraggingSceneSegment}
        />
      ))}

      {/* Preview segment (ghost) when hovering over empty space */}
      {previewSegmentDetails && (
        <PreviewSegment
          startMs={previewSegmentDetails.startMs}
          endMs={previewSegmentDetails.endMs}
          mode={previewSegmentDetails.mode}
          timelineZoom={timelineZoom}
        />
      )}

      {/* Empty state hint */}
      {segments.length === 0 && !previewSegmentDetails && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-[var(--ink-subtle)]">
            Hover to add scene modes
          </span>
        </div>
      )}
    </div>
  );
});
