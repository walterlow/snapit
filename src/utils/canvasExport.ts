import Konva from 'konva';
import type { CompositorSettings } from '../types';

export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasBounds {
  width: number;
  height: number;
  imageOffsetX: number;
  imageOffsetY: number;
}

/**
 * Get content dimensions from canvas bounds or background image
 */
export function getContentBounds(
  stage: Konva.Stage,
  canvasBounds: CanvasBounds | null
): ContentBounds {
  const imageNode = stage.findOne('[name=background]') as Konva.Image | undefined;
  return {
    width: canvasBounds?.width || imageNode?.width() || 800,
    height: canvasBounds?.height || imageNode?.height() || 600,
    x: canvasBounds ? -canvasBounds.imageOffsetX : 0,
    y: canvasBounds ? -canvasBounds.imageOffsetY : 0,
  };
}

/**
 * Calculate export bounds with compositor padding if enabled
 */
export function calculateExportBounds(
  content: ContentBounds,
  compositorSettings: CompositorSettings
): ExportBounds {
  if (compositorSettings.enabled) {
    const padding = compositorSettings.padding;
    return {
      x: Math.round(content.x - padding),
      y: Math.round(content.y - padding),
      width: Math.round(content.width + padding * 2),
      height: Math.round(content.height + padding * 2),
    };
  }
  return {
    x: Math.round(content.x),
    y: Math.round(content.y),
    width: Math.round(content.width),
    height: Math.round(content.height),
  };
}

/**
 * Export canvas to HTMLCanvasElement, temporarily hiding editor-only elements
 */
export function exportCanvas(
  stage: Konva.Stage,
  layer: Konva.Layer,
  bounds: ExportBounds
): HTMLCanvasElement {
  // Save current transform
  const savedScale = { x: stage.scaleX(), y: stage.scaleY() };
  const savedPosition = { x: stage.x(), y: stage.y() };
  stage.scale({ x: 1, y: 1 });
  stage.position({ x: 0, y: 0 });

  // Hide editor-only elements
  const checkerboard = stage.findOne('[name=checkerboard]');
  const editorShadow = stage.findOne('[name=editor-shadow]');
  const transformer = stage.findOne('Transformer');
  if (checkerboard) checkerboard.hide();
  if (editorShadow) editorShadow.hide();
  if (transformer) transformer.hide();

  // Export from Konva
  const outputCanvas = layer.toCanvas({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    pixelRatio: 1,
  });

  // Restore immediately
  stage.scale(savedScale);
  stage.position(savedPosition);
  if (checkerboard) checkerboard.show();
  if (editorShadow) editorShadow.show();
  if (transformer) transformer.show();

  return outputCanvas;
}

/**
 * Convert canvas to blob with specified format
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string = 'image/png',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to create blob'));
      },
      mimeType,
      quality
    );
  });
}
