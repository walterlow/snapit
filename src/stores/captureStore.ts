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
    source: CaptureSource
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
  clearCurrentProject: () => void;
  setHasUnsavedChanges: (value: boolean) => void;
  setView: (view: 'library' | 'editor') => void;
  setCurrentImageData: (data: string | null) => void;
  setCurrentProject: (project: CaptureProject | null) => void;
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  captures: [],
  loading: false,
  error: null,
  currentProject: null,
  currentImageData: null,
  hasUnsavedChanges: false,
  searchQuery: '',
  filterFavorites: false,
  filterTags: [],
  view: 'library',

  loadCaptures: async () => {
    set({ loading: true, error: null });
    try {
      const captures = await invoke<CaptureListItem[]>('get_capture_list');
      set({ captures, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  loadProject: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const [project, imageData] = await Promise.all([
        invoke<CaptureProject>('get_project', { projectId: id }),
        invoke<string>('get_project_image', { projectId: id }),
      ]);
      set({
        currentProject: project,
        currentImageData: imageData,
        hasUnsavedChanges: false,
        loading: false,
        view: 'editor',
      });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  saveNewCapture: async (
    imageData: string,
    captureType: string,
    source: CaptureSource
  ) => {
    try {
      const result = await invoke<SaveCaptureResponse>('save_capture', {
        request: {
          image_data: imageData,
          capture_type: captureType,
          source,
        },
      });

      // Reload captures list
      await get().loadCaptures();

      // Set as current project
      set({
        currentProject: result.project,
        currentImageData: imageData,
        hasUnsavedChanges: false,
        view: 'editor',
      });

      return result.id;
    } catch (error) {
      set({ error: String(error) });
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
