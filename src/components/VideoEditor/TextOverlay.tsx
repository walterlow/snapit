import { memo, useCallback, useState, useRef, useMemo } from 'react';
import type { TextSegment } from '../../types';
import { useVideoEditorStore } from '../../stores/videoEditorStore';

interface TextOverlayProps {
  segments: TextSegment[];
  currentTimeMs: number;
  previewWidth: number;
  previewHeight: number;
  videoAspectRatio: number;
  /** If true, render CSS text in bounding boxes. If false, show only bounding boxes (GPU preview renders text). */
  showTextContent?: boolean;
}

interface TextItemProps {
  segment: TextSegment;
  segmentId: string;
  isSelected: boolean;
  videoOffset: { x: number; y: number };
  videoSize: { width: number; height: number };
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<TextSegment>) => void;
  showTextContent: boolean;
}

interface ResizeHandleProps {
  position: 'nw' | 'ne' | 'sw' | 'se' | 'e' | 'w';
  onMouseDown: (e: React.MouseEvent) => void;
}

/**
 * Resize handle for corners and sides of the bounding box
 */
const ResizeHandle = memo(function ResizeHandle({ position, onMouseDown }: ResizeHandleProps) {
  const positionClasses: Record<string, string> = {
    nw: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize',
    ne: 'top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-ne-resize',
    sw: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-sw-resize',
    se: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-se-resize',
    e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-e-resize',
    w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-w-resize',
  };

  return (
    <div
      className={`absolute w-3 h-3 bg-blue-500 border border-white rounded-full shadow-sm transition-transform hover:scale-125 ${positionClasses[position]}`}
      onMouseDown={onMouseDown}
    />
  );
});

/**
 * Calculate video bounds within container (accounting for letterboxing)
 */
function calculateVideoBounds(
  containerWidth: number,
  containerHeight: number,
  videoAspectRatio: number
): { offsetX: number; offsetY: number; width: number; height: number } {
  const containerAspect = containerWidth / containerHeight;

  if (containerAspect > videoAspectRatio) {
    // Container is wider than video - pillarboxing (black bars on sides)
    const videoWidth = containerHeight * videoAspectRatio;
    const offsetX = (containerWidth - videoWidth) / 2;
    return { offsetX, offsetY: 0, width: videoWidth, height: containerHeight };
  } else {
    // Container is taller than video - letterboxing (black bars top/bottom)
    const videoHeight = containerWidth / videoAspectRatio;
    const offsetY = (containerHeight - videoHeight) / 2;
    return { offsetX: 0, offsetY, width: containerWidth, height: videoHeight };
  }
}

/**
 * Clamp a value between min and max, handling edge cases
 */
function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

/**
 * Individual text item with drag and resize support.
 *
 * Renders text using CSS for preview (may differ slightly from GPU export).
 * The export uses glyphon for GPU-accelerated text rendering.
 * Uses center-based positioning matching Cap's model.
 */
