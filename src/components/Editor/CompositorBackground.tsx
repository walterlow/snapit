import React from 'react';
import { Rect, Group, Image } from 'react-konva';
import type { CompositorSettings } from '../../types';
import {
  useCompositorBackgroundImage,
  calculateGradientPoints,
  gradientStopsToKonva,
  calculateCoverSize,
} from '../../hooks/useCompositorBackground';

interface CompositorBackgroundProps {
  settings: CompositorSettings;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  borderRadius?: number;
  includeShadow?: boolean;
  name?: string;
}

/**
 * Renders the compositor background as Konva elements.
 * Single source of truth - use this for both preview and export.
 */
export const CompositorBackground: React.FC<CompositorBackgroundProps> = ({
  settings,
  bounds,
  borderRadius = 0,
  includeShadow = false,
  name,
}) => {
  const backgroundImage = useCompositorBackgroundImage(
    settings.backgroundType,
    settings.backgroundImage
  );

  if (!settings.enabled) return null;

  // Shadow props
  const shadowProps = includeShadow && settings.shadowEnabled
    ? {
        shadowColor: 'black',
        shadowBlur: 32 * settings.shadowIntensity,
        shadowOffsetY: 8 * settings.shadowIntensity,
        shadowOpacity: 0.35 * settings.shadowIntensity,
      }
    : {};

  // Solid color background
  if (settings.backgroundType === 'solid') {
    return (
      <Rect
        name={name}
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill={settings.backgroundColor}
        cornerRadius={borderRadius}
        listening={false}
        {...shadowProps}
      />
    );
  }

  // Gradient background
  if (settings.backgroundType === 'gradient') {
    const gradientPoints = calculateGradientPoints(
      settings.gradientAngle,
      bounds.width,
      bounds.height,
      0,
      0
    );

    return (
      <Rect
        name={name}
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fillLinearGradientStartPoint={{
          x: gradientPoints.x1,
          y: gradientPoints.y1,
        }}
        fillLinearGradientEndPoint={{
          x: gradientPoints.x2,
          y: gradientPoints.y2,
        }}
        fillLinearGradientColorStops={gradientStopsToKonva(settings.gradientStops)}
        cornerRadius={borderRadius}
        listening={false}
        {...shadowProps}
      />
    );
  }

  // Image background
  if (settings.backgroundType === 'image') {
    if (!backgroundImage) {
      // Fallback while loading
      return (
        <Rect
          name={name}
          x={bounds.x}
          y={bounds.y}
          width={bounds.width}
          height={bounds.height}
          fill="#1a1a2e"
          cornerRadius={borderRadius}
          listening={false}
          {...shadowProps}
        />
      );
    }

    const cover = calculateCoverSize(
      backgroundImage.width,
      backgroundImage.height,
      bounds.width,
      bounds.height
    );

    // Need clipping for border radius
    if (borderRadius > 0) {
      return (
        <Group
          name={name}
          clipFunc={(ctx) => {
            const r = Math.min(borderRadius, bounds.width / 2, bounds.height / 2);
            ctx.beginPath();
            ctx.moveTo(bounds.x + r, bounds.y);
            ctx.lineTo(bounds.x + bounds.width - r, bounds.y);
            ctx.quadraticCurveTo(bounds.x + bounds.width, bounds.y, bounds.x + bounds.width, bounds.y + r);
            ctx.lineTo(bounds.x + bounds.width, bounds.y + bounds.height - r);
            ctx.quadraticCurveTo(bounds.x + bounds.width, bounds.y + bounds.height, bounds.x + bounds.width - r, bounds.y + bounds.height);
            ctx.lineTo(bounds.x + r, bounds.y + bounds.height);
            ctx.quadraticCurveTo(bounds.x, bounds.y + bounds.height, bounds.x, bounds.y + bounds.height - r);
            ctx.lineTo(bounds.x, bounds.y + r);
            ctx.quadraticCurveTo(bounds.x, bounds.y, bounds.x + r, bounds.y);
            ctx.closePath();
          }}
        >
          <Image
            image={backgroundImage}
            x={bounds.x + cover.offsetX}
            y={bounds.y + cover.offsetY}
            width={cover.width}
            height={cover.height}
            listening={false}
            {...shadowProps}
          />
        </Group>
      );
    }

    return (
      <Group name={name}>
        <Image
          image={backgroundImage}
          x={bounds.x + cover.offsetX}
          y={bounds.y + cover.offsetY}
          width={cover.width}
          height={cover.height}
          listening={false}
          {...shadowProps}
        />
      </Group>
    );
  }

  return null;
};

export default CompositorBackground;
