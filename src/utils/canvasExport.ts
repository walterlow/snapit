import Konva from 'konva';
import { writeFile } from '@tauri-apps/plugin-fs';
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
  const transformer = stage.findOne('[name=transformer]');
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

// ============================================================================
// High-Level Export Utilities
// ============================================================================

export interface ExportOptions {
  format: 'image/png' | 'image/jpeg' | 'image/webp';
  quality?: number; // 0-1 for jpeg/webp
}

/**
 * Export the current canvas state to a Blob.
 * Handles stage reset, layer finding, bounds calculation, and cleanup.
 */
export async function exportToBlob(
  stageRef: React.RefObject<Konva.Stage | null>,
  canvasBounds: CanvasBounds | null,
  compositorSettings: CompositorSettings,
  options: ExportOptions = { format: 'image/png' }
): Promise<Blob> {
  const stage = stageRef.current;
  if (!stage) throw new Error('Stage not available');

  const layer = stage.findOne('Layer') as Konva.Layer | undefined;
  if (!layer) throw new Error('Layer not found');

  const content = getContentBounds(stage, canvasBounds);
  const bounds = calculateExportBounds(content, compositorSettings);
  const outputCanvas = exportCanvas(stage, layer, bounds);

  return new Promise<Blob>((resolve, reject) => {
    outputCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to create blob'))),
      options.format,
      options.quality
    );
  });
}

/**
 * Export canvas and copy to clipboard.
 */
export async function exportToClipboard(
  stageRef: React.RefObject<Konva.Stage | null>,
  canvasBounds: CanvasBounds | null,
  compositorSettings: CompositorSettings
): Promise<void> {
  const blob = await exportToBlob(stageRef, canvasBounds, compositorSettings);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/**
 * Export canvas to file using Tauri's writeFile.
 */
export async function exportToFile(
  stageRef: React.RefObject<Konva.Stage | null>,
  canvasBounds: CanvasBounds | null,
  compositorSettings: CompositorSettings,
  filePath: string,
  options: ExportOptions = { format: 'image/png' }
): Promise<void> {
  const blob = await exportToBlob(stageRef, canvasBounds, compositorSettings, options);
  const arrayBuffer = await blob.arrayBuffer();
  await writeFile(filePath, new Uint8Array(arrayBuffer));
}