const TextItem = memo(function TextItem({
  segment,
  segmentId,
  isSelected,
  videoOffset,
  videoSize,
  onSelect,
  onUpdate,
  showTextContent,
}: TextItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    centerX: number;
    centerY: number;
    sizeX: number;
    sizeY: number;
    fontSize: number;
  } | null>(null);

  // Calculate pixel position from center-based normalized coordinates
  // Match glyphon's calculation exactly (min 1.0, not 20)
  const width = Math.max(segment.size.x * videoSize.width, 1);
  const height = Math.max(segment.size.y * videoSize.height, 1);
  const halfW = width / 2;
  const halfH = height / 2;
  // Match glyphon: left = (center.x * output_size.x - half_w).max(0.0)
  const left = Math.max(0, videoOffset.x + segment.center.x * videoSize.width - halfW);
  const top = Math.max(0, videoOffset.y + segment.center.y * videoSize.height - halfH);

  // Handle drag to move
  const handleMove = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isSelected) {
      onSelect(segmentId);
    }

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      centerX: segment.center.x,
      centerY: segment.center.y,
      sizeX: segment.size.x,
      sizeY: segment.size.y,
      fontSize: segment.fontSize,
    };

    const minPadding = 0.02;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;

      const dx = (moveEvent.clientX - dragStartRef.current.x) / videoSize.width;
      const dy = (moveEvent.clientY - dragStartRef.current.y) / videoSize.height;

      const halfW = segment.size.x / 2;
      const halfH = segment.size.y / 2;

      const newCenterX = clamp(
        dragStartRef.current.centerX + dx,
        halfW + minPadding,
        1 - halfW - minPadding
      );
      const newCenterY = clamp(
        dragStartRef.current.centerY + dy,
        halfH + minPadding,
        1 - halfH - minPadding
      );

      onUpdate(segmentId, { center: { x: newCenterX, y: newCenterY } });
    };

    const handleMouseUp = () => {
      dragStartRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [segment, videoSize, isSelected, segmentId, onSelect, onUpdate]);

  // Handle corner resize (proportional scaling with font size)
  const createCornerResizeHandler = useCallback((dirX: -1 | 1, dirY: -1 | 1) => {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      setIsResizing(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        centerX: segment.center.x,
        centerY: segment.center.y,
        sizeX: segment.size.x,
        sizeY: segment.size.y,
        fontSize: segment.fontSize,
      };

      const minSize = 0.03;
      const maxSize = 0.95;
      const minPadding = 0.02;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;

        const dy = (moveEvent.clientY - dragStartRef.current.y) / videoSize.height;

        // Calculate scale based on vertical drag
        const currentHeightPx = dragStartRef.current.sizeY * videoSize.height;
        const deltaPxY = dy * videoSize.height * dirY;
        const scale = (currentHeightPx + deltaPxY) / currentHeightPx;

        if (scale > 0.1 && scale < 10) {
          const newFontSize = clamp(dragStartRef.current.fontSize * scale, 8, 400);
          const newSizeX = clamp(dragStartRef.current.sizeX * scale, minSize, maxSize);
          const newSizeY = clamp(dragStartRef.current.sizeY * scale, minSize, maxSize);

          const widthDiff = newSizeX - dragStartRef.current.sizeX;
          const heightDiff = newSizeY - dragStartRef.current.sizeY;

          const halfWidth = newSizeX / 2;
          const halfHeight = newSizeY / 2;

          const newCenterX = clamp(
            dragStartRef.current.centerX + (widthDiff * dirX) / 2,
            halfWidth + minPadding,
            1 - halfWidth - minPadding
          );
          const newCenterY = clamp(
            dragStartRef.current.centerY + (heightDiff * dirY) / 2,
            halfHeight + minPadding,
            1 - halfHeight - minPadding
          );

          onUpdate(segmentId, {
            fontSize: newFontSize,
            size: { x: newSizeX, y: newSizeY },
            center: { x: newCenterX, y: newCenterY },
          });
        }
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        dragStartRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    };
  }, [segment, videoSize, segmentId, onUpdate]);

  // Handle side resize (width only, no font size change)
  const createSideResizeHandler = useCallback((dirX: -1 | 1) => {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      setIsResizing(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        centerX: segment.center.x,
        centerY: segment.center.y,
        sizeX: segment.size.x,
        sizeY: segment.size.y,
        fontSize: segment.fontSize,
      };

      const minSize = 0.03;
      const maxSize = 0.95;
      const minPadding = 0.02;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;

        const dx = (moveEvent.clientX - dragStartRef.current.x) / videoSize.width;

        const targetWidth = dragStartRef.current.sizeX + dx * dirX;
        const newSizeX = clamp(targetWidth, minSize, maxSize);
        const appliedDelta = newSizeX - dragStartRef.current.sizeX;

        const halfWidth = newSizeX / 2;

        const newCenterX = clamp(
          dragStartRef.current.centerX + (dirX * appliedDelta) / 2,
          halfWidth + minPadding,
          1 - halfWidth - minPadding
        );

        onUpdate(segmentId, {
          size: { x: newSizeX, y: segment.size.y },
          center: { x: newCenterX, y: segment.center.y },
        });
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        dragStartRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    };
  }, [segment, videoSize, segmentId, onUpdate]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segmentId);
  }, [segmentId, onSelect]);

  // Scale font size to match backend (glyphon) rendering
  // Uses Cap's formula: font_size * size_scale * height_scale
  const BASE_TEXT_HEIGHT = 0.2;
  const sizeScale = Math.max(0.25, Math.min(4.0, segment.size.y / BASE_TEXT_HEIGHT));
  const heightScale = videoSize.height / 1080;
  const scaledFontSize = segment.fontSize * sizeScale * heightScale;

  return (
    <div
      className="absolute pointer-events-auto"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        cursor: isResizing ? undefined : (isSelected ? 'move' : 'pointer'),
      }}
      onClick={handleClick}
      onMouseDown={isSelected ? handleMove : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Text content (CSS preview - only shown when GPU preview is disabled) */}
      {/* Match glyphon: text starts from top, each line is center-aligned */}
      {showTextContent && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none select-none"
          style={{
            fontFamily: segment.fontFamily || 'sans-serif',
            fontSize: `${scaledFontSize}px`,
            fontWeight: segment.fontWeight,
            fontStyle: segment.italic ? 'italic' : 'normal',
            color: segment.color,
            textAlign: 'center',
            lineHeight: 1.2,
            wordWrap: 'break-word',
            whiteSpace: 'pre-wrap',
            display: 'flex',
            alignItems: 'center', // Vertically center for better preview UX
            justifyContent: 'center', // This centers the text block
          }}
        >
          {segment.content}
        </div>
      )}

      {/* Bounding box border */}
      <div
        className={`absolute inset-0 rounded-md border-2 transition-colors ${
          isSelected
            ? 'border-blue-500 bg-blue-500/10'
            : isHovered
            ? 'border-blue-400 bg-blue-400/5'
            : 'border-transparent'
        }`}
      />

      {/* Resize handles (only when selected) */}
      {isSelected && (
        <>
          {/* Corner handles - proportional resize with font scaling */}
          <ResizeHandle position="nw" onMouseDown={createCornerResizeHandler(-1, -1)} />
          <ResizeHandle position="ne" onMouseDown={createCornerResizeHandler(1, -1)} />
          <ResizeHandle position="sw" onMouseDown={createCornerResizeHandler(-1, 1)} />
          <ResizeHandle position="se" onMouseDown={createCornerResizeHandler(1, 1)} />

          {/* Side handles - width only */}
          <ResizeHandle position="w" onMouseDown={createSideResizeHandler(-1)} />
          <ResizeHandle position="e" onMouseDown={createSideResizeHandler(1)} />
        </>
      )}
    </div>
  );
});

