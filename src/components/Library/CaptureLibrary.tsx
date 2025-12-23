import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { isToday, isYesterday, isThisWeek, isThisMonth, isThisYear, format, formatDistanceToNow } from 'date-fns';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { useCaptureStore, useFilteredCaptures } from '../../stores/captureStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { CaptureListItem, MonitorInfo, FastCaptureResult, ScreenRegionSelection } from '../../types';

import { useMarqueeSelection, useDragDropImport, useMomentumScroll, useResizeTransitionLock } from './hooks';
import {
  DateHeader,
  EmptyState,
  DropZoneOverlay,
  CaptureCard,
  CaptureRow,
  LibraryToolbar,
  DeleteDialog,
} from './components';

type ViewMode = 'grid' | 'list';

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
    searchQuery,
    setSearchQuery,
    filterFavorites,
    setFilterFavorites,
  } = useCaptureStore();

  const { settings } = useSettingsStore();

  const captures = useFilteredCaptures();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handleNewCapture = async () => {
    try {
      await invoke('show_overlay');
    } catch (error) {
      console.error('Failed to start capture:', error);
      toast.error('Failed to start capture');
    }
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

  const renderCaptureGrid = () => {
    const dateGroups = groupCapturesByDate(captures);

    return (
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
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                  onToggleFavorite={() => toggleFavorite(capture.id)}
                  onDelete={() => handleRequestDeleteSingle(capture.id)}
                  onOpenInFolder={() => handleOpenInFolder(capture)}
                  onCopyToClipboard={() => handleCopyToClipboard(capture)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderCaptureList = () => {
    const dateGroups = groupCapturesByDate(captures);

    return (
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
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                  onToggleFavorite={() => toggleFavorite(capture.id)}
                  onDelete={() => handleRequestDeleteSingle(capture.id)}
                  onOpenInFolder={() => handleOpenInFolder(capture)}
                  onCopyToClipboard={() => handleCopyToClipboard(capture)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <div className="flex flex-col h-full bg-[var(--polar-snow)] relative">
        {/* Drop Zone Overlay */}
        {isDragOver && <DropZoneOverlay />}

        {/* Toolbar */}
        <LibraryToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          filterFavorites={filterFavorites}
          onFilterFavoritesChange={setFilterFavorites}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selectedCount={selectedIds.size}
          onDeleteSelected={handleRequestDeleteSelected}
          onClearSelection={clearSelection}
          onOpenLibraryFolder={handleOpenLibraryFolder}
          onAllMonitorsCapture={handleAllMonitorsCapture}
          onNewCapture={handleNewCapture}
        />

        {/* Content - Scrollable area with marquee selection */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto p-8 relative select-none library-scroll"
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

          {loading ? (
            <div className="capture-grid">
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-[var(--polar-frost)] bg-white overflow-hidden"
                >
                  <Skeleton className="aspect-video w-full" />
                  <div className="p-3 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : captures.length === 0 ? (
            <EmptyState onNewCapture={handleNewCapture} />
          ) : viewMode === 'grid' ? (
            renderCaptureGrid()
          ) : (
            renderCaptureList()
          )}
        </div>

        {/* Delete Confirmation Dialog */}
        <DeleteDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          count={getDeleteCount()}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      </div>
    </TooltipProvider>
  );
};
