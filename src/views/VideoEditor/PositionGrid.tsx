/**
 * Position grid for 9-point webcam anchor selection.
 * Maps to corner presets or custom positions for edges/center.
 */
import type { WebcamOverlayPosition } from '../../types';

export interface PositionGridProps {
  position: WebcamOverlayPosition;
  customX: number;
  customY: number;
  onChange: (position: WebcamOverlayPosition, customX: number, customY: number) => void;
}

// Grid positions: [row][col] -> { position, customX, customY }
const GRID_POSITIONS: Array<{
  position: WebcamOverlayPosition;
  customX: number;
  customY: number;
  label: string;
}> = [
  // Top row
  { position: 'topLeft', customX: 0, customY: 0, label: 'Top Left' },
  { position: 'custom', customX: 0.5, customY: 0.02, label: 'Top Center' },
  { position: 'topRight', customX: 1, customY: 0, label: 'Top Right' },
  // Middle row
  { position: 'custom', customX: 0.02, customY: 0.5, label: 'Middle Left' },
  { position: 'custom', customX: 0.5, customY: 0.5, label: 'Center' },
  { position: 'custom', customX: 0.98, customY: 0.5, label: 'Middle Right' },
  // Bottom row
  { position: 'bottomLeft', customX: 0, customY: 1, label: 'Bottom Left' },
  { position: 'custom', customX: 0.5, customY: 0.98, label: 'Bottom Center' },
  { position: 'bottomRight', customX: 1, customY: 1, label: 'Bottom Right' },
];

export function PositionGrid({ position, customX, customY, onChange }: PositionGridProps) {
  // Determine which grid cell is active
  const getActiveIndex = () => {
    // Check corner presets first
    if (position === 'topLeft') return 0;
    if (position === 'topRight') return 2;
    if (position === 'bottomLeft') return 6;
    if (position === 'bottomRight') return 8;

    // For custom, find closest grid position
    if (position === 'custom') {
      // Top center
      if (customY < 0.25 && customX > 0.25 && customX < 0.75) return 1;
      // Middle left
      if (customX < 0.25 && customY > 0.25 && customY < 0.75) return 3;
      // Center
      if (customX > 0.25 && customX < 0.75 && customY > 0.25 && customY < 0.75) return 4;
      // Middle right
      if (customX > 0.75 && customY > 0.25 && customY < 0.75) return 5;
      // Bottom center
      if (customY > 0.75 && customX > 0.25 && customX < 0.75) return 7;
    }

    return -1; // No match
  };

  const activeIndex = getActiveIndex();

  return (
    <div className="w-full p-3 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-surface-dark)] flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex justify-between">
          {[0, 1, 2].map((col) => {
            const index = row * 3 + col;
            const pos = GRID_POSITIONS[index];
            return (
              <button
                key={index}
                type="button"
                title={pos.label}
                onClick={() => onChange(pos.position, pos.customX, pos.customY)}
                className={`w-6 h-6 rounded transition-colors ${
                  activeIndex === index
                    ? 'bg-[var(--coral-400)]'
                    : 'bg-[var(--polar-frost)] hover:bg-[var(--polar-steel)]'
                }`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
