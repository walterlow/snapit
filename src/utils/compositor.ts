import type { CompositorSettings, GradientStop } from '../types';
import type { CanvasBounds } from '../stores/editorStore';

interface CompositeOptions {
  settings: CompositorSettings;
  sourceCanvas: HTMLCanvasElement;
  canvasBounds?: CanvasBounds | null; // Optional crop/expand bounds
}

interface AspectRatioDimensions {
  width: number;
  height: number;
}

function getAspectRatioDimensions(
  aspectRatio: CompositorSettings['aspectRatio'],
  contentWidth: number,
  contentHeight: number,
  padding: number
): AspectRatioDimensions {
  // Calculate content area with padding
  const paddingFactor = 1 + (padding / 100) * 2;
  const contentAreaWidth = contentWidth * paddingFactor;
  const contentAreaHeight = contentHeight * paddingFactor;

  switch (aspectRatio) {
    case '16:9': {
      const targetRatio = 16 / 9;
      if (contentAreaWidth / contentAreaHeight > targetRatio) {
        return { width: contentAreaWidth, height: contentAreaWidth / targetRatio };
      } else {
        return { width: contentAreaHeight * targetRatio, height: contentAreaHeight };
      }
    }
    case '4:3': {
      const targetRatio = 4 / 3;
      if (contentAreaWidth / contentAreaHeight > targetRatio) {
        return { width: contentAreaWidth, height: contentAreaWidth / targetRatio };
      } else {
        return { width: contentAreaHeight * targetRatio, height: contentAreaHeight };
      }
    }
    case '1:1': {
      const maxDim = Math.max(contentAreaWidth, contentAreaHeight);
      return { width: maxDim, height: maxDim };
    }
    case 'twitter': {
      const targetRatio = 16 / 9;
      if (contentAreaWidth / contentAreaHeight > targetRatio) {
        return { width: contentAreaWidth, height: contentAreaWidth / targetRatio };
      } else {
        return { width: contentAreaHeight * targetRatio, height: contentAreaHeight };
      }
    }
    case 'instagram': {
      const targetRatio = 4 / 5;
      if (contentAreaWidth / contentAreaHeight > targetRatio) {
        return { width: contentAreaHeight * targetRatio, height: contentAreaHeight };
      } else {
        return { width: contentAreaWidth, height: contentAreaWidth / targetRatio };
      }
    }
    case 'auto':
    default:
      return { width: contentAreaWidth, height: contentAreaHeight };
  }
}

