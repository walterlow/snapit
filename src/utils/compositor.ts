/**
 * Compositor utilities for image export
 * 
 * Uses shared logic from useCompositorBackground hook to ensure
 * preview and export render identically.
 */

import type { CompositorSettings } from '../types';
import type { CanvasBounds } from '../stores/editorStore';
import {
  calculateGradientPoints,
  calculateCoverSize,
  calculateCompositorDimensions,
} from '../hooks/useCompositorBackground';

interface CompositeOptions {
  settings: CompositorSettings;
  sourceCanvas: HTMLCanvasElement;
  canvasBounds?: CanvasBounds | null;
}

/**
 * Draw a rounded rectangle path
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Draw background using shared gradient/cover calculations
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  settings: CompositorSettings,
  width: number,
  height: number,
  backgroundImage: HTMLImageElement | null
) {
  ctx.save();

  switch (settings.backgroundType) {
    case 'solid':
      ctx.fillStyle = settings.backgroundColor;
      ctx.fillRect(0, 0, width, height);
      break;

    case 'gradient': {
      // Use shared gradient calculation
      const gradientPoints = calculateGradientPoints(
        settings.gradientAngle,
        width,
        height
      );

      const gradient = ctx.createLinearGradient(
        gradientPoints.x1,
        gradientPoints.y1,
        gradientPoints.x2,
        gradientPoints.y2
      );
      settings.gradientStops.forEach((stop) => {
        gradient.addColorStop(stop.position / 100, stop.color);
      });

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      break;
    }

    case 'image':
      if (backgroundImage) {
        // Use shared cover calculation
        const cover = calculateCoverSize(
          backgroundImage.width,
          backgroundImage.height,
          width,
          height
        );
        ctx.drawImage(
          backgroundImage,
          cover.offsetX,
          cover.offsetY,
          cover.width,
          cover.height
        );
      } else {
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, width, height);
      }
      break;
  }

  ctx.restore();
}

/**
 * Draw shadow layers
 */
function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  intensity: number
) {
  ctx.save();

  // Multiple shadow layers for realistic effect
  const shadowLayers = [
    { blur: 10, opacity: 0.15 * intensity, offsetY: 2 },
    { blur: 30, opacity: 0.25 * intensity, offsetY: 8 },
    { blur: 60, opacity: 0.35 * intensity, offsetY: 16 },
  ];

  shadowLayers.forEach((layer) => {
    ctx.shadowColor = `rgba(0, 0, 0, ${layer.opacity})`;
    ctx.shadowBlur = layer.blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = layer.offsetY;

    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.fill();
  });

  ctx.restore();
}

/**
 * Load an image from URL
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Clean up a temporary canvas to release memory
 */
function cleanupCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Clean up an image element to release memory
 */
function cleanupImage(img: HTMLImageElement | null): void {
  if (!img) return;
  img.onload = null;
  img.onerror = null;
  img.src = '';
}

/**
 * Composite an image with compositor settings applied
 * Uses shared dimension calculations to match preview exactly
 * 
 * Note: This function properly cleans up intermediate canvases and images
 * to prevent memory leaks during frequent exports.
 */
export async function compositeImage(
  options: CompositeOptions
): Promise<HTMLCanvasElement> {
  const { settings, sourceCanvas, canvasBounds } = options;

  // Track intermediate resources for cleanup
  let croppedCanvas: HTMLCanvasElement | null = null;
  let tempCanvas: HTMLCanvasElement | null = null;
  let backgroundImage: HTMLImageElement | null = null;

  try {
    // Apply canvas bounds (crop/expand) if provided
    let workingCanvas = sourceCanvas;

    if (canvasBounds) {
      croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = canvasBounds.width;
      croppedCanvas.height = canvasBounds.height;
      const croppedCtx = croppedCanvas.getContext('2d');

      if (croppedCtx) {
        croppedCtx.clearRect(0, 0, canvasBounds.width, canvasBounds.height);
        croppedCtx.drawImage(
          sourceCanvas,
          canvasBounds.imageOffsetX,
          canvasBounds.imageOffsetY
        );
        workingCanvas = croppedCanvas;
      }
    }

    // If compositor disabled, return canvas as-is
    if (!settings.enabled) {
      // Don't cleanup croppedCanvas if we're returning it
      if (workingCanvas === croppedCanvas) {
        croppedCanvas = null; // Prevent cleanup
      }
      return workingCanvas;
    }

    const sourceWidth = workingCanvas.width;
    const sourceHeight = workingCanvas.height;

    // Use shared dimension calculation (matches preview exactly)
    const dimensions = calculateCompositorDimensions(
      sourceWidth,
      sourceHeight,
      settings
    );

    // Create output canvas
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = dimensions.outputWidth;
    outputCanvas.height = dimensions.outputHeight;
    const ctx = outputCanvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Load background image if needed
    if (settings.backgroundType === 'image' && settings.backgroundImage) {
      backgroundImage = await loadImage(settings.backgroundImage);
    }

    // Draw full background
    drawBackground(
      ctx,
      settings,
      dimensions.outputWidth,
      dimensions.outputHeight,
      backgroundImage
    );

    // Draw shadow if enabled
    if (settings.shadowEnabled) {
      drawShadow(
        ctx,
        dimensions.contentX,
        dimensions.contentY,
        sourceWidth,
        sourceHeight,
        settings.borderRadius,
        settings.shadowIntensity
      );
    }

    // Create temp canvas for content with rounded corners
    tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceWidth;
    tempCanvas.height = sourceHeight;
    const tempCtx = tempCanvas.getContext('2d');

    if (tempCtx) {
      // Apply rounded clip first
      if (settings.borderRadius > 0) {
        drawRoundedRect(tempCtx, 0, 0, sourceWidth, sourceHeight, settings.borderRadius);
        tempCtx.clip();
      }

      // Fill with background (for transparent areas)
      drawBackground(tempCtx, settings, sourceWidth, sourceHeight, backgroundImage);

      // Draw source content
      tempCtx.drawImage(workingCanvas, 0, 0);

      // Draw to output at correct position
      ctx.drawImage(tempCanvas, dimensions.contentX, dimensions.contentY);
    } else {
      ctx.drawImage(workingCanvas, dimensions.contentX, dimensions.contentY);
    }

    return outputCanvas;
  } finally {
    // Clean up intermediate resources to prevent memory leaks
    cleanupCanvas(croppedCanvas);
    cleanupCanvas(tempCanvas);
    cleanupImage(backgroundImage);
  }
}

