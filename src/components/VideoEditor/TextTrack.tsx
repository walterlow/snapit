import { memo, useCallback } from 'react';
import { Type } from 'lucide-react';
import type { TextSegment } from '../../types';
import { useVideoEditorStore } from '../../stores/videoEditorStore';

interface TextTrackProps {
  segments: TextSegment[];
  durationMs: number;
  timelineZoom: number;
}

/**
 * TextSegmentItem component for rendering individual text segments.
 */
const TextSegmentItem = memo(function TextSegmentItem({
  segment,
  isSelected,
  timelineZoom,
  onSelect,
}: {
  segment: TextSegment;
  isSelected: boolean;
  timelineZoom: number;
  onSelect: (id: string) => void;
}) {
  const left = segment.startMs * timelineZoom;
  const width = (segment.endMs - segment.startMs) * timelineZoom;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [onSelect, segment.id]);

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-md border cursor-pointer transition-all
        bg-rose-500/20 border-rose-500/40
        ${isSelected ? 'ring-2 ring-white/30' : 'hover:ring-1 hover:ring-white/20'}
      `}
      style={{ left, width: Math.max(width, 40) }}
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5 px-2 h-full overflow-hidden">
        <Type className="h-3 w-3 flex-shrink-0 text-rose-400" />
        {width > 60 && (
          <span className="text-[10px] font-medium truncate text-rose-400">
            {segment.text || 'Text'}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * TextTrack component for displaying and editing text overlay segments.
 */
export const TextTrack = memo(function TextTrack({
  segments,
  durationMs,
  timelineZoom,
}: TextTrackProps) {
  const selectTextSegment = useVideoEditorStore((s) => s.selectTextSegment);
  const selectedTextSegmentId = useVideoEditorStore((s) => s.selectedTextSegmentId);

  const totalWidth = durationMs * timelineZoom;

  return (
    <div className="h-full flex items-stretch">
      {/* Track Label */}
      <div className="flex-shrink-0 w-[100px] bg-zinc-900 border-r border-zinc-800 flex items-center gap-2 px-3">
        <Type className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-xs text-zinc-400">Text</span>
      </div>

      {/* Text Segments */}
      <div
        className="flex-1 relative bg-zinc-900/30"
        style={{ width: totalWidth }}
      >
        {/* Render segments */}
        {segments.map((segment) => (
          <TextSegmentItem
            key={segment.id}
            segment={segment}
            isSelected={selectedTextSegmentId === segment.id}
            timelineZoom={timelineZoom}
            onSelect={selectTextSegment}
          />
        ))}

        {/* Empty state hint */}
        {segments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-[10px] text-zinc-500">
              Click to add text overlays
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
