import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useMemo } from 'react';
import type {
  CaptureListItem,
  CaptureProject,
  StorageStats,
  Annotation,
  CaptureSource,
  SaveCaptureResponse,
} from '../types';
import { libraryLogger } from '../utils/logger';
import { STORAGE } from '../constants';

interface LibraryCache {
  captures: CaptureListItem[];
  timestamp: number;
}

// Save captures to localStorage cache
function saveToCache(captures: CaptureListItem[]): void {
  try {
    // Only cache real captures, not temporary placeholders
    const realCaptures = captures.filter(c => !c.id.startsWith('temp_'));
    localStorage.setItem(STORAGE.LIBRARY_CACHE_KEY, JSON.stringify(realCaptures));
    localStorage.setItem(STORAGE.LIBRARY_CACHE_TIMESTAMP_KEY, Date.now().toString());
  } catch (e) {
    // localStorage might be full or disabled - fail silently
    libraryLogger.warn('Failed to cache library:', e);
  }
}

// Load captures from localStorage cache
function loadFromCache(): LibraryCache | null {
  try {
    const cached = localStorage.getItem(STORAGE.LIBRARY_CACHE_KEY);
    const timestamp = localStorage.getItem(STORAGE.LIBRARY_CACHE_TIMESTAMP_KEY);
    if (cached && timestamp) {
      return {
        captures: JSON.parse(cached),
        timestamp: parseInt(timestamp, 10),
      };
    }
  } catch (e) {
    libraryLogger.warn('Failed to load library cache:', e);
  }
  return null;
}

// Check if cache is stale (older than max age)
function isCacheStale(timestamp: number): boolean {
  return Date.now() - timestamp > STORAGE.CACHE_MAX_AGE_MS;
}

interface CaptureState {
  // Library state
  captures: CaptureListItem[];
  loading: boolean;
  initialized: boolean; // True after first load attempt completes
  error: string | null;

  // Cache state
  isFromCache: boolean; // True if currently showing cached data
  isCacheStale: boolean; // True if cache is older than max age
  isRefreshing: boolean; // True if refreshing in background

  // Current editor state
  currentProject: CaptureProject | null;
  currentImageData: string | null;
  hasUnsavedChanges: boolean;

  // Loading states for optimistic UI
  loadingProjectId: string | null; // Which project is being loaded into editor
  skipStagger: boolean; // Skip stagger animation when returning from editor

  // Filter/search state
  searchQuery: string;
  filterFavorites: boolean;
  filterTags: string[];

  // View state
  view: 'library' | 'editor';

  // Actions
  loadCaptures: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  saveNewCapture: (
    imageData: string,
    captureType: string,
    source: CaptureSource,
    options?: { silent?: boolean }
  ) => Promise<string>;
  saveNewCaptureFromFile: (
    filePath: string,
    width: number,
    height: number,
    captureType: string,
    source: CaptureSource,
    options?: { silent?: boolean }
  ) => Promise<string>;
  updateAnnotations: (annotations: Annotation[]) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  updateTags: (id: string, tags: string[]) => Promise<void>;
  bulkAddTags: (ids: string[], tagsToAdd: string[]) => Promise<void>;
  deleteCapture: (id: string) => Promise<void>;
  deleteCaptures: (ids: string[]) => Promise<void>;
  getStorageStats: () => Promise<StorageStats>;

  // UI actions
  setSearchQuery: (query: string) => void;
  setFilterFavorites: (value: boolean) => void;
  setFilterTags: (tags: string[]) => void;
  setSkipStagger: (value: boolean) => void;
  clearCurrentProject: () => void;
  setHasUnsavedChanges: (value: boolean) => void;
  setView: (view: 'library' | 'editor') => void;
  setCurrentImageData: (data: string | null) => void;
  setCurrentProject: (project: CaptureProject | null) => void;
}

// Helper: Create placeholder capture for optimistic updates
function createPlaceholderCapture(
  tempId: string,
  now: string,
  captureType: string,
  dimensions: { width: number; height: number } = { width: 0, height: 0 }
): CaptureListItem {
  return {
    id: tempId,
    created_at: now,
    updated_at: now,
    capture_type: captureType,
    dimensions,
    thumbnail_path: '',
    image_path: '',
    has_annotations: false,
    tags: [],
    favorite: false,
    is_missing: false,
  };
}

