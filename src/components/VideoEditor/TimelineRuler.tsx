import { memo, useMemo } from 'react';
import { formatTimeSimple } from '../../stores/videoEditorStore';

interface TimelineRulerProps {
  durationMs: number;
  timelineZoom: number; // px per ms
  width: number;
}

/**
 * TimelineRuler - Displays time markers along the top of the timeline.
 * Shows tick marks at regular intervals with time labels.
 * Memoized to prevent re-renders during playback.
 */
export const TimelineRuler = memo(function TimelineRuler({ durationMs, timelineZoom, width }: TimelineRulerProps) {
  // Calculate tick intervals based on zoom level
  const ticks = useMemo(() => {
    const pxPerSecond = timelineZoom * 1000;
    
    // Choose interval based on zoom level
    let majorMs: number;
    let minorMs: number;
    
    if (pxPerSecond < 20) {
      majorMs = 30000; // 30 seconds
      minorMs = 10000; // 10 seconds
    } else if (pxPerSecond < 50) {
      majorMs = 10000; // 10 seconds
      minorMs = 5000;  // 5 seconds
    } else if (pxPerSecond < 100) {
      majorMs = 5000;  // 5 seconds
      minorMs = 1000;  // 1 second
    } else {
      majorMs = 1000;  // 1 second
      minorMs = 500;   // 0.5 seconds
    }
    
    // Generate ticks
    const tickMarks: { timeMs: number; x: number; isMajor: boolean }[] = [];
    
    for (let t = 0; t <= durationMs; t += minorMs) {
      const isMajor = t % majorMs === 0;
      tickMarks.push({
        timeMs: t,
        x: t * timelineZoom,
        isMajor,
      });
    }
    
    return tickMarks;
  }, [durationMs, timelineZoom]);

  return (
    <div
      className="relative h-6 bg-[var(--polar-mist)] border-b border-[var(--glass-border)]"
      style={{ width: `${width}px` }}
    >
      {/* Tick marks */}
      {ticks.map((tick) => (
        <div
          key={tick.timeMs}
          className="absolute top-0 flex flex-col items-center"
          style={{ left: `${tick.x}px` }}
        >
          {/* Tick line */}
          <div
            className={`w-px ${
              tick.isMajor
                ? 'h-3 bg-[var(--ink-muted)]'
                : 'h-2 bg-[var(--ink-subtle)]/50'
            }`}
          />

          {/* Time label (only for major ticks) */}
          {tick.isMajor && (
            <span className="text-[10px] text-[var(--ink-muted)] font-mono mt-0.5 select-none">
              {formatTimeSimple(tick.timeMs)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});
