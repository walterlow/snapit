import { useEffect, useState, memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';
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
} from 'lucide-react';
import { useCaptureStore, useFilteredCaptures } from '../../stores/captureStore';
import type { CaptureListItem } from '../../types';
import { formatDistanceToNow } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

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

  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

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
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    await deleteCaptures(Array.from(selectedIds));
    setSelectedIds(new Set());
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
                      onClick={handleDeleteSelected}
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
              <Button
                onClick={handleNewCapture}
                className="btn-amber h-8 px-3 gap-1.5 rounded-lg text-sm font-medium"
              >
                <Plus className="w-3.5 h-3.5" />
                New Capture
              </Button>
            )}
          </div>
        </header>

        {/* Content */}
        <ScrollArea className="flex-1">
          <main className="p-4">
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
                    onDelete={() => deleteCapture(capture.id)}
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
                    onDelete={() => deleteCapture(capture.id)}
                    formatDate={formatDate}
                  />
                ))}
              </div>
            )}
          </main>
        </ScrollArea>
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
