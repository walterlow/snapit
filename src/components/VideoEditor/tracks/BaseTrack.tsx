import { memo, useCallback, useRef, type ReactNode, type RefObject, type JSX } from 'react';
import { GripVertical } from 'lucide-react';
import { formatTimeSimple } from '../../../stores/videoEditorStore';

// ============================================================================
// Types
// ============================================================================

/** Drag edge for resize/move operations */
export type DragEdge = 'start' | 'end' | 'move';

/** Internal drag state stored in ref to avoid re-renders during drag */
interface DragState {
  startMs: number;
  endMs: number;
}

/** Base segment interface - all segments must have these time properties */
export interface BaseSegment {
  id: string;
  startMs: number;
  endMs: number;
}

/** Props for the BaseSegmentItem component */
export interface BaseSegmentItemProps<T extends BaseSegment> {
  /** The segment data */
  segment: T;
  /** Whether this segment is currently selected */
  isSelected: boolean;
  /** Timeline zoom level (pixels per millisecond) */
  timelineZoom: number;
  /** Total duration of the timeline in milliseconds */
  durationMs: number;
  /** Minimum segment duration in milliseconds (default: 500) */
  minDurationMs?: number;
  /** Callback when segment is selected */
  onSelect: (id: string) => void;
  /** Callback when segment is updated */
  onUpdate: (id: string, updates: Partial<T>) => void;
  /** Callback when segment is deleted */
  onDelete: (id: string) => void;
  /** Callback when drag starts/ends */
  onDragStart: (dragging: boolean, edge?: DragEdge) => void;
  /** Custom content to render in the center of the segment */
  renderContent?: (segment: T, width: number) => ReactNode;
  /** CSS variable for background color */
  bgColor: string;
  /** CSS variable for background color when selected */
  bgColorSelected: string;
  /** CSS variable for border color */
  borderColor: string;
  /** CSS variable for border color when selected */
  borderColorSelected: string;
  /** CSS variable for hover color on resize handles */
  hoverColor: string;
  /** CSS variable for text color */
  textColor: string;
  /** Data attribute for the segment element (e.g., 'data-segment', 'data-region') */
  dataAttribute?: string;
  /** Additional className for the segment container */
  className?: string;
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook that provides drag handling logic for timeline segments.
 * Uses refs for intermediate state to avoid re-renders during drag.
 */
export function useSegmentDrag<T extends BaseSegment>({
  segment,
  timelineZoom,
  durationMs,
  minDurationMs = 500,
  elementRef,
  tooltipRef,
  onSelect,
  onUpdate,
  onDragStart,
}: {
  segment: T;
  timelineZoom: number;
  durationMs: number;
  minDurationMs?: number;
  elementRef: RefObject<HTMLDivElement | null>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<T>) => void;
  onDragStart: (dragging: boolean, edge?: DragEdge) => void;
}) {
  const dragStateRef = useRef<DragState | null>(null);

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
        newStartMs = Math.max(0, Math.min(segment.endMs - minDurationMs, startTimeMs + deltaMs));
        newEndMs = segment.endMs;
      } else if (edge === 'end') {
        newStartMs = segment.startMs;
        newEndMs = Math.max(segment.startMs + minDurationMs, Math.min(durationMs, startTimeMs + deltaMs));
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
          onUpdate(segment.id, { startMs, endMs } as Partial<T>);
        }
      }
      dragStateRef.current = null;
      onDragStart(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [segment, durationMs, timelineZoom, minDurationMs, elementRef, tooltipRef, onSelect, onUpdate, onDragStart]);

  return { handlePointerDown, dragStateRef };
}

// ============================================================================
// Components
// ============================================================================

/**
 * BaseSegmentItem - Reusable segment component with drag/resize functionality.
 *
 * This component provides:
 * - Left/right resize handles
 * - Center drag handle for moving
 * - Delete button when selected
 * - Time range tooltip when selected
 * - Customizable styling via CSS variables
 * - Performance-optimized drag with direct DOM updates
 */
export const BaseSegmentItem = memo(function BaseSegmentItem<T extends BaseSegment>({
  segment,
  isSelected,
  timelineZoom,
  durationMs,
  minDurationMs = 500,
  onSelect,
  onUpdate,
  onDelete,
  onDragStart,
  renderContent,
  bgColor,
  bgColorSelected,
  borderColor,
  borderColorSelected,
  hoverColor,
  textColor,
  dataAttribute = 'data-segment',
  className = '',
}: BaseSegmentItemProps<T>) {
  const elementRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const left = segment.startMs * timelineZoom;
  const segmentWidth = (segment.endMs - segment.startMs) * timelineZoom;

  const { handlePointerDown } = useSegmentDrag({
    segment,
    timelineZoom,
    durationMs,
    minDurationMs,
    elementRef,
    tooltipRef,
    onSelect,
    onUpdate,
    onDragStart,
  });

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [onSelect, segment.id]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(segment.id);
  }, [onDelete, segment.id]);

  // Build the data attribute props object
  const dataAttributeProps = { [dataAttribute]: true };

  return (
    <div
      ref={elementRef}
      {...dataAttributeProps}
      className={`
        absolute top-1 bottom-1 rounded-md cursor-pointer
        ${isSelected ? 'border-2 shadow-lg' : 'border'}
        ${className}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(segmentWidth, 20)}px`,
        backgroundColor: isSelected ? bgColorSelected : bgColor,
        borderColor: isSelected ? borderColorSelected : borderColor,
      }}
      onClick={handleClick}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'start')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverColor)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      />

      {/* Center drag handle */}
      <div
        className="absolute inset-x-2 top-0 bottom-0 cursor-move flex items-center justify-center touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'move')}
      >
        {renderContent ? (
          renderContent(segment, segmentWidth)
        ) : (
          segmentWidth > 60 && (
            <div className="flex items-center gap-1" style={{ color: textColor }}>
              <GripVertical className="w-3 h-3" />
            </div>
          )
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md touch-none"
        onPointerDown={(e) => handlePointerDown(e, 'end')}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverColor)}
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
}) as <T extends BaseSegment>(props: BaseSegmentItemProps<T>) => JSX.Element;

/**
 * Default content renderer that shows a grip icon and optional label.
 */
export function DefaultSegmentContent({
  width,
  icon,
  label,
  textColor,
}: {
  width: number;
  icon?: ReactNode;
  label?: string;
  textColor: string;
}) {
  if (width <= 60) return null;

  return (
    <div className="flex items-center gap-1" style={{ color: textColor }}>
      <GripVertical className="w-3 h-3" />
      {icon}
      {label && <span className="text-[10px] font-mono">{label}</span>}
    </div>
  );
}
