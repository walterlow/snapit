import { memo, useCallback, useMemo } from 'react';
import { Camera, Monitor, Video, Plus, GripVertical } from 'lucide-react';
import type { SceneSegment, SceneMode } from '../../types';
import { useVideoEditorStore, formatTimeSimple } from '../../stores/videoEditorStore';

interface SceneTrackProps {
  segments: SceneSegment[];
  defaultMode: SceneMode;
  durationMs: number;
  timelineZoom: number;
}

// Generate unique IDs for segments
let segmentIdCounter = 0;
const generateSegmentId = () => `scene-${Date.now()}-${++segmentIdCounter}`;

// Default segment duration when adding new segments (3 seconds)
const DEFAULT_SEGMENT_DURATION_MS = 3000;

// Colors for different scene modes
const SCENE_MODE_COLORS: Record<SceneMode, { bg: string; border: string; text: string; ring: string }> = {
  default: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-400', ring: 'ring-emerald-400' },
  cameraOnly: { bg: 'bg-amber-500/20', border: 'border-amber-500/40', text: 'text-amber-400', ring: 'ring-amber-400' },
  screenOnly: { bg: 'bg-blue-500/20', border: 'border-blue-500/40', text: 'text-blue-400', ring: 'ring-blue-400' },
};

const SCENE_MODE_ICONS: Record<SceneMode, typeof Camera> = {
  default: Video,
  cameraOnly: Camera,
  screenOnly: Monitor,
};

// Labels can be used in tooltips if needed
// const SCENE_MODE_LABELS: Record<SceneMode, string> = {
//   default: 'Screen + Cam',
//   cameraOnly: 'Camera Only',
//   screenOnly: 'Screen Only',
// };

/**
 * SceneSegmentItem component for rendering individual scene segments.
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
  onDragStart: (dragging: boolean, edge?: 'start' | 'end' | 'move') => void;
}) {
  const left = segment.startMs * timelineZoom;
  const segmentWidth = (segment.endMs - segment.startMs) * timelineZoom;
  const colors = SCENE_MODE_COLORS[segment.mode];
  const Icon = SCENE_MODE_ICONS[segment.mode];

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [onSelect, segment.id]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    edge: 'start' | 'end' | 'move'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    onSelect(segment.id);
    onDragStart(true, edge);

    const startX = e.clientX;
    const startTimeMs = edge === 'end' ? segment.endMs : segment.startMs;
    const segmentDuration = segment.endMs - segment.startMs;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / timelineZoom;

      if (edge === 'start') {
        const newStartMs = Math.max(0, Math.min(segment.endMs - 500, startTimeMs + deltaMs));
        onUpdate(segment.id, { startMs: newStartMs });
      } else if (edge === 'end') {
        const newEndMs = Math.max(segment.startMs + 500, Math.min(durationMs, startTimeMs + deltaMs));
        onUpdate(segment.id, { endMs: newEndMs });
      } else {
        let newStartMs = startTimeMs + deltaMs;
        let newEndMs = newStartMs + segmentDuration;

        if (newStartMs < 0) {
          newStartMs = 0;
          newEndMs = segmentDuration;
        }
        if (newEndMs > durationMs) {
          newEndMs = durationMs;
          newStartMs = durationMs - segmentDuration;
        }

        onUpdate(segment.id, { startMs: newStartMs, endMs: newEndMs });
      }
    };

    const handleMouseUp = () => {
      onDragStart(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [segment, durationMs, timelineZoom, onSelect, onUpdate, onDragStart]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(segment.id);
  }, [onDelete, segment.id]);

  return (
    <div
      data-segment
      className={`absolute top-1 bottom-1 rounded-md cursor-pointer transition-all duration-100
        ${colors.bg} ${colors.border}
        ${isSelected
          ? `ring-2 ${colors.ring} border-transparent shadow-lg`
          : 'border hover:ring-1 hover:ring-white/20'
        }
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(segmentWidth, 20)}px`,
      }}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:${colors.bg} rounded-l-md`}
        onMouseDown={(e) => handleMouseDown(e, 'start')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
      >
        {segmentWidth > 60 && (
          <div className={`flex items-center gap-1 ${colors.text}`}>
            <GripVertical className="w-3 h-3" />
            <Icon className="w-3 h-3" />
          </div>
        )}
      </div>

      {/* Right resize handle */}
      <div
        className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:${colors.bg} rounded-r-md`}
        onMouseDown={(e) => handleMouseDown(e, 'end')}
      />

      {/* Delete button (shown when selected) */}
      {isSelected && segmentWidth > 40 && (
        <button
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-xs shadow-md"
          onClick={handleDelete}
        >
          ×
        </button>
      )}

      {/* Tooltip showing time range */}
      {isSelected && (
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-zinc-300 text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-20">
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
  const colors = SCENE_MODE_COLORS[mode];

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none
        ${colors.border} ${colors.bg} opacity-60
      `}
      style={{ left, width: Math.max(width, 40) }}
    >
      <div className="flex items-center justify-center h-full">
        <Plus className={`h-4 w-4 ${colors.text}`} />
      </div>
    </div>
  );
});

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
  const defaultColors = SCENE_MODE_COLORS[defaultMode];

  // Calculate preview segment details when hovering
  const previewSegmentDetails = useMemo(() => {
    // Only show preview when hovering over this track and not playing
    if (hoveredTrack !== 'scene' || previewTimeMs === null || isPlaying) {
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
  }, [hoveredTrack, previewTimeMs, isPlaying, segments, durationMs, defaultMode]);

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
    <div className="h-full flex items-stretch">
      {/* Track Label - must match VideoTimeline's trackLabelWidth (80px / w-20) */}
      <div className="flex-shrink-0 w-20 bg-zinc-900/80 border-r border-zinc-700/50 flex items-center justify-center">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <Video className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Scene</span>
        </div>
      </div>

      {/* Scene Segments */}
      <div
        className={`flex-1 relative bg-zinc-900/30 transition-colors ${
          hoveredTrack === 'scene' && previewSegmentDetails ? 'cursor-pointer' : ''
        }`}
        style={{ width: totalWidth }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleTrackClick}
      >
        {/* Default mode background */}
        <div
          className={`absolute inset-0 ${defaultColors.bg} opacity-30 pointer-events-none`}
        />

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
            <span className="text-[10px] text-zinc-500">
              Hover to add scene modes
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