// Helper: Create CaptureListItem from save response
function createCaptureFromResponse(result: SaveCaptureResponse): CaptureListItem {
  return {
    id: result.id,
    created_at: result.project.created_at,
    updated_at: result.project.updated_at,
    capture_type: result.project.capture_type,
    dimensions: result.project.dimensions,
    thumbnail_path: result.thumbnail_path,
    image_path: result.image_path,
    has_annotations: result.project.annotations.length > 0,
    tags: result.project.tags,
    favorite: result.project.favorite,
    is_missing: false,
  };
}

/**
 * Main store for capture/project management.
 * Handles library listing, project loading, saving, and metadata updates.
 * Uses localStorage caching for instant library display on app start.
 *
 * @example
 * ```tsx
 * const { captures, loadCaptures, loadProject } = useCaptureStore();
 *
 * // Load library on mount
 * useEffect(() => { loadCaptures(); }, []);
 *
 * // Open a project in editor
 * loadProject(captureId);
 * ```
 */
export const useCaptureStore = create<CaptureState>((set, get) => ({
  captures: [],
  loading: false,
  initialized: false,
  error: null,
  isFromCache: false,
  isCacheStale: false,
  isRefreshing: false,
  currentProject: null,
  currentImageData: null,
  hasUnsavedChanges: false,
  loadingProjectId: null,
  skipStagger: false,
  searchQuery: '',
  filterFavorites: false,
  filterTags: [],
  view: 'library',

  loadCaptures: async () => {
    const hasExistingCaptures = get().captures.length > 0;
    const isFirstLoad = !hasExistingCaptures;

    // On first load, try to show cached data immediately
    if (isFirstLoad) {
      const cached = loadFromCache();
      if (cached && cached.captures.length > 0) {
        // Show cached data immediately, mark as from cache
        set({
          captures: cached.captures,
          loading: false,
          initialized: true,
          isFromCache: true,
          isCacheStale: isCacheStale(cached.timestamp),
          isRefreshing: true, // We'll refresh in background
        });
      } else {
        // No cache, show loading spinner
        set({ loading: true, error: null });
      }
    } else {
      // Not first load (e.g., returning from editor), just refresh in background
      set({ isRefreshing: true });
    }

    try {
      const captures = await invoke<CaptureListItem[]>('get_capture_list');
      // Preserve any pending temp captures (optimistic updates in progress)
      const pendingCaptures = get().captures.filter(c => c.id.startsWith('temp_'));
      const allCaptures = [...pendingCaptures, ...captures];

      set({
        captures: allCaptures,
        loading: false,
        initialized: true,
        isFromCache: false,
        isCacheStale: false,
        isRefreshing: false,
      });

      // Update cache with fresh data
      saveToCache(allCaptures);
    } catch (error) {
      // On error, keep showing cached data if available
      const { isFromCache } = get();
      set({
        error: String(error),
        loading: false,
        initialized: true,
        isRefreshing: false,
        // If we were showing cache, keep it but mark as stale
        isCacheStale: isFromCache ? true : get().isCacheStale,
      });
    }
  },

  loadProject: async (id: string) => {
    // Immediately switch to editor view for snappy feel - show loading in editor
    set({ loadingProjectId: id, error: null, view: 'editor' });
    try {
      const [project, imageData] = await Promise.all([
        invoke<CaptureProject>('get_project', { projectId: id }),
        invoke<string>('get_project_image', { projectId: id }),
      ]);
      set({
        currentProject: project,
        currentImageData: imageData,
        hasUnsavedChanges: false,
        loadingProjectId: null,
      });
    } catch (error) {
      // On error, go back to library
      set({ error: String(error), loadingProjectId: null, view: 'library' });
    }
  },

  saveNewCapture: async (
    imageData: string,
    captureType: string,
    source: CaptureSource,
    options?: { silent?: boolean }
  ) => {
    const tempId = `temp_${Date.now()}`;
    const now = new Date().toISOString();
    const placeholderCapture = createPlaceholderCapture(tempId, now, captureType);

    // Optimistically add to list immediately so card appears right away
    set({ captures: [placeholderCapture, ...get().captures] });

    try {
      const result = await invoke<SaveCaptureResponse>('save_capture', {
        request: {
          image_data: imageData,
          capture_type: captureType,
          source,
        },
      });

      // Replace placeholder with real capture data
      const realCapture = createCaptureFromResponse(result);
      const updatedCaptures = get().captures.map(c => c.id === tempId ? realCapture : c);
      set({ captures: updatedCaptures });

      // Update cache with new capture
      saveToCache(updatedCaptures);

      // Set as current project (unless silent mode - used for background saves)
      if (!options?.silent) {
        set({
          currentProject: result.project,
          currentImageData: imageData,
          hasUnsavedChanges: false,
          view: 'editor',
        });
      } else {
        // Silent mode: only update project metadata, don't touch imageData
        set({
          currentProject: result.project,
          hasUnsavedChanges: false,
        });
      }

      return result.id;
    } catch (error) {
      // Remove placeholder on error
      set({
        captures: get().captures.filter(c => c.id !== tempId),
        error: String(error)
      });
      throw error;
    }
  },

  // Fast save directly from RGBA file - skips base64 encoding/decoding
  saveNewCaptureFromFile: async (
    filePath: string,
    width: number,
    height: number,
    captureType: string,
    source: CaptureSource,
    options?: { silent?: boolean }
  ) => {
    const tempId = `temp_${Date.now()}`;
    const now = new Date().toISOString();
    const placeholderCapture = createPlaceholderCapture(tempId, now, captureType, { width, height });

    // Optimistically add to list immediately
    set({ captures: [placeholderCapture, ...get().captures] });

    try {
      const result = await invoke<SaveCaptureResponse>('save_capture_from_file', {
        filePath,
        width,
        height,
        captureType,
        source,
      });

      // Replace placeholder with real capture data
      const realCapture = createCaptureFromResponse(result);
      const updatedCaptures = get().captures.map(c => c.id === tempId ? realCapture : c);
      set({ captures: updatedCaptures });

      // Update cache with new capture
      saveToCache(updatedCaptures);

      if (!options?.silent) {
        set({
          currentProject: result.project,
          hasUnsavedChanges: false,
          view: 'editor',
        });
      } else {
        set({
          currentProject: result.project,
          hasUnsavedChanges: false,
        });
      }

      return result.id;
    } catch (error) {
      // Remove placeholder on error
      set({
        captures: get().captures.filter(c => c.id !== tempId),
        error: String(error)
      });
      throw error;
    }
  },

  updateAnnotations: async (annotations: Annotation[]) => {
    const { currentProject } = get();
    if (!currentProject) return;

    try {
      const updated = await invoke<CaptureProject>('update_project_annotations', {
        projectId: currentProject.id,
        annotations,
      });
      set({ currentProject: updated, hasUnsavedChanges: false });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  toggleFavorite: async (id: string) => {
    const captures = get().captures;
    const captureIndex = captures.findIndex((c) => c.id === id);
    if (captureIndex === -1) return;

    const capture = captures[captureIndex];
    const newFavorite = !capture.favorite;

    // Optimistically update local state first
    const updatedCaptures = [...captures];
    updatedCaptures[captureIndex] = { ...capture, favorite: newFavorite };
    set({ captures: updatedCaptures });

    try {
      await invoke('update_project_metadata', {
        projectId: id,
        favorite: newFavorite,
      });
      // Update cache on success
      saveToCache(updatedCaptures);
    } catch (error) {
      // Revert on error
      set({ captures, error: String(error) });
    }
  },

  updateTags: async (id: string, tags: string[]) => {
    const captures = get().captures;
    const captureIndex = captures.findIndex((c) => c.id === id);
    if (captureIndex === -1) return;

    const capture = captures[captureIndex];

    // Optimistically update local state first
    const updatedCaptures = [...captures];
    updatedCaptures[captureIndex] = { ...capture, tags };
    set({ captures: updatedCaptures });

    try {
      await invoke('update_project_metadata', {
        projectId: id,
        tags,
      });
      // Update cache on success
      saveToCache(updatedCaptures);
    } catch (error) {
      // Revert on error
      set({ captures, error: String(error) });
    }
  },

  bulkAddTags: async (ids: string[], tagsToAdd: string[]) => {
    if (ids.length === 0 || tagsToAdd.length === 0) return;

    const captures = get().captures;
    const updatedCaptures = [...captures];

    // Optimistically update all selected captures
    for (const id of ids) {
      const captureIndex = updatedCaptures.findIndex((c) => c.id === id);
      if (captureIndex === -1) continue;

      const capture = updatedCaptures[captureIndex];
      // Merge tags, avoiding duplicates
      const newTags = [...new Set([...capture.tags, ...tagsToAdd])];
      updatedCaptures[captureIndex] = { ...capture, tags: newTags };
    }

    set({ captures: updatedCaptures });

    // Update all captures in parallel
    try {
      await Promise.all(
        ids.map(async (id) => {
          const capture = updatedCaptures.find((c) => c.id === id);
          if (!capture) return;
          await invoke('update_project_metadata', {
            projectId: id,
            tags: capture.tags,
          });
        })
      );
      // Update cache on success
      saveToCache(updatedCaptures);
    } catch (error) {
      // Revert on error
      set({ captures, error: String(error) });
    }
  },

  deleteCapture: async (id: string) => {
    try {
      await invoke('delete_project', { projectId: id });
      await get().loadCaptures();

      // Clear current if it was deleted
      if (get().currentProject?.id === id) {
        set({ currentProject: null, currentImageData: null, view: 'library' });
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  deleteCaptures: async (ids: string[]) => {
    try {
      await invoke('delete_projects', { projectIds: ids });
      await get().loadCaptures();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  getStorageStats: async () => {
    return invoke<StorageStats>('get_storage_stats');
  },

  setSearchQuery: (query: string) => set({ searchQuery: query }),
  setFilterFavorites: (value: boolean) => set({ filterFavorites: value }),
  setFilterTags: (tags: string[]) => set({ filterTags: tags }),
  setSkipStagger: (value: boolean) => set({ skipStagger: value }),
  clearCurrentProject: () =>
    set({
      currentProject: null,
      currentImageData: null,
      hasUnsavedChanges: false,
      view: 'library',
    }),
  setHasUnsavedChanges: (value: boolean) => set({ hasUnsavedChanges: value }),
  setView: (view: 'library' | 'editor') => set({ view }),
  setCurrentImageData: (data: string | null) => set({ currentImageData: data }),
  setCurrentProject: (project: CaptureProject | null) => set({ currentProject: project }),
}));

/**
 * Memoized selector for filtered captures based on search, favorites, and tags.
 * Optimized with early-exit and Set-based lookups for performance.
 *
 * @returns Filtered array of captures matching current filter criteria
 */
export const useFilteredCaptures = () => {
  // Use individual selectors to minimize re-renders
  const captures = useCaptureStore((state) => state.captures);
  const searchQuery = useCaptureStore((state) => state.searchQuery);
  const filterFavorites = useCaptureStore((state) => state.filterFavorites);
  const filterTags = useCaptureStore((state) => state.filterTags);

  return useMemo(() => {
    // Early exit if no filters active - return original array reference
    if (!filterFavorites && filterTags.length === 0 && !searchQuery) {
      return captures;
    }

    // Pre-compute filter tag set for O(1) lookups instead of O(n) array.includes
    const filterTagSet = filterTags.length > 0 ? new Set(filterTags) : null;
    const queryLower = searchQuery ? searchQuery.toLowerCase() : null;

    return captures.filter((capture) => {
      // Check favorites filter first (fastest check)
      if (filterFavorites && !capture.favorite) return false;

      // Check tags with Set lookup (O(1) per tag instead of O(n))
      if (filterTagSet) {
        const hasMatchingTag = capture.tags.some((tag) => filterTagSet.has(tag));
        if (!hasMatchingTag) return false;
      }

      // Check search query last (most expensive)
      if (queryLower) {
        const matchesType = capture.capture_type.toLowerCase().includes(queryLower);
        if (matchesType) return true;

        const matchesTags = capture.tags.some((tag) =>
          tag.toLowerCase().includes(queryLower)
        );
        if (!matchesTags) return false;
      }

      return true;
    });
  }, [captures, searchQuery, filterFavorites, filterTags]);
};

/**
 * Memoized selector for all unique tags across all captures.
 * Useful for tag autocomplete and filter dropdowns.
 *
 * @returns Sorted array of unique tag strings
 */
export const useAllTags = () => {
  const captures = useCaptureStore((state) => state.captures);

  return useMemo(() => {
    const allTags = new Set<string>();
    for (const capture of captures) {
      for (const tag of capture.tags) {
        allTags.add(tag);
      }
    }
    return Array.from(allTags).sort((a, b) => a.localeCompare(b));
  }, [captures]);
};
