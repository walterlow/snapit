import React from 'react';
import { Rect } from 'react-konva';
import type { CompositorSettings } from '../../types';
import { CompositorBackground } from './CompositorBackground';

interface VisibleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface KonvaBackgroundLayerProps {
  /** Compositor settings from store */
  settings: CompositorSettings;
  /** Visible content bounds */
  visibleBounds: VisibleBounds | null;
  /** Base composition size (content + padding) */
  baseCompositionSize: { width: number; height: number };
}

/**
 * Renders the Konva-side background layer for the editor canvas.
 * Handles both:
 * - Default shadow when compositor is disabled
 * - Compositor background, shadows, and border radius when enabled
 */
export const KonvaBackgroundLayer: React.FC<KonvaBackgroundLayerProps> = ({
  settings,
  visibleBounds,
  baseCompositionSize,
}) => {
  if (!visibleBounds) return null;

  // Default shadow when compositor disabled
  if (!settings.enabled) {
    return (
      <Rect
        name="editor-shadow"
        x={visibleBounds.x - 2}
        y={visibleBounds.y - 2}
        width={visibleBounds.width + 4}
        height={visibleBounds.height + 4}
        fill="rgba(0,0,0,0.15)"
        cornerRadius={4}
        shadowColor="black"
        shadowBlur={24}
        shadowOpacity={0.25}
        listening={false}
      />
    );
  }

  // Compositor background (with padding)
  if (baseCompositionSize.width <= 0) return null;

  const padding = settings.padding;
  const compBounds = {
    x: visibleBounds.x - padding - 1,
    y: visibleBounds.y - padding - 1,
    width: visibleBounds.width + padding * 2 + 2,
    height: visibleBounds.height + padding * 2 + 2,
  };

  return (
    <>
      <CompositorBackground
        name="compositor-background"
        settings={settings}
        bounds={compBounds}
        borderRadius={0}
        includeShadow={false}
      />
      {settings.shadowEnabled && (() => {
        const intensity = settings.shadowIntensity;
        const shadowLayers = [
          { blur: 10, opacity: 0.15 * intensity, offsetY: 2 },
          { blur: 30, opacity: 0.25 * intensity, offsetY: 8 },
          { blur: 60, opacity: 0.35 * intensity, offsetY: 16 },
        ];
        return shadowLayers.map((layer, i) => (
          <Rect
            key={`shadow-${i}`}
            name={`content-shadow-${i}`}
            x={visibleBounds.x}
            y={visibleBounds.y}
            width={visibleBounds.width}
            height={visibleBounds.height}
            fill="black"
            cornerRadius={settings.borderRadius}
            shadowColor="black"
            shadowBlur={layer.blur}
            shadowOffsetX={0}
            shadowOffsetY={layer.offsetY}
            shadowOpacity={layer.opacity}
            shadowEnabled={true}
            listening={false}
          />
        ));
      })()}
      {settings.borderRadius > 0 && (
        <CompositorBackground
          settings={settings}
          bounds={{
            x: visibleBounds.x - 2,
            y: visibleBounds.y - 2,
            width: visibleBounds.width + 4,
            height: visibleBounds.height + 4,
          }}
          borderRadius={settings.borderRadius + 2}
        />
      )}
    </>
  );
};

export default KonvaBackgroundLayer;
