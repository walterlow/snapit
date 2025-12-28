import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { isToday, isYesterday, isThisWeek, isThisMonth, isThisYear, format, formatDistanceToNow } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCaptureStore, useFilteredCaptures, useAllTags } from '../../stores/captureStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVideoRecordingStore } from '../../stores/videoRecordingStore';
import { useCaptureSettingsStore } from '../../stores/captureSettingsStore';
import type { CaptureListItem, MonitorInfo, FastCaptureResult, ScreenRegionSelection, RecordingFormat } from '../../types';

import { useMarqueeSelection, useDragDropImport, useMomentumScroll, useResizeTransitionLock, type VirtualLayoutInfo } from './hooks';
import {
  DateHeader,
  EmptyState,
  DropZoneOverlay,
  CaptureCard,
  CaptureRow,
  GlassBlobToolbar,
  DeleteDialog,
} from './components';
import { VirtualizedGrid } from './VirtualizedGrid';

type ViewMode = 'grid' | 'list';

// Layout constants for virtual grid (must match VirtualizedGrid.tsx exactly!)
const HEADER_HEIGHT = 56;
const GRID_GAP = 20;
const MIN_CARD_WIDTH = 240;
const CONTAINER_PADDING = 64;
const CARD_ROW_HEIGHT = 280; // Must match VirtualizedGrid constant
const LIST_ROW_HEIGHT = 88;  // Must match VirtualizedGrid constant
// VirtualizedGrid positioning offsets (from `top: virtualRow.start + 32` and `px-8`)
const CONTENT_OFFSET_Y = 32; // vertical offset from inline positioning style
const CONTENT_OFFSET_X = 32; // horizontal padding (px-8) on virtual items

interface DateGroup {
  label: string;
  captures: CaptureListItem[];
}

// Group captures by date periods
function groupCapturesByDate(captures: CaptureListItem[]): DateGroup[] {
  const groups: Map<string, CaptureListItem[]> = new Map();
  const groupOrder: string[] = [];

  // Sort captures by created_at descending first
  const sorted = [...captures].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  for (const capture of sorted) {
    const date = new Date(capture.created_at);
    let label: string;

    if (isToday(date)) {
      label = 'Today';
    } else if (isYesterday(date)) {
      label = 'Yesterday';
    } else if (isThisWeek(date, { weekStartsOn: 1 })) {
      label = 'This Week';
    } else if (isThisMonth(date)) {
      label = 'This Month';
    } else if (isThisYear(date)) {
      label = format(date, 'MMMM');
    } else {
      label = format(date, 'MMMM yyyy');
    }

    if (!groups.has(label)) {
      groups.set(label, []);
      groupOrder.push(label);
    }
    groups.get(label)!.push(capture);
  }

  return groupOrder.map((label) => ({
    label,
    captures: groups.get(label)!,
  }));
}

