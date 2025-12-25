/**
 * Fast image loading utilities for raw RGBA data.
 *
 * This module provides functions to load raw RGBA pixel data from temp files
 * and convert them to ImageBitmap for fast canvas rendering.
 * This bypasses the slow PNG encode/decode cycle for editor display.
 */

import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

/**
 * Load raw RGBA data from a temp file and create an ImageBitmap.
 * This is much faster than the PNG encode → base64 → data URL → decode path.
 *
 * IMPORTANT: The returned ImageBitmap should be closed when no longer needed
 * by calling bitmap.close() to release GPU memory.
 *
 * @param filePath Path to the .rgba temp file
 * @returns ImageBitmap and dimensions. Caller is responsible for calling bitmap.close()
 */
export async function loadRgbaToImageBitmap(filePath: string): Promise<{
  bitmap: ImageBitmap;
  width: number;
  height: number;
}> {
  // Read the raw file
  const data = await readFile(filePath);
  const buffer = data.buffer;
  const view = new DataView(buffer);

  // Parse header (8 bytes: width u32 LE, height u32 LE)
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);

  // Extract RGBA data (after 8-byte header)
  const rgbaData = new Uint8ClampedArray(buffer, 8);

  // Create ImageData from raw RGBA
  const imageData = new ImageData(rgbaData, width, height);

  // Convert to ImageBitmap (this is GPU-accelerated in modern browsers)
  const bitmap = await createImageBitmap(imageData);

  return { bitmap, width, height };
}

/**
 * Close an ImageBitmap to release GPU memory.
 * Safe to call even if bitmap is null/undefined.
 */
export function closeImageBitmap(bitmap: ImageBitmap | null | undefined): void {
  if (bitmap) {
    bitmap.close();
  }
}

/**
 * Load raw RGBA data from a temp file and convert to base64 PNG.
 * Use this when you need the base64 format (e.g., for saving to storage).
 *
 * @param filePath Path to the .rgba temp file
 * @returns Base64-encoded PNG data
 */
export async function loadRgbaToBase64(filePath: string): Promise<{
  imageData: string;
  width: number;
  height: number;
}> {
  // Read the raw file
  const data = await readFile(filePath);
  const buffer = data.buffer;
  const view = new DataView(buffer);

  // Parse header
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);

  // Extract RGBA data
  const rgbaData = new Uint8ClampedArray(buffer, 8);

  // Create canvas and draw the image
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(rgbaData, width, height);
  ctx.putImageData(imageData, 0, 0);

  // Convert to PNG blob
  const blob = await canvas.convertToBlob({ type: 'image/png' });

  // Convert to base64
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuffer).reduce(
      (data, byte) => data + String.fromCharCode(byte),
      ''
    )
  );

  return { imageData: base64, width, height };
}

/**
 * Load raw RGBA and convert to data URL for use with useImage hook.
 * This is a middle-ground approach when you need compatibility with existing code.
 *
 * @param filePath Path to the .rgba temp file
 * @returns Data URL string
 */
export async function loadRgbaToDataUrl(filePath: string): Promise<{
  dataUrl: string;
  width: number;
  height: number;
}> {
  const { imageData, width, height } = await loadRgbaToBase64(filePath);
  return {
    dataUrl: `data:image/png;base64,${imageData}`,
    width,
    height,
  };
}

/**
 * Cleanup a temp RGBA file.
 * Call this when you're done with a fast capture to free disk space.
 *
 * @param filePath Path to the .rgba temp file
 */
export async function cleanupRgbaFile(filePath: string): Promise<void> {
  try {
    await invoke('cleanup_rgba_file', { filePath });
  } catch (error) {
    // Ignore cleanup errors - file might already be deleted
    console.warn('Failed to cleanup temp file:', error);
  }
}

/**
 * Convert fast capture result to base64 format (for saving to storage).
 * This performs the PNG encoding that was skipped during capture.
 *
 * @param filePath Path to the .rgba temp file
 * @returns CaptureResult with base64 image data
 */
export async function convertFastCaptureToBase64(filePath: string): Promise<{
  image_data: string;
  width: number;
  height: number;
}> {
  // Use the Rust command which does proper PNG encoding
  const result = await invoke<{
    image_data: string;
    width: number;
    height: number;
  }>('read_rgba_file', { filePath });

  return result;
}
