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
  Image as ImageIcon,
  Sparkles,
  AlertTriangle,
  FolderOpen,
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
    if (event.ctrlKey || event.metaKey) {
      const newSelected = new Set(selectedIds);
      if (newSelected.has(id)) {
        newSelected.delete(id);
      } else {
        newSelected.add(id);
      }
      setSelectedIds(newSelected);
    } else {
      loadProject(id);
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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full bg-[var(--obsidian-base)]">
        {/* Toolbar */}
        <header className="header-bar">
          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
              />
              <Input
                type="text"
                placeholder="Search captures..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 pl-9 pr-3 text-sm bg-[var(--obsidian-elevated)] border-[var(--border-subtle)] focus:border-amber-400 focus:ring-amber-400/20 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
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
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]'
                    }`}
                  >
                    <Star className="w-4 h-4" fill={filterFavorites ? 'currentColor' : 'none'} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="bg-[var(--obsidian-float)] border-[var(--border-default)]">
                  <p className="text-xs">Show favorites only</p>
                </TooltipContent>
              </Tooltip>

              {/* View Toggle */}
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(val) => val && setViewMode(val as ViewMode)}
                className="bg-[var(--obsidian-elevated)] p-1 rounded-lg border border-[var(--border-subtle)]"
              >
                <ToggleGroupItem
                  value="grid"
                  aria-label="Grid view"
                  className="h-7 w-7 rounded-md data-[state=on]:bg-[var(--obsidian-hover)] data-[state=on]:text-amber-400"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="list"
                  aria-label="List view"
                  className="h-7 w-7 rounded-md data-[state=on]:bg-[var(--obsidian-hover)] data-[state=on]:text-amber-400"
                >
                  <List className="w-3.5 h-3.5" />
                </ToggleGroupItem>
              </ToggleGroup>

            </div>

            <div className="flex-1" />

            {/* Selection Actions or New Capture */}
            {selectedIds.size > 0 ? (
              <div className="flex items-center gap-2 animate-fade-in">
                <Badge variant="secondary" className="bg-[var(--obsidian-elevated)] text-[var(--text-secondary)] border-[var(--border-default)] text-xs">
                  {selectedIds.size} selected
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleRequestDeleteSelected}
                      className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
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
                      className="h-8 w-8 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
                  className="h-8 px-3 gap-1.5 rounded-lg text-sm font-medium bg-[var(--obsidian-elevated)] border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Open Folder
                </Button>
                <Button
                  onClick={handleNewCapture}
                  className="btn-amber h-8 px-3 gap-1.5 rounded-lg text-sm font-medium"
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
              className="absolute pointer-events-none z-50 border border-amber-400 bg-amber-400/10 rounded-sm"
              style={{
                left: getSelectionRect().left,
                top: getSelectionRect().top,
                width: getSelectionRect().width,
                height: getSelectionRect().height,
              }}
            />
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="relative">
                <div className="w-8 h-8 border-2 border-[var(--border-default)] border-t-amber-400 rounded-full animate-spin" />
                <Sparkles className="absolute inset-0 m-auto w-3 h-3 text-amber-400 animate-pulse" />
              </div>
            </div>
          ) : captures.length === 0 ? (
            <EmptyState onNewCapture={handleNewCapture} />
          ) : viewMode === 'grid' ? (
            <div
              className="grid gap-4 stagger-grid"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              }}
            >
              {captures.map((capture) => (
                <CaptureCard
                  key={capture.id}
                  capture={capture}
                  selected={selectedIds.has(capture.id)}
                  onSelect={handleSelect}
                  onToggleFavorite={() => toggleFavorite(capture.id)}
                  onDelete={() => handleRequestDeleteSingle(capture.id)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 stagger-grid">
              {captures.map((capture) => (
                <CaptureRow
                  key={capture.id}
                  capture={capture}
                  selected={selectedIds.has(capture.id)}
                  onSelect={handleSelect}
                  onToggleFavorite={() => toggleFavorite(capture.id)}
                  onDelete={() => handleRequestDeleteSingle(capture.id)}
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
                <AlertTriangle className="w-5 h-5 text-red-400" />
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
                className="bg-[var(--obsidian-elevated)] border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)]"
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
  <div className="empty-state animate-fade-in">
    <div className="empty-state-icon">
      <ImageIcon className="w-7 h-7 text-[var(--text-muted)]" />
    </div>
    <h2>No captures yet</h2>
    <p>
      Take your first screenshot to get started. Your captures will appear here.
    </p>
    <Button onClick={onNewCapture} className="btn-amber gap-2 px-4 h-9 rounded-lg text-sm">
      <Aperture className="w-4 h-4" />
      Take Screenshot
    </Button>
    <p className="text-xs text-[var(--text-muted)] mt-4 flex items-center gap-1">
      or press
      <kbd className="kbd">Ctrl</kbd>
      <span>+</span>
      <kbd className="kbd">Shift</kbd>
      <span>+</span>
      <kbd className="kbd">S</kbd>
    </p>
  </div>
);

interface CaptureCardProps {
  capture: CaptureListItem;
  selected: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  formatDate: (date: string) => string;
}

// Custom comparison for memo - only re-render when capture data or selection changes
const capturePropsAreEqual = (prev: CaptureCardProps, next: CaptureCardProps) => {
  return (
    prev.capture.id === next.capture.id &&
    prev.capture.favorite === next.capture.favorite &&
    prev.capture.thumbnail_path === next.capture.thumbnail_path &&
    prev.selected === next.selected
  );
};

const CaptureCard: React.FC<CaptureCardProps> = memo(({
  capture,
  selected,
  onSelect,
  onToggleFavorite,
  onDelete,
  formatDate,
}) => {
  const thumbnailSrc = convertFileSrc(capture.thumbnail_path);

  return (
    <div
      className={`capture-card group ${selected ? 'selected' : ''}`}
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
            <div className="w-7 h-7 rounded-lg bg-[var(--obsidian-base)]/80 backdrop-blur-sm flex items-center justify-center border border-amber-500/30">
              <Star className="w-3.5 h-3.5 text-amber-400" fill="currentColor" />
            </div>
          </div>
        )}

        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--obsidian-deep)]/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* Card Footer */}
      <div className="card-footer flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--text-muted)]">
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
            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--obsidian-hover)] transition-colors"
          >
            <Star
              className="w-4 h-4 transition-colors"
              fill={capture.favorite ? 'currentColor' : 'none'}
              style={{ color: capture.favorite ? 'var(--amber-400)' : 'var(--text-muted)' }}
            />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}, capturePropsAreEqual);

const CaptureRow: React.FC<CaptureCardProps> = memo(({
  capture,
  selected,
  onSelect,
  onToggleFavorite,
  onDelete,
  formatDate,
}) => {
  const thumbnailSrc = convertFileSrc(capture.thumbnail_path);

  return (
    <div
      className={`capture-row group ${selected ? 'selected' : ''}`}
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
          <span className="text-sm font-medium text-[var(--text-primary)] capitalize">
            {capture.capture_type} capture
          </span>
          {capture.has_annotations && (
            <Badge className="pill-amber text-[10px] px-2 py-0.5">
              Edited
            </Badge>
          )}
        </div>
        <div className="text-xs text-[var(--text-muted)] font-mono">
          {capture.dimensions.width} × {capture.dimensions.height}
          <span className="mx-2 text-[var(--border-strong)]">·</span>
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
              className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--obsidian-hover)] transition-colors"
            >
              <Star
                className="w-4 h-4"
                fill={capture.favorite ? 'currentColor' : 'none'}
                style={{ color: capture.favorite ? 'var(--amber-400)' : 'var(--text-muted)' }}
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
              className="w-8 h-8 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-500/10 transition-colors"
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
  );
}, capturePropsAreEqual);
