/**
 * WebCodecs decoder worker - handles video frame decoding off main thread.
 *
 * Uses mediabunny for hardware-accelerated WebCodecs decoding.
 * Frames are converted to ImageBitmap and transferred (not copied) to main thread.
 */

import { Input, ALL_FORMATS, UrlSource, VideoSampleSink } from 'mediabunny';
import type { InputVideoTrack } from 'mediabunny';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  DecodeFrameMessage,
} from './webcodecs-decoder.types';

// State
let input: Input<UrlSource> | null = null;
let sink: VideoSampleSink | null = null;
let videoTrack: InputVideoTrack | null = null;
let durationMs = 0;

// Decode queue - prioritizes immediate requests over prefetch
const pendingDecodes = new Map<number, DecodeFrameMessage>();
let isDecoding = false;

// Worker-side cache to avoid re-decoding recently accessed frames
const workerFrameCache = new Map<number, ImageBitmap>();
const WORKER_CACHE_SIZE = 10;

/**
 * Send typed message to main thread
 */
function postTypedMessage(
  message: WorkerToMainMessage,
  transfer?: Transferable[]
): void {
  self.postMessage(message, { transfer });
}

/**
 * Initialize mediabunny with the video URL
 */
async function handleInit(videoUrl: string, maxCacheSize: number): Promise<void> {
  try {
    // Clean up previous state if re-initializing
    dispose();

    const source = new UrlSource(videoUrl, {
      maxCacheSize,
    });

    input = new Input({
      formats: ALL_FORMATS,
      source,
    });

    videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error('No video track found');
    }

    const canDecode = await videoTrack.canDecode();
    if (!canDecode) {
      throw new Error('Video codec not supported by WebCodecs');
    }

    const duration = await videoTrack.computeDuration();
    durationMs = duration * 1000;

    sink = new VideoSampleSink(videoTrack);

    postTypedMessage({
      type: 'ready',
      dimensions: {
        width: videoTrack.displayWidth,
        height: videoTrack.displayHeight,
      },
      durationMs,
    });
  } catch (err) {
    postTypedMessage({
      type: 'init-error',
      error: err instanceof Error ? err.message : 'Failed to initialize',
    });
  }
}

/**
 * Decode a frame and transfer ImageBitmap to main thread
 */
async function decodeFrame(msg: DecodeFrameMessage): Promise<void> {
  if (!sink) {
    postTypedMessage({
      type: 'frame-error',
      requestId: msg.requestId,
      timestampMs: msg.timestampMs,
      error: 'Decoder not initialized',
    });
    return;
  }

  // Check worker-side cache first
  const cacheKey = Math.round(msg.timestampMs);
  const cached = workerFrameCache.get(cacheKey);
  if (cached) {
    try {
      // Clone the bitmap for transfer (original stays in cache)
      const clonedBitmap = await createImageBitmap(cached);
      postTypedMessage(
        {
          type: 'frame-decoded',
          requestId: msg.requestId,
          timestampMs: msg.timestampMs,
          bitmap: clonedBitmap,
        },
        [clonedBitmap]
      );
      return;
    } catch {
      // Cache entry invalid, remove it and decode fresh
      workerFrameCache.delete(cacheKey);
    }
  }

  try {
    const timestampSec = msg.timestampMs / 1000;
    const sample = await sink.getSample(timestampSec);

    if (sample) {
      const videoFrame = sample.toVideoFrame();
      const bitmap = await createImageBitmap(videoFrame);
      videoFrame.close();
      sample.close();

      // Store in worker cache
      if (workerFrameCache.size >= WORKER_CACHE_SIZE) {
        // Evict oldest entry
        const firstKey = workerFrameCache.keys().next().value;
        if (firstKey !== undefined) {
          const evicted = workerFrameCache.get(firstKey);
          evicted?.close();
          workerFrameCache.delete(firstKey);
          postTypedMessage({ type: 'cache-evicted', timestampMs: firstKey });
        }
      }

      // Clone for cache, transfer original
      const cacheClone = await createImageBitmap(bitmap);
      workerFrameCache.set(cacheKey, cacheClone);

      postTypedMessage(
        {
          type: 'frame-decoded',
          requestId: msg.requestId,
          timestampMs: msg.timestampMs,
          bitmap,
        },
        [bitmap]
      );
    } else {
      postTypedMessage({
        type: 'frame-error',
        requestId: msg.requestId,
        timestampMs: msg.timestampMs,
        error: 'No sample at timestamp',
      });
    }
  } catch (err) {
    postTypedMessage({
      type: 'frame-error',
      requestId: msg.requestId,
      timestampMs: msg.timestampMs,
      error: err instanceof Error ? err.message : 'Decode failed',
    });
  }
}

/**
 * Process decode queue with priority handling
 */
async function processQueue(): Promise<void> {
  if (isDecoding || pendingDecodes.size === 0) return;

  isDecoding = true;

  try {
    // Process immediate requests first, then prefetch
    const immediate = [...pendingDecodes.values()]
      .filter((m) => m.priority === 'immediate')
      .sort((a, b) => a.requestId - b.requestId);

    const prefetch = [...pendingDecodes.values()]
      .filter((m) => m.priority === 'prefetch')
      .sort((a, b) => a.requestId - b.requestId);

    const queue = [...immediate, ...prefetch];

    for (const msg of queue) {
      pendingDecodes.delete(msg.requestId);
      await decodeFrame(msg);
    }
  } finally {
    isDecoding = false;
  }

  // Continue if more requests came in
  if (pendingDecodes.size > 0) {
    processQueue();
  }
}

/**
 * Clear the worker-side frame cache
 */
function clearCache(): void {
  for (const bitmap of workerFrameCache.values()) {
    bitmap.close();
  }
  workerFrameCache.clear();
}

/**
 * Clean up all resources
 */
function dispose(): void {
  clearCache();
  pendingDecodes.clear();

  sink = null;
  videoTrack = null;

  if (input) {
    try {
      input.dispose();
    } catch {
      // Ignore dispose errors
    }
    input = null;
  }
}

// Message handler
self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init':
      handleInit(msg.videoUrl, msg.maxCacheSize ?? 16 * 1024 * 1024);
      break;

    case 'decode-frame':
      pendingDecodes.set(msg.requestId, msg);
      processQueue();
      break;

    case 'clear-cache':
      clearCache();
      break;

    case 'dispose':
      dispose();
      break;
  }
};
