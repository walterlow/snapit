import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { useCaptureStore, useFilteredCaptures, useAllTags } from './captureStore';
import type { CaptureListItem, SaveCaptureResponse, CaptureProject } from '../types';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Helper to create test capture
function createTestCapture(overrides: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    id: `capture_${Date.now()}_${Math.random()}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    capture_type: 'screenshot',
    dimensions: { width: 1920, height: 1080 },
    thumbnail_path: '/path/to/thumb.png',
    image_path: '/path/to/image.png',
    has_annotations: false,
    tags: [],
    favorite: false,
    is_missing: false,
    ...overrides,
  };
}

// Helper to create save response
function createSaveResponse(capture: CaptureListItem): SaveCaptureResponse {
  return {
    id: capture.id,
    image_path: capture.image_path,
    thumbnail_path: capture.thumbnail_path,
    project: {
      id: capture.id,
      created_at: capture.created_at,
      updated_at: capture.updated_at,
      capture_type: 'region' as const,
      dimensions: capture.dimensions,
      source: { monitor: 0 },
      original_image: 'base64_image_data',
      annotations: [],
      tags: capture.tags,
      favorite: capture.favorite,
    },
  };
}

describe('captureStore', () => {
  beforeEach(() => {
    // Reset store
    useCaptureStore.setState({
      captures: [],
      loading: false,
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
    });

    // Clear mocks
    mockInvoke.mockReset();

    // Clear localStorage
    localStorage.clear();
  });

  describe('loadCaptures', () => {
    it('should load captures from backend', async () => {
      const captures = [createTestCapture(), createTestCapture()];
      mockInvoke.mockResolvedValue(captures);

      await useCaptureStore.getState().loadCaptures();

      expect(mockInvoke).toHaveBeenCalledWith('get_capture_list');
      expect(useCaptureStore.getState().captures).toHaveLength(2);
      expect(useCaptureStore.getState().loading).toBe(false);
    });

    it('should show cached data immediately on first load', async () => {
      // Setup cache
      const cachedCaptures = [createTestCapture({ id: 'cached1' })];
      localStorage.setItem('snapit_library_cache', JSON.stringify(cachedCaptures));
      localStorage.setItem('snapit_library_cache_timestamp', Date.now().toString());

      // Backend returns different data
      const freshCaptures = [createTestCapture({ id: 'fresh1' })];
      mockInvoke.mockResolvedValue(freshCaptures);

      // Start loading
      const loadPromise = useCaptureStore.getState().loadCaptures();

      // Should immediately show cached data
      expect(useCaptureStore.getState().captures).toHaveLength(1);
      expect(useCaptureStore.getState().captures[0].id).toBe('cached1');
      expect(useCaptureStore.getState().isFromCache).toBe(true);

      // Wait for fresh data
      await loadPromise;

      // Should now have fresh data
      expect(useCaptureStore.getState().captures[0].id).toBe('fresh1');
      expect(useCaptureStore.getState().isFromCache).toBe(false);
    });

    it('should mark stale cache', async () => {
      // Setup old cache (6 minutes ago)
      const cachedCaptures = [createTestCapture()];
      const oldTimestamp = Date.now() - 6 * 60 * 1000;
      localStorage.setItem('snapit_library_cache', JSON.stringify(cachedCaptures));
      localStorage.setItem('snapit_library_cache_timestamp', oldTimestamp.toString());

      mockInvoke.mockResolvedValue([]);

      const loadPromise = useCaptureStore.getState().loadCaptures();

      // Should show cache as stale
      expect(useCaptureStore.getState().isCacheStale).toBe(true);

      await loadPromise;
    });

    it('should preserve temp captures during refresh', async () => {
      // Set up with a temp capture (optimistic update in progress)
      useCaptureStore.setState({
        captures: [createTestCapture({ id: 'temp_123' })],
      });

      const freshCaptures = [createTestCapture({ id: 'fresh1' })];
      mockInvoke.mockResolvedValue(freshCaptures);

      await useCaptureStore.getState().loadCaptures();

      const captures = useCaptureStore.getState().captures;
      expect(captures.some(c => c.id === 'temp_123')).toBe(true);
      expect(captures.some(c => c.id === 'fresh1')).toBe(true);
    });

    it('should handle load error gracefully', async () => {
      mockInvoke.mockRejectedValue(new Error('Network error'));

      await useCaptureStore.getState().loadCaptures();

      expect(useCaptureStore.getState().error).toContain('Network error');
      expect(useCaptureStore.getState().loading).toBe(false);
    });
  });

  describe('optimistic updates', () => {
    it('should toggle favorite optimistically', async () => {
      const capture = createTestCapture({ id: 'cap1', favorite: false });
      useCaptureStore.setState({ captures: [capture] });
      mockInvoke.mockResolvedValue(undefined);

      const togglePromise = useCaptureStore.getState().toggleFavorite('cap1');

      // Should update immediately
      expect(useCaptureStore.getState().captures[0].favorite).toBe(true);

      await togglePromise;
      expect(mockInvoke).toHaveBeenCalledWith('update_project_metadata', {
        projectId: 'cap1',
        favorite: true,
      });
    });

    it('should revert favorite on error', async () => {
      const capture = createTestCapture({ id: 'cap1', favorite: false });
      useCaptureStore.setState({ captures: [capture] });
      mockInvoke.mockRejectedValue(new Error('Failed'));

      await useCaptureStore.getState().toggleFavorite('cap1');

      // Should revert to original
      expect(useCaptureStore.getState().captures[0].favorite).toBe(false);
      expect(useCaptureStore.getState().error).toContain('Failed');
    });

    it('should update tags optimistically', async () => {
      const capture = createTestCapture({ id: 'cap1', tags: ['old'] });
      useCaptureStore.setState({ captures: [capture] });
      mockInvoke.mockResolvedValue(undefined);

      const newTags = ['new1', 'new2'];
      const updatePromise = useCaptureStore.getState().updateTags('cap1', newTags);

      // Should update immediately
      expect(useCaptureStore.getState().captures[0].tags).toEqual(newTags);

      await updatePromise;
    });

    it('should bulk add tags optimistically', async () => {
      const captures = [
        createTestCapture({ id: 'cap1', tags: ['existing'] }),
        createTestCapture({ id: 'cap2', tags: [] }),
      ];
      useCaptureStore.setState({ captures });
      mockInvoke.mockResolvedValue(undefined);

      await useCaptureStore.getState().bulkAddTags(['cap1', 'cap2'], ['new']);

      const updated = useCaptureStore.getState().captures;
      expect(updated[0].tags).toContain('existing');
      expect(updated[0].tags).toContain('new');
      expect(updated[1].tags).toContain('new');
    });
  });

  describe('filters', () => {
    it('should filter by search query', () => {
      useCaptureStore.setState({
        captures: [
          createTestCapture({ capture_type: 'screenshot', tags: [] }),
          createTestCapture({ capture_type: 'video', tags: ['work'] }),
        ],
        searchQuery: 'video',
      });

      // Can't easily test useFilteredCaptures hook outside React
      // This tests the store state is set correctly
      expect(useCaptureStore.getState().searchQuery).toBe('video');
    });

    it('should set filter favorites', () => {
      useCaptureStore.getState().setFilterFavorites(true);
      expect(useCaptureStore.getState().filterFavorites).toBe(true);
    });

    it('should set filter tags', () => {
      useCaptureStore.getState().setFilterTags(['work', 'important']);
      expect(useCaptureStore.getState().filterTags).toEqual(['work', 'important']);
    });
  });

  describe('view management', () => {
    it('should switch between library and editor view', () => {
      expect(useCaptureStore.getState().view).toBe('library');

      useCaptureStore.getState().setView('editor');
      expect(useCaptureStore.getState().view).toBe('editor');
    });

    it('should clear current project and return to library', () => {
      useCaptureStore.setState({
        currentProject: {} as CaptureProject,
        currentImageData: 'base64...',
        hasUnsavedChanges: true,
        view: 'editor',
      });

      useCaptureStore.getState().clearCurrentProject();

      const state = useCaptureStore.getState();
      expect(state.currentProject).toBeNull();
      expect(state.currentImageData).toBeNull();
      expect(state.hasUnsavedChanges).toBe(false);
      expect(state.view).toBe('library');
    });
  });

  describe('cache updates', () => {
    it('should update cache after save', async () => {
      const newCapture = createTestCapture({ id: 'new1' });
      mockInvoke.mockResolvedValue(createSaveResponse(newCapture));

      await useCaptureStore.getState().saveNewCapture(
        'base64data',
        'screenshot',
        { monitor: 0 },
        { silent: true }
      );

      // Check localStorage was updated
      const cached = localStorage.getItem('snapit_library_cache');
      expect(cached).toBeTruthy();
      const parsedCache = JSON.parse(cached!);
      expect(parsedCache.some((c: CaptureListItem) => c.id === 'new1')).toBe(true);
    });

    it('should update cache after toggle favorite', async () => {
      const capture = createTestCapture({ id: 'cap1', favorite: false });
      useCaptureStore.setState({ captures: [capture] });
      mockInvoke.mockResolvedValue(undefined);

      await useCaptureStore.getState().toggleFavorite('cap1');

      const cached = localStorage.getItem('snapit_library_cache');
      const parsedCache = JSON.parse(cached!);
      expect(parsedCache[0].favorite).toBe(true);
    });
  });

  describe('loading states', () => {
    it('should track loading project id', async () => {
      const capture = createTestCapture({ id: 'cap1' });
      const project = { id: 'cap1' } as CaptureProject;

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project') return Promise.resolve(project);
        if (cmd === 'get_project_image') return Promise.resolve('base64...');
        return Promise.resolve();
      });

      const loadPromise = useCaptureStore.getState().loadProject('cap1');

      // Should immediately set loading state and switch view
      expect(useCaptureStore.getState().loadingProjectId).toBe('cap1');
      expect(useCaptureStore.getState().view).toBe('editor');

      await loadPromise;

      expect(useCaptureStore.getState().loadingProjectId).toBeNull();
    });

    it('should go back to library on load project error', async () => {
      mockInvoke.mockRejectedValue(new Error('Not found'));

      await useCaptureStore.getState().loadProject('nonexistent');

      expect(useCaptureStore.getState().view).toBe('library');
      expect(useCaptureStore.getState().error).toContain('Not found');
    });
  });
});
