import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  CaptureListItem,
  CaptureProject,
  StorageStats,
  Annotation,
  CaptureSource,
  SaveCaptureResponse,
} from '../types';

interface CaptureState {
  // Library state
  captures: CaptureListItem[];
  loading: boolean;
  error: string | null;

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

export const useCaptureStore = create<CaptureState>((set, get) => ({
  captures: [],
  loading: false,
  error: null,
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
    set({ loading: true, error: null });
    try {
      const captures = await invoke<CaptureListItem[]>('get_capture_list');
      // Preserve any pending temp captures (optimistic updates in progress)
      const pendingCaptures = get().captures.filter(c => c.id.startsWith('temp_'));
      set({ captures: [...pendingCaptures, ...captures], loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
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
      set({
        captures: get().captures.map(c => c.id === tempId ? realCapture : c),
      });

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
      set({
        captures: get().captures.map(c => c.id === tempId ? realCapture : c),
      });

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
    } catch (error) {
      // Revert on error
      set({ captures, error: String(error) });
    }
  },

  updateTags: async (id: string, tags: string[]) => {
    try {
      await invoke('update_project_metadata', {
        projectId: id,
        tags,
      });
      await get().loadCaptures();
    } catch (error) {
      set({ error: String(error) });
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

// Selector for filtered captures
export const useFilteredCaptures = () => {
  const { captures, searchQuery, filterFavorites, filterTags } = useCaptureStore();

  return captures.filter((capture) => {
    if (filterFavorites && !capture.favorite) return false;

    if (filterTags.length > 0) {
      const hasMatchingTag = filterTags.some((tag) => capture.tags.includes(tag));
      if (!hasMatchingTag) return false;
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesType = capture.capture_type.toLowerCase().includes(query);
      const matchesTags = capture.tags.some((tag) =>
        tag.toLowerCase().includes(query)
      );
      if (!matchesType && !matchesTags) return false;
    }

    return true;
  });
};
