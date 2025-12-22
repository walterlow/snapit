import { useEffect, useState, memo, useRef, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Search,
  Star,
  Trash2,
  LayoutGrid,
  List,
  Aperture,
  Plus,
  Check,
  X,
  AlertTriangle,
  FolderOpen,
  Copy,
  ExternalLink,
  Upload,
} from 'lucide-react';
import { useCaptureStore, useFilteredCaptures } from '../../stores/captureStore';
import type { CaptureListItem } from '../../types';
import { formatDistanceToNow } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

type ViewMode = 'grid' | 'list';

export const CaptureLibrary: React.FC = () => {
  const {
    loading,
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

  const captures = useFilteredCaptures();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Delete confirmation state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

  // Marquee selection state
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState({ x: 0, y: 0 });
  const [selectionCurrent, setSelectionCurrent] = useState({ x: 0, y: 0 });
  const [selectionStartIds, setSelectionStartIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const isShiftHeld = useRef(false);
  const lastClickedId = useRef<string | null>(null);

  // Drag & drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  // Calculate selection rectangle bounds (handles any drag direction)
  const getSelectionRect = useCallback(() => {
    const left = Math.min(selectionStart.x, selectionCurrent.x);
    const top = Math.min(selectionStart.y, selectionCurrent.y);
    const width = Math.abs(selectionCurrent.x - selectionStart.x);
    const height = Math.abs(selectionCurrent.y - selectionStart.y);
    return { left, top, width, height };
  }, [selectionStart, selectionCurrent]);

  // Check if two rectangles intersect
  const rectsIntersect = useCallback((r1: DOMRect, r2: { left: number; top: number; width: number; height: number }) => {
    return !(
      r1.right < r2.left ||
      r1.left > r2.left + r2.width ||
      r1.bottom < r2.top ||
      r1.top > r2.top + r2.height
    );
  }, []);

  // Find captures within selection rectangle
  const getSelectedCapturesInRect = useCallback(() => {
    if (!containerRef.current) return new Set<string>();

    const selectionRect = getSelectionRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    // Adjust selection rect to be relative to viewport
    const viewportSelectionRect = {
      left: selectionRect.left + containerRect.left,
      top: selectionRect.top + containerRect.top,
      width: selectionRect.width,
      height: selectionRect.height,
    };

    const selected = new Set<string>();
    const cards = containerRef.current.querySelectorAll('[data-capture-id]');

    cards.forEach((card) => {
      const cardRect = card.getBoundingClientRect();
      if (rectsIntersect(cardRect, viewportSelectionRect)) {
        const id = card.getAttribute('data-capture-id');
        if (id) selected.add(id);
      }
    });

    return selected;
  }, [getSelectionRect, rectsIntersect]);

  // Handle mouse down on container
  const handleMarqueeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only start marquee on left click and on empty space
    if (e.button !== 0) return;

    // Don't start marquee if clicking on a card or button
    const target = e.target as HTMLElement;
    if (target.closest('[data-capture-id]') || target.closest('button')) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = e.clientX - containerRect.left + container.scrollLeft;
    const y = e.clientY - containerRect.top + container.scrollTop;

    isShiftHeld.current = e.shiftKey;
    setSelectionStartIds(e.shiftKey ? new Set(selectedIds) : new Set());
    setSelectionStart({ x, y });
    setSelectionCurrent({ x, y });
    setIsSelecting(true);

    // Prevent text selection
    e.preventDefault();
  }, [selectedIds]);

  // Handle mouse move during selection
  const handleMarqueeMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelecting) return;

    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = e.clientX - containerRect.left + container.scrollLeft;
    const y = e.clientY - containerRect.top + container.scrollTop;

    setSelectionCurrent({ x, y });

    // Update selection in real-time
    const inRect = getSelectedCapturesInRect();
    if (isShiftHeld.current) {
      // Add to existing selection
      const combined = new Set([...selectionStartIds, ...inRect]);
      setSelectedIds(combined);
    } else {
      setSelectedIds(inRect);
    }
  }, [isSelecting, getSelectedCapturesInRect, selectionStartIds]);

  // Handle mouse up to end selection
  const handleMarqueeMouseUp = useCallback(() => {
    if (!isSelecting) return;

    // If it was just a click (no drag), clear selection
    const rect = getSelectionRect();
    if (rect.width < 5 && rect.height < 5) {
      if (!isShiftHeld.current) {
        setSelectedIds(new Set());
      }
    }

    setIsSelecting(false);
  }, [isSelecting, getSelectionRect]);

  // Global mouse up listener to handle mouse up outside container
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isSelecting) {
        setIsSelecting(false);
      }
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isSelecting]);

  const handleSelect = (id: string, event: React.MouseEvent) => {
    if (event.shiftKey && lastClickedId.current) {
      // Shift+click: select range from last clicked to current
      const lastIndex = captures.findIndex(c => c.id === lastClickedId.current);
      const currentIndex = captures.findIndex(c => c.id === id);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = captures.slice(start, end + 1).map(c => c.id);

        // Add to existing selection or create new
        const newSelected = event.ctrlKey || event.metaKey
          ? new Set([...selectedIds, ...rangeIds])
          : new Set(rangeIds);
        setSelectedIds(newSelected);
      }
    } else if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd+click: toggle selection
      const newSelected = new Set(selectedIds);
      if (newSelected.has(id)) {
        newSelected.delete(id);
      } else {
        newSelected.add(id);
      }
      setSelectedIds(newSelected);
      lastClickedId.current = id;
    } else {
      // Normal click: open project
      loadProject(id);
      lastClickedId.current = id;
    }
  };

  const handleNewCapture = async () => {
    try {
      await invoke('show_overlay');
    } catch (error) {
      console.error('Failed to start capture:', error);
      toast.error('Failed to start capture');
    }
  };

  const handleOpenLibraryFolder = async () => {
    try {
      const libraryPath = await invoke<string>('get_library_folder');
      await invoke('open_path_in_explorer', { path: libraryPath });
    } catch (error) {
      console.error('Failed to open library folder:', error);
      toast.error('Failed to open library folder');
    }
  };

  // Handlers for delete confirmation
  const handleRequestDeleteSingle = (id: string) => {
    setPendingDeleteId(id);
    setPendingBulkDelete(false);
    setDeleteDialogOpen(true);
  };

  const handleRequestDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    setPendingDeleteId(null);
    setPendingBulkDelete(true);
    setDeleteDialogOpen(true);
  };

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

  const handleOpenInFolder = async (capture: CaptureListItem) => {
    try {
      await invoke('open_path_in_explorer', { path: capture.image_path });
    } catch (error) {
      console.error('Failed to open in folder:', error);
      toast.error('Failed to open file location');
    }
  };

  const handleCopyToClipboard = async (capture: CaptureListItem) => {
    try {
      await invoke('copy_image_to_clipboard', { path: capture.image_path });
      toast.success('Copied to clipboard');
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      toast.error('Failed to copy to clipboard');
    }
  };

  const getDeleteCount = () => {
    if (pendingBulkDelete) return selectedIds.size;
    return pendingDeleteId ? 1 : 0;
  };

  // Drag & drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    dragCounter.current = 0;

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter(file =>
      file.type.startsWith('image/') ||
      /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(file.name)
    );

    if (imageFiles.length === 0) {
      toast.error('No valid image files found');
      return;
    }

    const toastId = toast.loading(`Importing ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''}...`);

    try {
      let imported = 0;
      for (const file of imageFiles) {
        // Read file as base64
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => {
            const result = reader.result as string;
            // Remove data URL prefix to get just the base64 data
            const base64Data = result.split(',')[1];
            resolve(base64Data);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        // Save as new capture
        await invoke('save_capture', {
          request: {
            image_data: base64,
            capture_type: 'import',
            source: { region: null },
          },
        });
        imported++;
      }

      await loadCaptures();
      toast.success(`Imported ${imported} image${imported > 1 ? 's' : ''}`, { id: toastId });
    } catch (error) {
      console.error('Failed to import images:', error);
      toast.error('Failed to import images', { id: toastId });
    }
  }, [loadCaptures]);

  const formatDate = (dateStr: string) => {
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
    } catch {
      return dateStr;
    }
  };

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <div
        className="flex flex-col h-full bg-[var(--polar-snow)] relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drop Zone Overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-50 bg-[var(--polar-snow)]/95 flex items-center justify-center pointer-events-none animate-fade-in">
            <div className="flex flex-col items-center gap-4 p-8 rounded-2xl border-2 border-dashed border-[var(--coral-400)] bg-[var(--coral-50)]">
              <div className="w-16 h-16 rounded-full bg-[var(--coral-100)] flex items-center justify-center">
                <Upload className="w-8 h-8 text-[var(--coral-500)]" />
              </div>
              <div className="text-center">
                <p className="text-lg font-semibold text-[var(--ink-black)]">Drop images here</p>
                <p className="text-sm text-[var(--ink-muted)]">Import images to your library</p>
              </div>
            </div>
          </div>
        )}

        {/* Toolbar */}
        <header className="header-bar">
          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--ink-subtle)]"
              />
              <Input
                type="text"
                placeholder="Search captures..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 pl-9 pr-3 text-sm bg-white border-[var(--polar-frost)] focus:border-[var(--coral-400)] focus:ring-[var(--coral-glow)] text-[var(--ink-black)] placeholder:text-[var(--ink-subtle)]"
              />
            </div>

            {/* View Controls */}
            <div className="flex items-center gap-3">
              {/* Favorites Filter */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setFilterFavorites(!filterFavorites)}
                    className={`h-9 w-9 rounded-lg transition-all ${
                      filterFavorites
                        ? 'bg-[var(--coral-50)] text-[var(--coral-500)] border border-[var(--coral-200)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-mist)]'
                    }`}
                  >
                    <Star className="w-4 h-4" fill={filterFavorites ? 'currentColor' : 'none'} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Show favorites only</p>
                </TooltipContent>
              </Tooltip>

              {/* View Toggle */}
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(val) => val && setViewMode(val as ViewMode)}
                className="bg-[var(--polar-ice)] p-1 rounded-lg border border-[var(--polar-frost)]"
              >
                <ToggleGroupItem
                  value="grid"
                  aria-label="Grid view"
                  className="h-7 w-7 rounded-md data-[state=on]:bg-white data-[state=on]:text-[var(--coral-500)] data-[state=on]:shadow-sm"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="list"
                  aria-label="List view"
                  className="h-7 w-7 rounded-md data-[state=on]:bg-white data-[state=on]:text-[var(--coral-500)] data-[state=on]:shadow-sm"
                >
                  <List className="w-3.5 h-3.5" />
                </ToggleGroupItem>
              </ToggleGroup>

            </div>

            <div className="flex-1" />

            {/* Selection Actions or New Capture */}
            {selectedIds.size > 0 ? (
              <div className="flex items-center gap-2 animate-fade-in">
                <Badge variant="secondary" className="bg-[var(--polar-mist)] text-[var(--ink-muted)] border-[var(--polar-frost)] text-xs">
                  {selectedIds.size} selected
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleRequestDeleteSelected}
                      className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">Delete selected</p>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setSelectedIds(new Set())}
                      className="h-8 w-8 text-[var(--ink-muted)] hover:text-[var(--ink-dark)]"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">Clear selection</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleOpenLibraryFolder}
                  variant="outline"
                  className="h-8 px-3 gap-1.5 rounded-lg text-sm font-medium bg-white border-[var(--polar-frost)] text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Open Folder
                </Button>
                <Button
                  onClick={handleNewCapture}
                  className="btn-coral h-8 px-3 gap-1.5 rounded-lg text-sm font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New Capture
                </Button>
              </div>
            )}
          </div>
        </header>

        {/* Content - Scrollable area with marquee selection */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto p-8 relative select-none"
          onMouseDown={handleMarqueeMouseDown}
          onMouseMove={handleMarqueeMouseMove}
          onMouseUp={handleMarqueeMouseUp}
        >
          {/* Marquee Selection Rectangle */}
          {isSelecting && (
            <div
              className="absolute pointer-events-none z-50 border-2 border-[var(--coral-400)] bg-[var(--coral-glow)] rounded-sm"
              style={{
                left: getSelectionRect().left,
                top: getSelectionRect().top,
                width: getSelectionRect().width,
                height: getSelectionRect().height,
              }}
            />
          )}

          {loading ? (
            <div
              className="grid gap-5"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              }}
            >
              {[...Array(6)].map((_, i) => (
                <div key={i} className="rounded-xl border border-[var(--polar-frost)] bg-white overflow-hidden">
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
            <div
              className="grid gap-5 stagger-grid"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              }}
            >
              {captures.map((capture, index) => (
                <CaptureCard
                  key={capture.id}
                  capture={capture}
                  selected={selectedIds.has(capture.id)}
                  staggerIndex={index}
                  onSelect={handleSelect}
                  onToggleFavorite={() => toggleFavorite(capture.id)}
                  onDelete={() => handleRequestDeleteSingle(capture.id)}
                  onOpenInFolder={() => handleOpenInFolder(capture)}
                  onCopyToClipboard={() => handleCopyToClipboard(capture)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 stagger-grid">
              {captures.map((capture, index) => (
                <CaptureRow
                  key={capture.id}
                  capture={capture}
                  selected={selectedIds.has(capture.id)}
                  staggerIndex={index}
                  onSelect={handleSelect}
                  onToggleFavorite={() => toggleFavorite(capture.id)}
                  onDelete={() => handleRequestDeleteSingle(capture.id)}
                  onOpenInFolder={() => handleOpenInFolder(capture)}
                  onCopyToClipboard={() => handleCopyToClipboard(capture)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          )}
        </div>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-red-500" />
                Delete {getDeleteCount() === 1 ? 'Capture' : 'Captures'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete {getDeleteCount() === 1 ? 'this capture' : `${getDeleteCount()} captures`}?
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={handleCancelDelete}
                className="bg-white border-[var(--polar-frost)] text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDelete}
                className="bg-red-500 text-white hover:bg-red-600"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
};

const EmptyState: React.FC<{ onNewCapture: () => void }> = ({ onNewCapture }) => (
  <div className="flex flex-col items-center justify-center py-16 animate-fade-in">
    {/* Illustration */}
    <div className="relative mb-6">
      <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-[var(--coral-50)] to-[var(--polar-ice)] flex items-center justify-center">
        <div className="w-16 h-16 rounded-xl bg-white shadow-lg flex items-center justify-center border border-[var(--polar-frost)]">
          <Aperture className="w-8 h-8 text-[var(--coral-400)]" />
        </div>
      </div>
      <div className="absolute -right-2 -top-2 w-6 h-6 rounded-full bg-[var(--coral-400)] flex items-center justify-center shadow-md">
        <Plus className="w-4 h-4 text-white" />
      </div>
    </div>

    <h2 className="text-lg font-semibold text-[var(--ink-black)] mb-2">No captures yet</h2>
    <p className="text-sm text-[var(--ink-muted)] text-center max-w-xs mb-6">
      Take your first screenshot to get started. Your captures will appear here for easy access.
    </p>

    <Button onClick={onNewCapture} className="btn-coral gap-2 px-5 h-10 rounded-xl text-sm font-medium shadow-md hover:shadow-lg transition-shadow">
      <Aperture className="w-4 h-4" />
      Take Screenshot
    </Button>

    <div className="flex items-center gap-2 mt-5 text-xs text-[var(--ink-subtle)]">
      <span>or press</span>
      <div className="flex items-center gap-1">
        <kbd className="kbd">Ctrl</kbd>
        <span>+</span>
        <kbd className="kbd">Shift</kbd>
        <span>+</span>
        <kbd className="kbd">S</kbd>
      </div>
    </div>
  </div>
);

interface CaptureCardProps {
  capture: CaptureListItem;
  selected: boolean;
  staggerIndex?: number;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onOpenInFolder: () => void;
  onCopyToClipboard: () => void;
  formatDate: (date: string) => string;
}

// Custom comparison for memo - only re-render when capture data or selection changes
const capturePropsAreEqual = (prev: CaptureCardProps, next: CaptureCardProps) => {
  return (
    prev.capture.id === next.capture.id &&
    prev.capture.favorite === next.capture.favorite &&
    prev.capture.thumbnail_path === next.capture.thumbnail_path &&
    prev.selected === next.selected &&
    prev.staggerIndex === next.staggerIndex
  );
};

const CaptureCard: React.FC<CaptureCardProps> = memo(({
  capture,
  selected,
  staggerIndex,
  onSelect,
  onToggleFavorite,
  onDelete,
  onOpenInFolder,
  onCopyToClipboard,
  formatDate,
}) => {
  const thumbnailSrc = convertFileSrc(capture.thumbnail_path);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`capture-card group ${selected ? 'selected' : ''}`}
          style={{ '--stagger-index': staggerIndex } as React.CSSProperties}
          data-capture-id={capture.id}
          onClick={(e) => onSelect(capture.id, e)}
        >
      {/* Thumbnail */}
      <div className="thumbnail">
        <img
          src={thumbnailSrc}
          alt="Capture"
          loading="lazy"
        />

        {/* Selection Checkbox */}
        <div
          className={`absolute top-3 left-3 transition-all duration-200 ${
            selected ? 'opacity-100 scale-100' : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
          }`}
        >
          <div className={`checkbox-custom ${selected ? 'checked' : ''}`}>
            {selected && <Check className="w-3 h-3" />}
          </div>
        </div>

        {/* Favorite Badge */}
        {capture.favorite && (
          <div className="absolute top-3 right-3 animate-scale-in">
            <div className="w-7 h-7 rounded-lg bg-white/90 backdrop-blur-sm flex items-center justify-center border border-[var(--coral-200)] shadow-sm">
              <Star className="w-3.5 h-3.5 text-[var(--coral-400)]" fill="currentColor" />
            </div>
          </div>
        )}

        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* Card Footer */}
      <div className="card-footer flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--ink-subtle)]">
            {formatDate(capture.created_at)}
          </span>
          <span className="pill font-mono text-[10px]">
            {capture.dimensions.width} × {capture.dimensions.height}
          </span>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--polar-mist)] transition-colors"
          >
            <Star
              className="w-4 h-4 transition-colors"
              fill={capture.favorite ? 'currentColor' : 'none'}
              style={{ color: capture.favorite ? 'var(--coral-400)' : 'var(--ink-subtle)' }}
            />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onCopyToClipboard}>
          <Copy className="w-4 h-4 mr-2" />
          Copy to Clipboard
        </ContextMenuItem>
        <ContextMenuItem onClick={onOpenInFolder}>
          <ExternalLink className="w-4 h-4 mr-2" />
          Show in Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onToggleFavorite}>
          <Star className="w-4 h-4 mr-2" fill={capture.favorite ? 'currentColor' : 'none'} />
          {capture.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} className="text-red-500 focus:text-red-500 focus:bg-red-50">
          <Trash2 className="w-4 h-4 mr-2" />
          Delete
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}, capturePropsAreEqual);

const CaptureRow: React.FC<CaptureCardProps> = memo(({
  capture,
  selected,
  staggerIndex,
  onSelect,
  onToggleFavorite,
  onDelete,
  onOpenInFolder,
  onCopyToClipboard,
  formatDate,
}) => {
  const thumbnailSrc = convertFileSrc(capture.thumbnail_path);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`capture-row group ${selected ? 'selected' : ''}`}
          style={{ '--stagger-index': staggerIndex } as React.CSSProperties}
          data-capture-id={capture.id}
          onClick={(e) => onSelect(capture.id, e)}
        >
      {/* Checkbox */}
      <div className={`checkbox-custom ${selected ? 'checked' : ''}`}>
        {selected && <Check className="w-3 h-3" />}
      </div>

      {/* Thumbnail */}
      <div className="row-thumbnail">
        <img src={thumbnailSrc} alt="Capture" loading="lazy" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-[var(--ink-black)] capitalize">
            {capture.capture_type} capture
          </span>
          {capture.has_annotations && (
            <Badge className="pill-coral text-[10px] px-2 py-0.5">
              Edited
            </Badge>
          )}
        </div>
        <div className="text-xs text-[var(--ink-subtle)] font-mono">
          {capture.dimensions.width} × {capture.dimensions.height}
          <span className="mx-2 text-[var(--polar-frost)]">·</span>
          {formatDate(capture.created_at)}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--polar-mist)] transition-colors"
            >
              <Star
                className="w-4 h-4"
                fill={capture.favorite ? 'currentColor' : 'none'}
                style={{ color: capture.favorite ? 'var(--coral-400)' : 'var(--ink-subtle)' }}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">{capture.favorite ? 'Remove from favorites' : 'Add to favorites'}</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Delete capture</p>
          </TooltipContent>
        </Tooltip>
      </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onCopyToClipboard}>
          <Copy className="w-4 h-4 mr-2" />
          Copy to Clipboard
        </ContextMenuItem>
        <ContextMenuItem onClick={onOpenInFolder}>
          <ExternalLink className="w-4 h-4 mr-2" />
          Show in Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onToggleFavorite}>
          <Star className="w-4 h-4 mr-2" fill={capture.favorite ? 'currentColor' : 'none'} />
          {capture.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} className="text-red-500 focus:text-red-500 focus:bg-red-50">
          <Trash2 className="w-4 h-4 mr-2" />
          Delete
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}, capturePropsAreEqual);
