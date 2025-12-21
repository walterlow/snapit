import React from 'react';
import { Rect } from 'react-konva';

interface MarqueeSelectionProps {
  isActive: boolean;
  start: { x: number; y: number };
  end: { x: number; y: number };
  zoom: number;
}

/**
 * Marquee selection rectangle overlay
 * Shows during drag-to-select operation
 */
export const MarqueeSelection: React.FC<MarqueeSelectionProps> = React.memo(({
  isActive,
  start,
  end,
  zoom,
}) => {
  if (!isActive) return null;

  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  return (
    <Rect
      x={x}
      y={y}
      width={width}
      height={height}
      stroke="#F97066"
      strokeWidth={1 / zoom}
      dash={[4 / zoom, 4 / zoom]}
      fill="rgba(249, 112, 102, 0.1)"
      listening={false}
    />
  );
});

MarqueeSelection.displayName = 'MarqueeSelection';
