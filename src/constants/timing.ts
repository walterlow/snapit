/**
 * Timing constants for debounce, delays, and animations.
 * Centralizing these prevents magic numbers and enables tuning.
 */

export const TIMING = {
  // Debounce intervals
  RESIZE_DEBOUNCE_MS: 150,
  RESIZE_TRANSITION_LOCK_MS: 200,

  // Delay for async operations
  RECORDING_COMPLETE_DELAY_MS: 500,
  THUMBNAIL_REFRESH_DELAY_MS: 2000,

  // Tooltip delays
  TOOLTIP_DELAY_MS: 300,

  // UI interaction delays
  SUGGESTION_BLUR_DELAY_MS: 150,
} as const;

export type TimingConstants = typeof TIMING;