/**
 * TextOverlay - Text segments with interactive editing support.
 *
 * Renders text using CSS for preview with interactive bounding boxes
 * for selection, dragging, and resizing. The export uses glyphon for
 * GPU-accelerated text rendering (may have slight positioning differences).
 *
 * Uses Cap's model: time in seconds, center-based positioning.
 */
export const TextOverlay = memo(function TextOverlay({
  segments,
  currentTimeMs,
  previewWidth,
  previewHeight,
  videoAspectRatio,
  showTextContent = true,
}: TextOverlayProps) {
  const selectedTextSegmentId = useVideoEditorStore((s) => s.selectedTextSegmentId);
  const selectTextSegment = useVideoEditorStore((s) => s.selectTextSegment);
  const updateTextSegment = useVideoEditorStore((s) => s.updateTextSegment);

  // Calculate video bounds within container (accounting for letterboxing)
  const videoBounds = calculateVideoBounds(previewWidth, previewHeight, videoAspectRatio);
  const videoOffset = { x: videoBounds.offsetX, y: videoBounds.offsetY };
  const videoSize = { width: videoBounds.width, height: videoBounds.height };

  // Current time in seconds (Cap uses seconds)
  const currentTimeSec = currentTimeMs / 1000;

  // Filter segments that are active at current time and enabled
  const activeSegments = useMemo(() =>
    segments.filter(
      (seg) => seg.enabled && currentTimeSec >= seg.start && currentTimeSec <= seg.end
    ),
    [segments, currentTimeSec]
  );

  // Handle click on overlay container to deselect
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    // Only deselect if clicking on the container itself, not a child
    if (e.target === e.currentTarget) {
      selectTextSegment(null);
    }
  }, [selectTextSegment]);

  // Generate stable IDs for segments based on start time only (not content)
  // This ensures the ID doesn't change when editing text content
  const segmentIds = useMemo(() =>
    activeSegments.map((seg, index) =>
      `text_${seg.start.toFixed(3)}_${index}`
    ),
    [activeSegments]
  );

  const hasSelection = selectedTextSegmentId !== null;

  return (
    <div
      className={`absolute inset-0 ${hasSelection ? '' : 'pointer-events-none'}`}
      onClick={handleContainerClick}
    >
      {activeSegments.map((segment, index) => (
        <TextItem
          key={segmentIds[index]}
          segment={segment}
          segmentId={segmentIds[index]}
          isSelected={segmentIds[index] === selectedTextSegmentId}
          videoOffset={videoOffset}
          videoSize={videoSize}
          onSelect={selectTextSegment}
          onUpdate={updateTextSegment}
          showTextContent={showTextContent}
        />
      ))}
    </div>
  );
});
