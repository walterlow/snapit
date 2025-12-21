/**
 * GPU-accelerated blur rendering utilities
 * Renders blur/pixelate effects to offscreen canvas for Konva Image display
 */

// Result from blur rendering - includes actual bounds for proper positioning
export interface BlurRenderResult {
  canvas: HTMLCanvasElement;
  x: number;      // Actual x position (clamped to image bounds)
  y: number;      // Actual y position (clamped to image bounds)
  width: number;  // Actual width (may be smaller if clipped)
  height: number; // Actual height (may be smaller if clipped)
}

/**
 * Renders blur effect to an offscreen canvas
 * Returns the canvas AND the actual bounds (clamped to image) for correct positioning
 *
 * @param sourceImage - The source image to blur
 * @param x - X position of blur region
 * @param y - Y position of blur region
 * @param width - Width of blur region (can be negative)
 * @param height - Height of blur region (can be negative)
 * @param blurType - 'pixelate' or 'blur'
 * @param blurAmount - Intensity of the blur/pixelate effect
 * @returns BlurRenderResult with canvas and clamped bounds, or null if invalid
 */
export const renderBlurCanvas = (
  sourceImage: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  blurType: string,
  blurAmount: number
): BlurRenderResult | null => {
  // Handle negative dimensions (drawing right-to-left or bottom-to-top)
  const absWidth = Math.abs(width);
  const absHeight = Math.abs(height);

  if (absWidth < 1 || absHeight < 1) return null;

  // Normalize position for negative dimensions
  const normalizedX = width < 0 ? x + width : x;
  const normalizedY = height < 0 ? y + height : y;

  // Calculate the intersection with image bounds
  const imgW = sourceImage.width;
  const imgH = sourceImage.height;

  // Clamp to image bounds
  const clampedX = Math.max(0, normalizedX);
  const clampedY = Math.max(0, normalizedY);
  const clampedRight = Math.min(imgW, normalizedX + absWidth);
  const clampedBottom = Math.min(imgH, normalizedY + absHeight);

  // Actual dimensions after clamping
  const actualW = clampedRight - clampedX;
  const actualH = clampedBottom - clampedY;

  // If completely outside image bounds, return null
  if (actualW < 1 || actualH < 1) return null;

  const canvas = document.createElement('canvas');
  canvas.width = actualW;
  canvas.height = actualH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (blurType === 'pixelate') {
    // Fast pixelation: downscale then upscale with nearest-neighbor
    const pixelSize = Math.max(2, blurAmount);
    const smallW = Math.max(1, Math.ceil(actualW / pixelSize));
    const smallH = Math.max(1, Math.ceil(actualH / pixelSize));

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sourceImage, clampedX, clampedY, actualW, actualH, 0, 0, smallW, smallH);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, smallW, smallH, 0, 0, actualW, actualH);
  } else {
    // GPU-accelerated blur via native canvas filter
    ctx.filter = `blur(${blurAmount}px)`;
    const padding = blurAmount * 2;
    ctx.drawImage(
      sourceImage,
      clampedX - padding, clampedY - padding, actualW + padding * 2, actualH + padding * 2,
      -padding, -padding, actualW + padding * 2, actualH + padding * 2
    );
    ctx.filter = 'none';
  }

  return {
    canvas,
    x: clampedX,
    y: clampedY,
    width: actualW,
    height: actualH
  };
};
