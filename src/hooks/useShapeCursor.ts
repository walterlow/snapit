import type Konva from 'konva';

/**
 * Returns mouse event handlers for shape cursor changes
 * Shows 'move' cursor when hovering over draggable shapes
 */
export function useShapeCursor(isDraggable: boolean) {
  return {
    onMouseEnter: (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (isDraggable) {
        const container = e.target.getStage()?.container();
        if (container) container.style.cursor = 'move';
      }
    },
    onMouseLeave: (e: Konva.KonvaEventObject<MouseEvent>) => {
      const container = e.target.getStage()?.container();
      if (container) container.style.cursor = 'default';
    },
  };
}
