/**
 * Feature detection for WebCodecs and Web Worker support.
 */

export function supportsWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export function supportsWorkers(): boolean {
  return typeof Worker !== 'undefined';
}

export function supportsImageBitmapTransfer(): boolean {
  return typeof createImageBitmap !== 'undefined' && typeof ImageBitmap !== 'undefined';
}

export function supportsWebCodecsWorker(): boolean {
  return supportsWebCodecs() && supportsWorkers() && supportsImageBitmapTransfer();
}

/**
 * Check if a specific codec is supported by WebCodecs
 */
export async function isCodecSupported(codec: string): Promise<boolean> {
  if (!supportsWebCodecs()) return false;

  try {
    const support = await VideoDecoder.isConfigSupported({
      codec,
      codedWidth: 1920,
      codedHeight: 1080,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}
