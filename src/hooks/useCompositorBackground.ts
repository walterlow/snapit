import { useMemo, useState, useEffect, useRef } from 'react';
import type { CompositorSettings, GradientStop } from '../types';

export interface BackgroundBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositorDimensions {
  // The full compositor output size (including padding)
  outputWidth: number;
  outputHeight: number;
  // Where the content sits within the output
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  // Padding in pixels
  paddingX: number;
  paddingY: number;
}

/**
 * Calculate gradient line points for a given angle and bounds
 */
export function calculateGradientPoints(
  angle: number,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0
): { x1: number; y1: number; x2: number; y2: number } {
  const angleRad = (angle - 90) * (Math.PI / 180);
  const centerX = offsetX + width / 2;
  const centerY = offsetY + height / 2;
  const length = Math.sqrt(width * width + height * height) / 2;

  return {
    x1: centerX - Math.cos(angleRad) * length,
    y1: centerY - Math.sin(angleRad) * length,
    x2: centerX + Math.cos(angleRad) * length,
    y2: centerY + Math.sin(angleRad) * length,
  };
}

/**
 * Convert gradient stops to Konva format [position, color, position, color, ...]
 */
export function gradientStopsToKonva(stops: GradientStop[]): (number | string)[] {
  const result: (number | string)[] = [];
  stops.forEach((stop) => {
    result.push(stop.position / 100);
    result.push(stop.color);
  });
  return result;
}

/**
 * Calculate "cover" sizing for an image within bounds
 */
export function calculateCoverSize(
  imgWidth: number,
  imgHeight: number,
  boundsWidth: number,
  boundsHeight: number
): { width: number; height: number; offsetX: number; offsetY: number } {
  const imgRatio = imgWidth / imgHeight;
  const boundsRatio = boundsWidth / boundsHeight;

  let width: number, height: number, offsetX: number, offsetY: number;

  if (imgRatio > boundsRatio) {
    // Image is wider - fit height, crop width
    height = boundsHeight;
    width = boundsHeight * imgRatio;
    offsetX = (boundsWidth - width) / 2;
    offsetY = 0;
  } else {
    // Image is taller - fit width, crop height
    width = boundsWidth;
    height = boundsWidth / imgRatio;
    offsetX = 0;
    offsetY = (boundsHeight - height) / 2;
  }

  return { width, height, offsetX, offsetY };
}

/**
 * Calculate compositor output dimensions based on content size and settings.
 * Padding is always even on all sides - no aspect ratio manipulation.
 * This matches the video editor's approach for consistency.
 */
export function calculateCompositorDimensions(
  contentWidth: number,
  contentHeight: number,
  settings: CompositorSettings
): CompositorDimensions {
  if (!settings.enabled) {
    return {
      outputWidth: contentWidth,
      outputHeight: contentHeight,
      contentX: 0,
      contentY: 0,
      contentWidth,
      contentHeight,
      paddingX: 0,
      paddingY: 0,
    };
  }

  // Padding is in pixels - always even on all sides
  const padding = settings.padding;
  const outputWidth = contentWidth + padding * 2;
  const outputHeight = contentHeight + padding * 2;

  // Content is always centered with even padding
  return {
    outputWidth: Math.round(outputWidth),
    outputHeight: Math.round(outputHeight),
    contentX: padding,
    contentY: padding,
    contentWidth,
    contentHeight,
    paddingX: padding,
    paddingY: padding,
  };
}

/**
 * Hook to load compositor background image
 * Properly cleans up old images when URL changes to prevent memory leaks
 */
export function useCompositorBackgroundImage(
  backgroundType: CompositorSettings['backgroundType'],
  backgroundImageUrl: string | null
): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    // Clean up previous image before loading new one
    if (imageRef.current) {
      imageRef.current.onload = null;
      imageRef.current.onerror = null;
      imageRef.current.src = '';
      imageRef.current = null;
    }

    if (backgroundType === 'image' && backgroundImageUrl) {
      const img = new Image();
      imageRef.current = img;
      img.onload = () => setImage(img);
      img.onerror = () => setImage(null);
      img.src = backgroundImageUrl;
    } else {
      setImage(null);
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (imageRef.current) {
        imageRef.current.onload = null;
        imageRef.current.onerror = null;
        imageRef.current.src = '';
        imageRef.current = null;
      }
    };
  }, [backgroundType, backgroundImageUrl]);

  return image;
}

/**
 * Generate Konva Rect props for solid color background
 */
