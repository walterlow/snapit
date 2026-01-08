import { memo, useCallback, useState, useRef } from 'react';
import type { MaskSegment, MaskType } from '../../types';
import { useVideoEditorStore } from '../../stores/videoEditorStore';

interface MaskOverlayProps {
  segments: MaskSegment[];
  currentTimeMs: number;
  previewWidth: number;
  previewHeight: number;
}

interface MaskItemProps {
  segment: MaskSegment;
  isSelected: boolean;
  previewWidth: number;
  previewHeight: number;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<MaskSegment>) => void;
}

/**
 * Get mask style based on type
 */
const getMaskStyle = (maskType: MaskType, intensity: number): React.CSSProperties => {
  switch (maskType) {
    case 'blur':
      return {
        backdropFilter: `blur(${intensity / 5}px)`,
        WebkitBackdropFilter: `blur(${intensity / 5}px)`,
        backgroundColor: `rgba(0, 0, 0, ${intensity / 500})`,
      };
    case 'pixelate':
      // Pixelate effect simulated with a pattern
      return {
        backgroundColor: `rgba(128, 128, 128, ${intensity / 100})`,
        backgroundImage: `
          linear-gradient(45deg, rgba(0,0,0,0.1) 25%, transparent 25%),
          linear-gradient(-45deg, rgba(0,0,0,0.1) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.1) 75%),
          linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.1) 75%)
        `,
        backgroundSize: `${Math.max(4, intensity / 5)}px ${Math.max(4, intensity / 5)}px`,
        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
      };
    case 'solid':
      return {
        backgroundColor: 'var(--mask-solid-color, #000000)',
      };
    default:
      return {};
  }
};

/**
 * Individual mask overlay item with drag/resize handles
 */
