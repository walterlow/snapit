import { memo, useCallback, useState, useRef } from 'react';
import type { TextSegment, TextAlign } from '../../types';
import { useVideoEditorStore } from '../../stores/videoEditorStore';

interface TextOverlayProps {
  segments: TextSegment[];
  currentTimeMs: number;
  previewWidth: number;
  previewHeight: number;
}

interface TextItemProps {
  segment: TextSegment;
  isSelected: boolean;
  previewWidth: number;
  previewHeight: number;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<TextSegment>) => void;
}

/**
 * Get text alignment CSS value
 */
const getTextAlignCSS = (align: TextAlign): React.CSSProperties['textAlign'] => {
  switch (align) {
    case 'left':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
      return 'right';
    default:
      return 'left';
  }
};

/**
 * Individual text overlay item with drag support
 */
const TextItem = memo(function TextItem({
  segment,
  isSelected,
  previewWidth,
  previewHeight,
  onSelect,
  onUpdate,
}: TextItemProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; segX: number; segY: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    onSelect(segment.id);
    setIsDragging(true);

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      segX: segment.x,
      segY: segment.y,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;

      const deltaX = (moveEvent.clientX - dragStartRef.current.x) / previewWidth;
      const deltaY = (moveEvent.clientY - dragStartRef.current.y) / previewHeight;

      const newX = Math.max(0, Math.min(1, dragStartRef.current.segX + deltaX));
      const newY = Math.max(0, Math.min(1, dragStartRef.current.segY + deltaY));

      onUpdate(segment.id, { x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [segment, previewWidth, previewHeight, onSelect, onUpdate]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(segment.id);
  }, [segment.id, onSelect]);

  // Calculate pixel position
  const left = segment.x * previewWidth;
  const top = segment.y * previewHeight;

  // Build text styles
  const textStyle: React.CSSProperties = {
    fontFamily: segment.fontFamily || 'Arial',
    fontSize: `${segment.fontSize}px`,
    fontWeight: segment.fontWeight || 400,
    fontStyle: segment.italic ? 'italic' : 'normal',
    color: segment.color,
    textAlign: getTextAlignCSS(segment.textAlign),
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  // Build shadow if present
  if (segment.shadow) {
    textStyle.textShadow = `${segment.shadow.offsetX}px ${segment.shadow.offsetY}px ${segment.shadow.blur}px ${segment.shadow.color}`;
  }

  // Build background if present
  const containerStyle: React.CSSProperties = {
    left: `${left}px`,
    top: `${top}px`,
    cursor: isDragging ? 'grabbing' : 'grab',
  };

  if (segment.backgroundColor) {
    containerStyle.backgroundColor = segment.backgroundColor;
    containerStyle.padding = `${segment.backgroundPadding}px`;
    containerStyle.borderRadius = `${segment.backgroundRadius}px`;
  }

  return (
    <div
      className={`absolute transition-shadow select-none ${
        isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
      }`}
      style={containerStyle}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
    >
      <div style={textStyle}>
        {segment.text || 'Text'}
      </div>

      {/* Selection handles */}
      {isSelected && (
        <>
          {/* Move indicator */}
          <div className="absolute -top-6 left-0 bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap">
            Text ({segment.fontFamily}, {segment.fontSize}px)
          </div>

          {/* Corner indicators */}
          <div className="absolute -left-1 -top-1 w-2 h-2 bg-blue-500 rounded-full shadow-sm" />
          <div className="absolute -right-1 -top-1 w-2 h-2 bg-blue-500 rounded-full shadow-sm" />
          <div className="absolute -left-1 -bottom-1 w-2 h-2 bg-blue-500 rounded-full shadow-sm" />
          <div className="absolute -right-1 -bottom-1 w-2 h-2 bg-blue-500 rounded-full shadow-sm" />
        </>
      )}
    </div>
  );
});

/**
 * TextOverlay - Renders text overlays on the video preview.
 * Shows only text that is active at the current time.
 */
export const TextOverlay = memo(function TextOverlay({
  segments,
  currentTimeMs,
  previewWidth,
  previewHeight,
}: TextOverlayProps) {
  const selectedTextSegmentId = useVideoEditorStore((s) => s.selectedTextSegmentId);
  const selectTextSegment = useVideoEditorStore((s) => s.selectTextSegment);
  const updateTextSegment = useVideoEditorStore((s) => s.updateTextSegment);

  // Filter segments that are active at current time
  const activeSegments = segments.filter(
    (seg) => currentTimeMs >= seg.startMs && currentTimeMs <= seg.endMs
  );

  // Handle click on overlay container to deselect
  const handleContainerClick = useCallback(() => {
    selectTextSegment(null);
  }, [selectTextSegment]);

  if (activeSegments.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      onClick={handleContainerClick}
    >
      {activeSegments.map((segment) => (
        <div key={segment.id} className="pointer-events-auto">
          <TextItem
            segment={segment}
            isSelected={segment.id === selectedTextSegmentId}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            onSelect={selectTextSegment}
            onUpdate={updateTextSegment}
          />
        </div>
      ))}
    </div>
  );
});