export function getSolidBackgroundProps(
  bounds: BackgroundBounds,
  color: string,
  borderRadius = 0
) {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fill: color,
    cornerRadius: borderRadius,
    listening: false,
  };
}

/**
 * Generate Konva Rect props for gradient background
 */
export function getGradientBackgroundProps(
  bounds: BackgroundBounds,
  angle: number,
  stops: GradientStop[],
  borderRadius = 0
) {
  const gradientPoints = calculateGradientPoints(
    angle,
    bounds.width,
    bounds.height,
    0,
    0
  );

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fillLinearGradientStartPoint: {
      x: gradientPoints.x1 - bounds.x,
      y: gradientPoints.y1 - bounds.y,
    },
    fillLinearGradientEndPoint: {
      x: gradientPoints.x2 - bounds.x,
      y: gradientPoints.y2 - bounds.y,
    },
    fillLinearGradientColorStops: gradientStopsToKonva(stops),
    cornerRadius: borderRadius,
    listening: false,
  };
}

/**
 * Hook that provides all compositor background configuration
 * Use this as the single source of truth for both preview and export
 */
export function useCompositorBackground(
  settings: CompositorSettings,
  contentBounds: BackgroundBounds
) {
  const backgroundImage = useCompositorBackgroundImage(
    settings.backgroundType,
    settings.backgroundImage
  );

  const dimensions = useMemo(
    () =>
      calculateCompositorDimensions(
        contentBounds.width,
        contentBounds.height,
        settings
      ),
    [contentBounds.width, contentBounds.height, settings]
  );

  // Background bounds for the full compositor area
  const backgroundBounds = useMemo(
    (): BackgroundBounds => ({
      x: contentBounds.x - dimensions.paddingX,
      y: contentBounds.y - dimensions.paddingY,
      width: dimensions.outputWidth,
      height: dimensions.outputHeight,
    }),
    [contentBounds, dimensions]
  );

  // Props for background rect (solid/gradient)
  const backgroundProps = useMemo(() => {
    if (!settings.enabled) return null;

    if (settings.backgroundType === 'solid') {
      return getSolidBackgroundProps(
        backgroundBounds,
        settings.backgroundColor,
        0 // No border radius on outer background
      );
    }

    if (settings.backgroundType === 'gradient') {
      return getGradientBackgroundProps(
        backgroundBounds,
        settings.gradientAngle,
        settings.gradientStops,
        0
      );
    }

    // For image type, we return solid fallback - image rendered separately
    return getSolidBackgroundProps(backgroundBounds, '#1a1a2e', 0);
  }, [settings, backgroundBounds]);

  // Image cover sizing for background image
  const imageCoverProps = useMemo(() => {
    if (
      settings.backgroundType !== 'image' ||
      !backgroundImage ||
      !settings.enabled
    ) {
      return null;
    }

    const cover = calculateCoverSize(
      backgroundImage.width,
      backgroundImage.height,
      backgroundBounds.width,
      backgroundBounds.height
    );

    return {
      image: backgroundImage,
      x: backgroundBounds.x + cover.offsetX,
      y: backgroundBounds.y + cover.offsetY,
      width: cover.width,
      height: cover.height,
      listening: false,
    };
  }, [settings.backgroundType, settings.enabled, backgroundImage, backgroundBounds]);

  // Content background props (for filling under rounded corners)
  const contentBackgroundProps = useMemo(() => {
    if (!settings.enabled || settings.borderRadius <= 0) return null;

    if (settings.backgroundType === 'solid') {
      return getSolidBackgroundProps(
        contentBounds,
        settings.backgroundColor,
        settings.borderRadius
      );
    }

    if (settings.backgroundType === 'gradient') {
      return getGradientBackgroundProps(
        contentBounds,
        settings.gradientAngle,
        settings.gradientStops,
        settings.borderRadius
      );
    }

    return null;
  }, [settings, contentBounds]);

  // Shadow props
  const shadowProps = useMemo(() => {
    if (!settings.enabled || !settings.shadowEnabled) return null;

    const intensity = settings.shadowIntensity;
    return {
      shadowColor: 'black',
      shadowBlur: 32 * intensity,
      shadowOffsetY: 8 * intensity,
      shadowOpacity: 0.35 * intensity,
    };
  }, [settings.enabled, settings.shadowEnabled, settings.shadowIntensity]);

  return {
    dimensions,
    backgroundBounds,
    backgroundProps,
    imageCoverProps,
    contentBackgroundProps,
    shadowProps,
    backgroundImage,
  };
}