export const CaptureLibrary: React.FC = () => {
  const {
    loading,
    loadingProjectId,
    loadCaptures,
    loadProject,
    deleteCapture,
    deleteCaptures,
    toggleFavorite,
    updateTags,
    searchQuery,
    setSearchQuery,
    filterFavorites,
    setFilterFavorites,
    filterTags,
    setFilterTags,
  } = useCaptureStore();

  const { settings, openSettingsModal } = useSettingsStore();

  const captures = useFilteredCaptures();
  const allTags = useAllTags();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Use virtualization for large libraries (100+ captures)
  const useVirtualization = captures.length > 100;

  // Track container width for virtual layout calculations (debounced for performance)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !useVirtualization) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    const resizeObserver = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(updateWidth, 150);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [useVirtualization]);

  // Compute date groups
  const dateGroups = useMemo(() => groupCapturesByDate(captures), [captures]);

  // Compute virtual layout info for marquee selection
  const virtualLayout = useMemo<VirtualLayoutInfo | undefined>(() => {
    if (!useVirtualization || containerWidth === 0) return undefined;

    const availableWidth = containerWidth - CONTAINER_PADDING;
    const cardsPerRow = Math.max(1, Math.floor((availableWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
    const totalGaps = GRID_GAP * (cardsPerRow - 1);
    const cardWidth = (availableWidth - totalGaps) / cardsPerRow;

    return {
      viewMode,
      cardsPerRow,
      gridRowHeight: CARD_ROW_HEIGHT, // Use constant to match VirtualizedGrid
      listRowHeight: LIST_ROW_HEIGHT,
      cardWidth: viewMode === 'list' ? availableWidth : cardWidth,
      headerHeight: HEADER_HEIGHT,
      gridGap: GRID_GAP,
      contentOffsetY: CONTENT_OFFSET_Y,
      contentOffsetX: CONTENT_OFFSET_X,
      dateGroups,
    };
  }, [useVirtualization, containerWidth, dateGroups, viewMode]);

  // Delete confirmation state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

  // Selection hook
  const {
    selectedIds,
    setSelectedIds,
    isSelecting,
    selectionRect,
    handleMarqueeMouseDown,
    handleMarqueeMouseMove,
    handleMarqueeMouseUp,
    handleSelect,
    handleOpen,
    clearSelection,
  } = useMarqueeSelection({
    captures,
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
    onOpenProject: loadProject,
    virtualLayout,
  });

  // Drag & drop hook (uses Tauri's native drag-drop events)
  const { isDragOver } = useDragDropImport({
    onImportComplete: loadCaptures,
  });

  // Momentum scroll for smooth acceleration (disabled during marquee selection)
  useMomentumScroll(containerRef, { disabled: isSelecting });

  // Disable transitions during window resize for smoother performance
  useResizeTransitionLock();

  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  const handleNewImage = async () => {
    try {
      // Set active mode so toolbar shows correct mode
      const { setActiveMode } = useCaptureSettingsStore.getState();
      setActiveMode('screenshot');
      await invoke('show_overlay', { captureType: 'screenshot' });
    } catch (error) {
      console.error('Failed to start capture:', error);
      toast.error('Failed to start capture');
    }
  };

  // Start video/gif recording using native overlay (avoids video blackout)
  // The capture toolbar handles both selection and recording controls
  const startVideoRecording = async (format: RecordingFormat) => {
    try {
      // Set format in store before triggering capture
      // The trigger_capture flow will use this format
      const { setFormat } = useVideoRecordingStore.getState();
      setFormat(format);

      // Set active mode in capture settings store so toolbar shows correct mode
      const { setActiveMode } = useCaptureSettingsStore.getState();
      setActiveMode(format === 'gif' ? 'gif' : 'video');

      // Use show_overlay which routes to trigger_capture
      // For video/gif, this shows the DirectComposition overlay with the unified toolbar
      // The toolbar handles: selection confirmation, recording start, pause/resume, stop
      // Recording is started automatically when user clicks Record in the toolbar
      await invoke('show_overlay', { captureType: format === 'gif' ? 'gif' : 'video' });
    } catch (error) {
      console.error('Failed to start video recording:', error);
      toast.error('Failed to start capture');
    }
  };

  const handleNewVideo = async () => {
    await startVideoRecording('mp4');
  };

  const handleNewGif = async () => {
    await startVideoRecording('gif');
  };

  const handleAllMonitorsCapture = async () => {
    try {
      const monitors = await invoke<MonitorInfo[]>('get_monitors');
      if (monitors.length === 0) {
        toast.error('No monitors found');
        return;
      }

      // Calculate bounding box of all monitors
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const mon of monitors) {
        minX = Math.min(minX, mon.x);
        minY = Math.min(minY, mon.y);
        maxX = Math.max(maxX, mon.x + mon.width);
        maxY = Math.max(maxY, mon.y + mon.height);
      }

      const selection: ScreenRegionSelection = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };

      const result = await invoke<FastCaptureResult>('capture_screen_region_fast', { selection });
      await invoke('open_editor_fast', {
        filePath: result.file_path,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      console.error('Failed to capture all monitors:', error);
      toast.error('Failed to capture all monitors');
    }
  };

  const handleOpenLibraryFolder = async () => {
    try {
      // Use cached settings from store instead of re-reading from disk
      const libraryPath = settings.general.defaultSaveDir;
      if (!libraryPath) {
        toast.error('No save directory configured');
        return;
      }
      await invoke('open_path_in_explorer', { path: libraryPath });
    } catch (error) {
      console.error('Failed to open library folder:', error);
      toast.error('Failed to open library folder');
    }
  };

  // Delete handlers
  const handleRequestDeleteSingle = useCallback((id: string) => {
    setPendingDeleteId(id);
    setPendingBulkDelete(false);
    setDeleteDialogOpen(true);
  }, []);

  const handleRequestDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    setPendingDeleteId(null);
    setPendingBulkDelete(true);
    setDeleteDialogOpen(true);
  }, [selectedIds.size]);

  // Keyboard shortcut for deleting selected captures
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input field
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Delete or Backspace to delete selected captures
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        handleRequestDeleteSelected();
      }

      // Escape to clear selection
      if (e.key === 'Escape' && selectedIds.size > 0) {
        e.preventDefault();
        clearSelection();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds.size, handleRequestDeleteSelected, clearSelection]);

  const handleConfirmDelete = async () => {
    try {
      if (pendingBulkDelete) {
        await deleteCaptures(Array.from(selectedIds));
        setSelectedIds(new Set());
        toast.success(`Deleted ${selectedIds.size} capture${selectedIds.size > 1 ? 's' : ''}`);
      } else if (pendingDeleteId) {
        await deleteCapture(pendingDeleteId);
        toast.success('Capture deleted');
      }
    } catch (error) {
      console.error('Failed to delete:', error);
      toast.error('Failed to delete capture');
    }
    setDeleteDialogOpen(false);
    setPendingDeleteId(null);
    setPendingBulkDelete(false);
  };

  const handleCancelDelete = () => {
    setDeleteDialogOpen(false);
    setPendingDeleteId(null);
    setPendingBulkDelete(false);
  };

  const handleOpenInFolder = useCallback(async (capture: CaptureListItem) => {
    try {
      await invoke('reveal_file_in_explorer', { path: capture.image_path });
    } catch (error) {
      console.error('Failed to open in folder:', error);
      toast.error('Failed to open file location');
    }
  }, []);

  const handleCopyToClipboard = useCallback(async (capture: CaptureListItem) => {
    try {
      await invoke('copy_image_to_clipboard', { path: capture.image_path });
      toast.success('Copied to clipboard');
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      toast.error('Failed to copy to clipboard');
    }
  }, []);

  const handlePlayMedia = useCallback(async (capture: CaptureListItem) => {
    try {
      await invoke('open_file_with_default_app', { path: capture.image_path });
    } catch (error) {
      console.error('Failed to play media:', error);
      toast.error('Failed to open file');
    }
  }, []);

  const getDeleteCount = () => {
    if (pendingBulkDelete) return selectedIds.size;
    return pendingDeleteId ? 1 : 0;
  };

  const formatDate = (dateStr: string) => {
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
    } catch {
      return dateStr;
    }
  };

  const renderCaptureGrid = () => (
    <div className="space-y-0">
      {dateGroups.map((group, groupIndex) => (
        <div key={group.label}>
          <DateHeader label={group.label} count={group.captures.length} isFirst={groupIndex === 0} />
          <div className="capture-grid">
            {group.captures.map((capture) => (
              <CaptureCard
                key={capture.id}
                capture={capture}
                selected={selectedIds.has(capture.id)}
                isLoading={loadingProjectId === capture.id}
                allTags={allTags}
                onSelect={handleSelect}
                onOpen={handleOpen}
                onToggleFavorite={() => toggleFavorite(capture.id)}
                onUpdateTags={(tags) => updateTags(capture.id, tags)}
                onDelete={() => handleRequestDeleteSingle(capture.id)}
                onOpenInFolder={() => handleOpenInFolder(capture)}
                onCopyToClipboard={() => handleCopyToClipboard(capture)}
                onPlayMedia={() => handlePlayMedia(capture)}
                formatDate={formatDate}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const renderCaptureList = () => (
    <div className="space-y-0">
      {dateGroups.map((group, groupIndex) => (
        <div key={group.label}>
          <DateHeader label={group.label} count={group.captures.length} isFirst={groupIndex === 0} />
          <div className="flex flex-col gap-2">
            {group.captures.map((capture) => (
              <CaptureRow
                key={capture.id}
                capture={capture}
                selected={selectedIds.has(capture.id)}
                isLoading={loadingProjectId === capture.id}
                allTags={allTags}
                onSelect={handleSelect}
                onOpen={handleOpen}
                onToggleFavorite={() => toggleFavorite(capture.id)}
                onUpdateTags={(tags) => updateTags(capture.id, tags)}
                onDelete={() => handleRequestDeleteSingle(capture.id)}
                onOpenInFolder={() => handleOpenInFolder(capture)}
                onCopyToClipboard={() => handleCopyToClipboard(capture)}
                onPlayMedia={() => handlePlayMedia(capture)}
                formatDate={formatDate}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <div className="flex flex-col h-full bg-[var(--polar-snow)] relative">
        {/* Drop Zone Overlay */}
        {isDragOver && <DropZoneOverlay />}

        {/* Content - use virtualization for large libraries, regular rendering for small ones */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-12 h-12 text-[var(--coral-400)] animate-spin" />
          </div>
        ) : captures.length === 0 ? (
          <div className="flex-1 overflow-auto p-8 pb-32">
            <EmptyState onNewCapture={handleNewImage} />
          </div>
        ) : useVirtualization ? (
          /* Virtualized rendering for large libraries (100+ captures) */
          <VirtualizedGrid
            dateGroups={dateGroups}
            viewMode={viewMode}
            selectedIds={selectedIds}
            loadingProjectId={loadingProjectId}
            allTags={allTags}
            onSelect={handleSelect}
            onOpen={handleOpen}
            onToggleFavorite={toggleFavorite}
            onUpdateTags={updateTags}
            onDelete={handleRequestDeleteSingle}
            onOpenInFolder={handleOpenInFolder}
            onCopyToClipboard={handleCopyToClipboard}
            onPlayMedia={handlePlayMedia}
            formatDate={formatDate}
            containerRef={containerRef as React.RefObject<HTMLDivElement>}
            onMouseDown={handleMarqueeMouseDown}
            onMouseMove={handleMarqueeMouseMove}
            onMouseUp={handleMarqueeMouseUp}
            isSelecting={isSelecting}
            selectionRect={selectionRect}
          />
        ) : (
          /* Non-virtualized rendering with marquee selection for smaller libraries */
          <div
            ref={containerRef}
            className="flex-1 overflow-auto p-8 pb-32 relative select-none library-scroll"
            onMouseDown={handleMarqueeMouseDown}
            onMouseMove={handleMarqueeMouseMove}
            onMouseUp={handleMarqueeMouseUp}
          >
            {/* Marquee Selection Rectangle */}
            {isSelecting && (
              <div
                className="absolute pointer-events-none z-50 border-2 border-[var(--coral-400)] bg-[var(--coral-glow)] rounded-sm"
                style={{
                  left: selectionRect.left,
                  top: selectionRect.top,
                  width: selectionRect.width,
                  height: selectionRect.height,
                }}
              />
            )}
            {viewMode === 'grid' ? renderCaptureGrid() : renderCaptureList()}
          </div>
        )}

        {/* Delete Confirmation Dialog */}
        <DeleteDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          count={getDeleteCount()}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />

        {/* Floating Bottom Toolbar */}
        <GlassBlobToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          filterFavorites={filterFavorites}
          onFilterFavoritesChange={setFilterFavorites}
          filterTags={filterTags}
          onFilterTagsChange={setFilterTags}
          allTags={allTags}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selectedCount={selectedIds.size}
          onDeleteSelected={handleRequestDeleteSelected}
          onClearSelection={clearSelection}
          onOpenLibraryFolder={handleOpenLibraryFolder}
          onAllMonitorsCapture={handleAllMonitorsCapture}
          onNewImage={handleNewImage}
          onNewVideo={handleNewVideo}
          onNewGif={handleNewGif}
          onOpenSettings={openSettingsModal}
        />
      </div>
    </TooltipProvider>
  );
};
