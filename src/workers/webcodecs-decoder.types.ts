/**
 * Message types for WebCodecs decoder worker communication.
 * Uses discriminated unions for type-safe message handling.
 */

// ============ Main Thread -> Worker Messages ============

export interface InitMessage {
  type: 'init';
  videoUrl: string;
  maxCacheSize?: number;
}

export interface DecodeFrameMessage {
  type: 'decode-frame';
  timestampMs: number;
  requestId: number;
  priority: 'immediate' | 'prefetch';
}

export interface ClearCacheMessage {
  type: 'clear-cache';
}

export interface DisposeMessage {
  type: 'dispose';
}

export type MainToWorkerMessage =
  | InitMessage
  | DecodeFrameMessage
  | ClearCacheMessage
  | DisposeMessage;

// ============ Worker -> Main Thread Messages ============

export interface ReadyMessage {
  type: 'ready';
  dimensions: { width: number; height: number };
  durationMs: number;
}

export interface FrameDecodedMessage {
  type: 'frame-decoded';
  requestId: number;
  timestampMs: number;
  bitmap: ImageBitmap;
}

export interface FrameErrorMessage {
  type: 'frame-error';
  requestId: number;
  timestampMs: number;
  error: string;
}

export interface InitErrorMessage {
  type: 'init-error';
  error: string;
}

export interface CacheEvictedMessage {
  type: 'cache-evicted';
  timestampMs: number;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | FrameDecodedMessage
  | FrameErrorMessage
  | InitErrorMessage
  | CacheEvictedMessage;
