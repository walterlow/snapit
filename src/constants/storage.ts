/**
 * Storage and cache constants for stores.
 * Centralizing these prevents magic numbers and enables tuning.
 */

export const STORAGE = {
  // Editor history limits
  HISTORY_LIMIT: 50,
  HISTORY_MEMORY_LIMIT_BYTES: 50 * 1024 * 1024, // 50MB max memory for history

  // Library cache configuration
  LIBRARY_CACHE_KEY: 'snapit_library_cache',
  LIBRARY_CACHE_TIMESTAMP_KEY: 'snapit_library_cache_timestamp',
  CACHE_MAX_AGE_MS: 5 * 60 * 1000, // 5 minutes - after this, show stale indicator
} as const;

export type StorageConstants = typeof STORAGE;
