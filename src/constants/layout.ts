/**
 * Layout constants for the Library grid system.
 * These values must be consistent across CaptureLibrary and VirtualizedGrid.
 */

// Grid layout
export const LAYOUT = {
  // Header and spacing
  HEADER_HEIGHT: 56,
  GRID_GAP: 20,
  CONTAINER_PADDING: 64,

  // Card dimensions
  CARD_ROW_HEIGHT: 280,
  LIST_ROW_HEIGHT: 88, // 56px thumbnail + 24px padding (12px*2) + 8px gap
  MIN_CARD_WIDTH: 240,
} as const;

export type LayoutConstants = typeof LAYOUT;