function createGradientString(stops: GradientStop[], angle: number): string {
  const gradientStops = stops
    .map((s) => `${s.color} ${s.position}%`)
    .join(', ');
  return `linear-gradient(${angle}deg, ${gradientStops})`;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

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
      // Convert angle to radians and calculate gradient line
      const angleRad = (settings.gradientAngle - 90) * (Math.PI / 180);
      const centerX = width / 2;
      const centerY = height / 2;
      const length = Math.sqrt(width * width + height * height) / 2;

      const x1 = centerX - Math.cos(angleRad) * length;
      const y1 = centerY - Math.sin(angleRad) * length;
      const x2 = centerX + Math.cos(angleRad) * length;
      const y2 = centerY + Math.sin(angleRad) * length;

      const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
      settings.gradientStops.forEach((stop) => {
        gradient.addColorStop(stop.position / 100, stop.color);
      });

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      break;
    }

    case 'image':
      if (backgroundImage) {
        // Cover the canvas with the background image
        const imgRatio = backgroundImage.width / backgroundImage.height;
        const canvasRatio = width / height;

        let drawWidth: number, drawHeight: number, offsetX: number, offsetY: number;

        if (imgRatio > canvasRatio) {
          drawHeight = height;
          drawWidth = height * imgRatio;
          offsetX = (width - drawWidth) / 2;
          offsetY = 0;
        } else {
          drawWidth = width;
          drawHeight = width / imgRatio;
          offsetX = 0;
          offsetY = (height - drawHeight) / 2;
        }

        ctx.drawImage(backgroundImage, offsetX, offsetY, drawWidth, drawHeight);
      } else {
        // Fallback to a dark color if no image
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, width, height);
      }
      break;
  }

  ctx.restore();
}

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

  // Multiple shadow layers for more realistic effect
  const shadowLayers = [
    { blur: 10, opacity: 0.1 * intensity, offsetY: 2 },
    { blur: 30, opacity: 0.15 * intensity, offsetY: 8 },
    { blur: 60, opacity: 0.2 * intensity, offsetY: 16 },
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

export async function compositeImage(options: CompositeOptions): Promise<HTMLCanvasElement> {
  const { settings, sourceCanvas, canvasBounds } = options;

  // First, apply canvas bounds (crop/expand) if provided
  let workingCanvas = sourceCanvas;
  
  if (canvasBounds) {
    // Create a new canvas with the cropped/expanded dimensions
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = canvasBounds.width;
    croppedCanvas.height = canvasBounds.height;
    const croppedCtx = croppedCanvas.getContext('2d');
    
    if (croppedCtx) {
      // Fill with transparent (for expanded areas)
      croppedCtx.clearRect(0, 0, canvasBounds.width, canvasBounds.height);
      
      // Draw the source at the correct offset
      // imageOffsetX/Y is where the image sits on the canvas
      croppedCtx.drawImage(
        sourceCanvas,
        canvasBounds.imageOffsetX,
        canvasBounds.imageOffsetY
      );
      
      workingCanvas = croppedCanvas;
    }
  }

  // If compositor is disabled, return the working canvas (with crop applied)
  if (!settings.enabled) {
    return workingCanvas;
  }

  const sourceWidth = workingCanvas.width;
  const sourceHeight = workingCanvas.height;

  // Calculate output dimensions based on aspect ratio and padding
  const outputDimensions = getAspectRatioDimensions(
    settings.aspectRatio,
    sourceWidth,
    sourceHeight,
    settings.padding
  );

  // Create output canvas
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = Math.round(outputDimensions.width);
  outputCanvas.height = Math.round(outputDimensions.height);
  const ctx = outputCanvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Load background image if needed
  let backgroundImage: HTMLImageElement | null = null;
  if (settings.backgroundType === 'image' && settings.backgroundImage) {
    backgroundImage = await loadImage(settings.backgroundImage);
  }

  // Calculate screenshot position (centered with padding) - round to avoid sub-pixel artifacts
  const paddingX = Math.round((outputCanvas.width - sourceWidth) / 2);
  const paddingY = Math.round((outputCanvas.height - sourceHeight) / 2);

  // Draw shadow if enabled (must be drawn on background first)
  drawBackground(ctx, settings, outputCanvas.width, outputCanvas.height, backgroundImage);

  if (settings.shadowEnabled) {
    drawShadow(
      ctx,
      paddingX,
      paddingY,
      sourceWidth,
      sourceHeight,
      settings.borderRadius,
      settings.shadowIntensity
    );
  }

  // Create a temporary canvas for the screenshot (with optional rounded corners)
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = sourceWidth;
  tempCanvas.height = sourceHeight;
  const tempCtx = tempCanvas.getContext('2d');

if (tempCtx) {
    // Apply rounded clip FIRST (before drawing anything)
    // This ensures both background fill and source image are clipped to rounded corners
    if (settings.borderRadius > 0) {
      drawRoundedRect(tempCtx, 0, 0, sourceWidth, sourceHeight, settings.borderRadius);
      tempCtx.clip();
    }

    // Fill transparent areas of the source with the background (now clipped)
    // This ensures expanded crop areas get the background color
    drawBackground(tempCtx, settings, sourceWidth, sourceHeight, backgroundImage);

    // Draw the source image on top - transparent areas will show background
    tempCtx.drawImage(workingCanvas, 0, 0);

    // Draw the composited image onto the output
    // Corners are now transparent (clipped), showing the main background underneath
    ctx.drawImage(tempCanvas, paddingX, paddingY);
  } else {
    // Fallback: draw directly
    ctx.drawImage(workingCanvas, paddingX, paddingY);
  }

  return outputCanvas;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Preview function for showing live preview in the editor
export function getCompositorPreviewStyle(settings: CompositorSettings): React.CSSProperties {
  if (!settings.enabled) {
    return {};
  }

  let background: string;

  switch (settings.backgroundType) {
    case 'solid':
      background = settings.backgroundColor;
      break;
    case 'gradient':
      background = createGradientString(settings.gradientStops, settings.gradientAngle);
      break;
    case 'image':
      background = settings.backgroundImage
        ? `url(${settings.backgroundImage})`
        : '#1a1a2e';
      break;
    default:
      background = '#1a1a2e';
  }

  return {
    background,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    padding: `${settings.padding}%`,
  };
}