const MaskItem = memo(function MaskItem({
  segment,
  isSelected,
  previewWidth,
  previewHeight,
  onSelect,
  onUpdate,
}: MaskItemProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br' | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; segX: number; segY: number; segW: number; segH: number } | null>(null);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    onSelect(segment.id);
    setIsDragging(true);
    setDragType(type);

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      segX: segment.x,
      segY: segment.y,
      segW: segment.width,
      segH: segment.height,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;

      const deltaX = (moveEvent.clientX - dragStartRef.current.x) / previewWidth;
      const deltaY = (moveEvent.clientY - dragStartRef.current.y) / previewHeight;

      if (type === 'move') {
        // Move the mask
        const newX = Math.max(0, Math.min(1 - segment.width, dragStartRef.current.segX + deltaX));
        const newY = Math.max(0, Math.min(1 - segment.height, dragStartRef.current.segY + deltaY));
        onUpdate(segment.id, { x: newX, y: newY });
      } else {
        // Resize the mask
        let newX = dragStartRef.current.segX;
        let newY = dragStartRef.current.segY;
        let newW = dragStartRef.current.segW;
        let newH = dragStartRef.current.segH;

        const minSize = 0.02; // Minimum 2% of preview

        switch (type) {
          case 'resize-tl':
            newX = Math.max(0, Math.min(dragStartRef.current.segX + dragStartRef.current.segW - minSize, dragStartRef.current.segX + deltaX));
            newY = Math.max(0, Math.min(dragStartRef.current.segY + dragStartRef.current.segH - minSize, dragStartRef.current.segY + deltaY));
            newW = dragStartRef.current.segX + dragStartRef.current.segW - newX;
            newH = dragStartRef.current.segY + dragStartRef.current.segH - newY;
            break;
          case 'resize-tr':
            newY = Math.max(0, Math.min(dragStartRef.current.segY + dragStartRef.current.segH - minSize, dragStartRef.current.segY + deltaY));
            newW = Math.max(minSize, Math.min(1 - dragStartRef.current.segX, dragStartRef.current.segW + deltaX));
            newH = dragStartRef.current.segY + dragStartRef.current.segH - newY;
            break;
          case 'resize-bl':
            newX = Math.max(0, Math.min(dragStartRef.current.segX + dragStartRef.current.segW - minSize, dragStartRef.current.segX + deltaX));
            newW = dragStartRef.current.segX + dragStartRef.current.segW - newX;
            newH = Math.max(minSize, Math.min(1 - dragStartRef.current.segY, dragStartRef.current.segH + deltaY));
            break;
          case 'resize-br':
            newW = Math.max(minSize, Math.min(1 - dragStartRef.current.segX, dragStartRef.current.segW + deltaX));
            newH = Math.max(minSize, Math.min(1 - dragStartRef.current.segY, dragStartRef.current.segH + deltaY));
            break;
        }

        onUpdate(segment.id, { x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragType(null);
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

  // Calculate pixel positions
  const left = segment.x * previewWidth;
  const top = segment.y * previewHeight;
  const width = segment.width * previewWidth;
  const height = segment.height * previewHeight;

  return (
    <div
      className={`absolute transition-shadow ${isSelected ? 'ring-2 ring-purple-500 ring-offset-1' : ''}`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        cursor: isDragging ? (dragType === 'move' ? 'grabbing' : 'nwse-resize') : 'pointer',
        ...getMaskStyle(segment.maskType, segment.intensity),
        '--mask-solid-color': segment.color,
        borderRadius: `${segment.feather / 10}px`,
      } as React.CSSProperties}
      onClick={handleClick}
    >
      {/* Move handle (center) */}
      <div
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
      />

      {/* Resize handles (corners) - only show when selected */}
      {isSelected && (
        <>
          {/* Top-left */}
          <div
            className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nwse-resize shadow-md hover:scale-125 transition-transform"
            onMouseDown={(e) => handleMouseDown(e, 'resize-tl')}
          />
          {/* Top-right */}
          <div
            className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nesw-resize shadow-md hover:scale-125 transition-transform"
            onMouseDown={(e) => handleMouseDown(e, 'resize-tr')}
          />
          {/* Bottom-left */}
          <div
            className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nesw-resize shadow-md hover:scale-125 transition-transform"
            onMouseDown={(e) => handleMouseDown(e, 'resize-bl')}
          />
          {/* Bottom-right */}
          <div
            className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-purple-500 rounded-full cursor-nwse-resize shadow-md hover:scale-125 transition-transform"
            onMouseDown={(e) => handleMouseDown(e, 'resize-br')}
          />

          {/* Info badge */}
          <div className="absolute -top-6 left-0 bg-purple-600 text-white text-[10px] px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap">
            {segment.maskType === 'blur' ? 'Blur' : segment.maskType === 'pixelate' ? 'Pixelate' : 'Solid'} {segment.intensity}%
          </div>
        </>
      )}
    </div>
  );
});

/**
 * MaskOverlay - Renders mask overlays on the video preview.
 * Shows only masks that are active at the current time.
 */
export const MaskOverlay = memo(function MaskOverlay({
  segments,
  currentTimeMs,
  previewWidth,
  previewHeight,
}: MaskOverlayProps) {
  const selectedMaskSegmentId = useVideoEditorStore((s) => s.selectedMaskSegmentId);
  const selectMaskSegment = useVideoEditorStore((s) => s.selectMaskSegment);
  const updateMaskSegment = useVideoEditorStore((s) => s.updateMaskSegment);

  // Filter segments that are active at current time
  const activeSegments = segments.filter(
    (seg) => currentTimeMs >= seg.startMs && currentTimeMs <= seg.endMs
  );

  // Handle click on overlay container to deselect
  const handleContainerClick = useCallback(() => {
    selectMaskSegment(null);
  }, [selectMaskSegment]);

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
          <MaskItem
            segment={segment}
            isSelected={segment.id === selectedMaskSegmentId}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            onSelect={selectMaskSegment}
            onUpdate={updateMaskSegment}
          />
        </div>
      ))}
    </div>
  );
});
