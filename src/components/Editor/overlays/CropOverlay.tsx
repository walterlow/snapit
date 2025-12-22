import React from 'react';
import { Rect, Circle, Line } from 'react-konva';
import type { SnapGuide } from '../../../hooks/useCropTool';

interface CropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropOverlayProps {
  displayBounds: CropBounds;
  baseBounds: CropBounds;
  zoom: number;
  position: { x: number; y: number };
  isShiftHeld: boolean;
  isPanning: boolean;
  snapGuides: SnapGuide[];
  onCenterDragStart: (x: number, y: number) => void;
  onCenterDragMove: (x: number, y: number) => { x: number; y: number };
  onCenterDragEnd: (x: number, y: number) => void;
  onEdgeDragStart: (handleId: string) => void;
  onEdgeDragMove: (handleId: string, x: number, y: number) => void;
  onEdgeDragEnd: (handleId: string, x: number, y: number) => void;
  onCornerDragStart: (handleId: string) => void;
  onCornerDragMove: (handleId: string, x: number, y: number) => void;
  onCornerDragEnd: (handleId: string, x: number, y: number) => void;
}

const HANDLE_LENGTH = 40;
const HANDLE_THICKNESS = 6;
const CORNER_SIZE = 12;

/**
 * Crop overlay - dim areas, handles, and interactive regions
 */
