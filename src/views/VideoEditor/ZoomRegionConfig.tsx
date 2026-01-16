/**
 * ZoomRegionConfig - Configuration panel for zoom regions following Cap's UI pattern.
 * Shows video thumbnail with draggable focus point in manual mode.
 */
import { useRef, useEffect } from 'react';
import { useWebCodecsPreview } from '../../hooks/useWebCodecsPreview';
import { usePreviewOrPlaybackTime } from '../../hooks/usePlaybackEngine';
import { Slider } from '../../components/ui/slider';
import type { ZoomRegion } from '../../types';

export interface ZoomRegionConfigProps {
  region: ZoomRegion;
  videoSrc: string;
  canUseAuto: boolean;
  onUpdate: (updates: Partial<ZoomRegion>) => void;
  onDelete: () => void;
  onDone: () => void;
}

export function ZoomRegionConfig({ region, videoSrc, canUseAuto, onUpdate, onDelete, onDone }: ZoomRegionConfigProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnTimeRef = useRef<number | null>(null);

  // Use WebCodecs for instant frame access (same cache as main preview)
  const { getFrame, prefetchAround, isReady, dimensions } = useWebCodecsPreview(videoSrc);
  const currentTimeMs = usePreviewOrPlaybackTime();

  // Draw the current frame to canvas (uses cached frames - instant!)
  useEffect(() => {
    if (!isReady || !dimensions) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set canvas size to match video dimensions
    if (canvas.width !== dimensions.width || canvas.height !== dimensions.height) {
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
    }

    // Skip if same frame already drawn
    if (lastDrawnTimeRef.current === currentTimeMs) return;

    // Try to get cached frame
    const frame = getFrame(currentTimeMs);
    if (frame) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(frame, 0, 0);
        lastDrawnTimeRef.current = currentTimeMs;
      }
    } else {
      // Request frame to be decoded
      prefetchAround(currentTimeMs);
    }
  }, [isReady, dimensions, currentTimeMs, getFrame, prefetchAround]);

  const isLoaded = isReady && dimensions !== null;

  // Handle position drag on the thumbnail
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();

    const updatePosition = (clientX: number, clientY: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onUpdate({ targetX: x, targetY: y });
    };

    updatePosition(e.clientX, e.clientY);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updatePosition(moveEvent.clientX, moveEvent.clientY);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  if (!region) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onDone}
            className="h-7 px-2.5 bg-[var(--coral-100)] hover:bg-[var(--coral-200)] text-[var(--coral-400)] text-xs font-medium rounded-md transition-colors"
          >
            Done
          </button>
          <span className="text-xs text-[var(--ink-subtle)]">Zoom region</span>
        </div>
        <button
          onClick={onDelete}
          className="h-7 px-2.5 bg-[var(--error-light)] hover:bg-[rgba(239,68,68,0.2)] text-[var(--error)] text-xs rounded-md transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Zoom Amount */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[var(--ink-muted)]">Zoom</span>
          <span className="text-xs text-[var(--ink-dark)] font-mono">{region.scale.toFixed(1)}x</span>
        </div>
        <Slider
          value={[region.scale]}
          min={1}
          max={4}
          step={0.1}
          onValueChange={(values) => onUpdate({ scale: values[0] })}
        />
      </div>

      {/* Zoom Mode Toggle */}
      <div>
        <span className="text-xs text-[var(--ink-muted)] block mb-2">Zoom Mode</span>
        <div className="relative flex rounded-lg border border-[var(--glass-border)] overflow-hidden">
          {/* Sliding indicator */}
          <div
            className="absolute top-0 bottom-0 w-1/2 bg-[var(--polar-frost)] transition-transform duration-200"
            style={{ transform: region.mode === 'auto' ? 'translateX(0)' : 'translateX(100%)' }}
          />
          <button
            onClick={() => canUseAuto && onUpdate({ mode: 'auto' })}
            disabled={!canUseAuto}
            className={`relative z-10 flex-1 py-2 text-xs font-medium transition-colors ${
              region.mode === 'auto'
                ? 'text-[var(--ink-black)]'
                : canUseAuto
                  ? 'text-[var(--ink-subtle)] hover:text-[var(--ink-dark)]'
                  : 'text-[var(--ink-faint)] cursor-not-allowed'
            }`}
          >
            Auto
          </button>
          <button
            onClick={() => onUpdate({ mode: 'manual' })}
            className={`relative z-10 flex-1 py-2 text-xs font-medium transition-colors ${
              region.mode !== 'auto'
                ? 'text-[var(--ink-black)]'
                : 'text-[var(--ink-subtle)] hover:text-[var(--ink-dark)]'
            }`}
          >
            Manual
          </button>
        </div>
        {!canUseAuto && (
          <p className="text-[10px] text-[var(--ink-faint)] mt-1">
            No cursor data for auto mode
          </p>
        )}
      </div>

      {/* Manual Mode: Video thumbnail with focus picker */}
      {region.mode !== 'auto' && (
        <div
          className="relative w-full cursor-crosshair"
          onMouseDown={handleMouseDown}
        >
          {/* Focus indicator circle */}
          <div
            className="absolute z-20 w-6 h-6 rounded-full border-2 border-[var(--ink-dark)] -translate-x-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center bg-[var(--glass-bg)]"
            style={{
              left: `${region.targetX * 100}%`,
              top: `${region.targetY * 100}%`,
            }}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--ink-dark)]" />
          </div>

          {/* Video thumbnail canvas */}
          <div className="overflow-hidden rounded-lg border border-[var(--glass-border)] bg-[var(--polar-mist)]">
            <canvas
              ref={canvasRef}
              className={`w-full h-auto transition-opacity duration-200 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
            {!isLoaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--polar-mist)]">
                <span className="text-xs text-[var(--ink-subtle)]">Loading preview...</span>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
