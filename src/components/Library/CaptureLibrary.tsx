import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { isToday, isYesterday, isThisWeek, isThisMonth, isThisYear, format, formatDistanceToNow } from 'date-fns';
import { reportError } from '../../utils/errorReporting';
import { Loader2 } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCaptureStore, useFilteredCaptures, useAllTags } from '../../stores/captureStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCaptureSettingsStore } from '../../stores/captureSettingsStore';
import { CaptureService } from '../../services/captureService';
import type { CaptureListItem } from '../../types';
import { LAYOUT, TIMING } from '../../constants';

import { useMarqueeSelection, useDragDropImport, useMomentumScroll, useResizeTransitionLock, type VirtualLayoutInfo } from './hooks';
// Direct imports avoid barrel file bundling overhead
import { DateHeader } from './components/DateHeader';
import { EmptyState } from './components/EmptyState';
import { DropZoneOverlay } from './components/DropZoneOverlay';
import { CaptureCard } from './components/CaptureCard';
import { CaptureRow } from './components/CaptureRow';
import { GlassBlobToolbar } from './components/GlassBlobToolbar';
import { DeleteDialog } from './components/DeleteDialog';
import { VirtualizedGrid, getColumnsForWidth, calculateRowHeight, getCardWidth, getGridWidth } from './VirtualizedGrid';

type ViewMode = 'grid' | 'list';

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
    initialized,
    loadingProjectId,
    loadCaptures,
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

  const { settings } = useSettingsStore();

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
      debounceTimer = setTimeout(updateWidth, TIMING.RESIZE_DEBOUNCE_MS);
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

    // Use the same breakpoint-based column calculation as VirtualizedGrid
    const cardsPerRow = viewMode === 'grid' ? getColumnsForWidth(containerWidth) : 1;
    const availableWidth = containerWidth - LAYOUT.CONTAINER_PADDING;

    // Use the same card width calculation as VirtualizedGrid (capped at MAX_CARD_WIDTH)
    const cardWidth = viewMode === 'grid'
      ? getCardWidth(containerWidth, cardsPerRow)
      : availableWidth;

    // Use dynamic row height calculation matching VirtualizedGrid
    const gridRowHeight = viewMode === 'grid'
      ? calculateRowHeight(containerWidth, cardsPerRow)
      : LAYOUT.LIST_ROW_HEIGHT;

    // Calculate grid width for centering calculations
    const gridWidth = viewMode === 'grid'
      ? getGridWidth(containerWidth, cardsPerRow)
      : availableWidth;

    return {
      viewMode,
      cardsPerRow,
      gridRowHeight,
      listRowHeight: LAYOUT.LIST_ROW_HEIGHT,
      cardWidth,
      headerHeight: LAYOUT.HEADER_HEIGHT,
      gridGap: LAYOUT.GRID_GAP,
      contentOffsetY: CONTENT_OFFSET_Y,
      contentOffsetX: CONTENT_OFFSET_X,
      gridWidth,
      containerWidth,
      dateGroups,
    };
  }, [useVirtualization, containerWidth, dateGroups, viewMode]);

  // Delete confirmation state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

  // Open image in dedicated editor window
  const handleEditImage = useCallback(async (capture: CaptureListItem) => {
    try {
      // Open image in a dedicated floating window
      // If the image is already open, the existing window will be focused
      await invoke('show_image_editor_window', { capturePath: capture.image_path });
    } catch (error) {
      reportError(error, { operation: 'image editor open' });
      toast.error('Failed to open image editor');
    }
  }, []);

  // Open project - now uses window-based editor for images
  const handleOpenProject = useCallback(async (id: string) => {
    const capture = captures.find(c => c.id === id);
    if (!capture || capture.is_missing) return;

    // Images open in dedicated window editor
    if (capture.capture_type !== 'video' && capture.capture_type !== 'gif') {
      await handleEditImage(capture);
    }
    // Videos/GIFs are handled separately in useMarqueeSelection
  }, [captures, handleEditImage]);

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
    onOpenProject: handleOpenProject,
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
    // Set active mode so toolbar shows correct mode
    const { setActiveMode } = useCaptureSettingsStore.getState();
    setActiveMode('screenshot');
    await CaptureService.showScreenshotOverlay();
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
      reportError(error, { operation: 'folder open' });
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
      reportError(error, { operation: 'delete capture' });
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
      reportError(error, { operation: 'folder open' });
    }
  }, []);

  const handleCopyToClipboard = useCallback(async (capture: CaptureListItem) => {
    try {
      await invoke('copy_image_to_clipboard', { path: capture.image_path });
      toast.success('Copied to clipboard');
    } catch (error) {
      reportError(error, { operation: 'copy to clipboard' });
    }
  }, []);

  const handlePlayMedia = useCallback(async (capture: CaptureListItem) => {
    try {
      await invoke('open_file_with_default_app', { path: capture.image_path });
    } catch (error) {
      reportError(error, { operation: 'media open' });
    }
  }, []);

  const handleEditVideo = useCallback(async (capture: CaptureListItem) => {
    try {
      // Open video in a dedicated floating window
      // If the video is already open, the existing window will be focused
      await invoke('show_video_editor_window', { projectPath: capture.image_path });
    } catch (error) {
      reportError(error, { operation: 'video editor open' });
      toast.error('Failed to open video editor');
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
                onEditVideo={capture.capture_type === 'video' ? () => handleEditVideo(capture) : undefined}
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
                onEditVideo={capture.capture_type === 'video' ? () => handleEditVideo(capture) : undefined}
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
        {loading || !initialized ? (
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
            onEditVideo={handleEditVideo}
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
        />
      </div>
    </TooltipProvider>
  );
};