export const CropOverlay: React.FC<CropOverlayProps> = ({
  displayBounds,
  baseBounds,
  zoom,
  position,
  isShiftHeld,
  isPanning,
  snapGuides,
  onCenterDragStart,
  onCenterDragMove,
  onCenterDragEnd,
  onEdgeDragStart,
  onEdgeDragMove,
  onEdgeDragEnd,
  onCornerDragStart,
  onCornerDragMove,
  onCornerDragEnd,
}) => {
  const handleLength = HANDLE_LENGTH / zoom;
  const handleThickness = HANDLE_THICKNESS / zoom;
  const cornerSize = CORNER_SIZE / zoom;

  // Edge handles
  const edgeHandles = [
    { id: 't', x: displayBounds.x + displayBounds.width / 2 - handleLength / 2, y: displayBounds.y - handleThickness / 2, width: handleLength, height: handleThickness, cursor: 'ns-resize' },
    { id: 'b', x: displayBounds.x + displayBounds.width / 2 - handleLength / 2, y: displayBounds.y + displayBounds.height - handleThickness / 2, width: handleLength, height: handleThickness, cursor: 'ns-resize' },
    { id: 'l', x: displayBounds.x - handleThickness / 2, y: displayBounds.y + displayBounds.height / 2 - handleLength / 2, width: handleThickness, height: handleLength, cursor: 'ew-resize' },
    { id: 'r', x: displayBounds.x + displayBounds.width - handleThickness / 2, y: displayBounds.y + displayBounds.height / 2 - handleLength / 2, width: handleThickness, height: handleLength, cursor: 'ew-resize' },
  ];

  // Corner handles
  const cornerHandles = [
    { id: 'tl', x: displayBounds.x, y: displayBounds.y, cursor: 'nwse-resize' },
    { id: 'tr', x: displayBounds.x + displayBounds.width, y: displayBounds.y, cursor: 'nesw-resize' },
    { id: 'bl', x: displayBounds.x, y: displayBounds.y + displayBounds.height, cursor: 'nesw-resize' },
    { id: 'br', x: displayBounds.x + displayBounds.width, y: displayBounds.y + displayBounds.height, cursor: 'nwse-resize' },
  ];

  return (
    <>
      {/* Dim area outside crop (Photoshop-style) */}
      <Rect x={-10000} y={-10000} width={20000} height={displayBounds.y + 10000} fill="rgba(0,0,0,0.5)" listening={false} />
      <Rect x={-10000} y={displayBounds.y + displayBounds.height} width={20000} height={10000} fill="rgba(0,0,0,0.5)" listening={false} />
      <Rect x={-10000} y={displayBounds.y} width={displayBounds.x + 10000} height={displayBounds.height} fill="rgba(0,0,0,0.5)" listening={false} />
      <Rect x={displayBounds.x + displayBounds.width} y={displayBounds.y} width={10000} height={displayBounds.height} fill="rgba(0,0,0,0.5)" listening={false} />

      {/* Crop bounds outline */}
      <Rect
        x={displayBounds.x}
        y={displayBounds.y}
        width={displayBounds.width}
        height={displayBounds.height}
        stroke="#fbbf24"
        strokeWidth={2 / zoom}
        fill="transparent"
        listening={false}
      />

      {/* Draggable center area */}
      <Rect
        x={baseBounds.x}
        y={baseBounds.y}
        width={baseBounds.width}
        height={baseBounds.height}
        fill="transparent"
        draggable={!isPanning}
        onDragStart={(e) => {
          // Ignore middle mouse button (used for panning)
          if (e.evt.button === 1) {
            e.target.stopDrag();
            return;
          }
          const node = e.target;
          onCenterDragStart(node.x(), node.y());
        }}
        onDragMove={(e) => {
          const node = e.target;
          const constrained = onCenterDragMove(node.x(), node.y());
          // Apply constraint if shift held
          if (isShiftHeld) {
            node.x(constrained.x);
            node.y(constrained.y);
          }
        }}
        onDragEnd={(e) => {
          const node = e.target;
          onCenterDragEnd(node.x(), node.y());
        }}
        onMouseEnter={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'move';
        }}
        onMouseLeave={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'default';
        }}
      />

      {/* Edge handles */}
      {edgeHandles.map(handle => (
        <Rect
          key={handle.id}
          x={handle.x}
          y={handle.y}
          width={handle.width}
          height={handle.height}
          fill="#fbbf24"
          cornerRadius={2 / zoom}
          draggable={!isPanning}
          dragBoundFunc={(pos) => {
            if (handle.id === 't' || handle.id === 'b') {
              return { x: handle.x * zoom + position.x, y: pos.y };
            } else {
              return { x: pos.x, y: handle.y * zoom + position.y };
            }
          }}
          onDragStart={(e) => {
            // Ignore middle mouse button (used for panning)
            if (e.evt.button === 1) {
              e.target.stopDrag();
              return;
            }
            onEdgeDragStart(handle.id);
          }}
          onDragMove={(e) => onEdgeDragMove(handle.id, e.target.x(), e.target.y())}
          onDragEnd={(e) => onEdgeDragEnd(handle.id, e.target.x(), e.target.y())}
          onMouseEnter={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = handle.cursor;
          }}
          onMouseLeave={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'default';
          }}
        />
      ))}

      {/* Corner handles */}
      {cornerHandles.map(handle => (
        <Circle
          key={handle.id}
          x={handle.x}
          y={handle.y}
          radius={cornerSize / 2}
          fill="#fbbf24"
          stroke="#000"
          strokeWidth={1 / zoom}
          draggable={!isPanning}
          onDragStart={(e) => {
            // Ignore middle mouse button (used for panning)
            if (e.evt.button === 1) {
              e.target.stopDrag();
              return;
            }
            onCornerDragStart(handle.id);
          }}
          onDragMove={(e) => onCornerDragMove(handle.id, e.target.x(), e.target.y())}
          onDragEnd={(e) => onCornerDragEnd(handle.id, e.target.x(), e.target.y())}
          onMouseEnter={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = handle.cursor;
          }}
          onMouseLeave={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'default';
          }}
        />
      ))}

      {/* Snap guide lines */}
      {snapGuides.map((guide, index) => {
        // Calculate line extent - extend well beyond visible area
        const lineExtent = 10000;
        const strokeWidth = 1 / zoom;
        const dashSize = 4 / zoom;

        if (guide.type === 'vertical') {
          return (
            <Line
              key={`snap-v-${index}`}
              points={[guide.position, -lineExtent, guide.position, lineExtent]}
              stroke="#F97066"
              strokeWidth={strokeWidth}
              dash={[dashSize, dashSize]}
              listening={false}
            />
          );
        } else {
          return (
            <Line
              key={`snap-h-${index}`}
              points={[-lineExtent, guide.position, lineExtent, guide.position]}
              stroke="#F97066"
              strokeWidth={strokeWidth}
              dash={[dashSize, dashSize]}
              listening={false}
            />
          );
        }
      })}
    </>
  );
};
