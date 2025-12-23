import React from 'react';
import {
  Search,
  Star,
  Trash2,
  LayoutGrid,
  List,
  Plus,
  X,
  FolderOpen,
  Monitor,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type ViewMode = 'grid' | 'list';

interface LibraryToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filterFavorites: boolean;
  onFilterFavoritesChange: (value: boolean) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
  onOpenLibraryFolder: () => void;
  onAllMonitorsCapture: () => void;
  onNewCapture: () => void;
}

export const LibraryToolbar: React.FC<LibraryToolbarProps> = ({
  searchQuery,
  onSearchChange,
  filterFavorites,
  onFilterFavoritesChange,
  viewMode,
  onViewModeChange,
  selectedCount,
  onDeleteSelected,
  onClearSelection,
  onOpenLibraryFolder,
  onAllMonitorsCapture,
  onNewCapture,
}) => {
  return (
    <header className="header-bar">
      <div className="flex items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--ink-subtle)]" />
          <Input
            type="text"
            placeholder="Search captures..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 pl-9 pr-3 text-sm bg-[var(--card)] border-[var(--polar-frost)] focus:border-[var(--coral-400)] focus:ring-[var(--coral-glow)] text-[var(--ink-black)] placeholder:text-[var(--ink-subtle)]"
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
                onClick={() => onFilterFavoritesChange(!filterFavorites)}
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
            onValueChange={(val) => val && onViewModeChange(val as ViewMode)}
            className="bg-[var(--polar-ice)] p-1 rounded-lg border border-[var(--polar-frost)]"
          >
            <ToggleGroupItem
              value="grid"
              aria-label="Grid view"
              className="h-7 w-7 rounded-md data-[state=on]:bg-[var(--card)] data-[state=on]:text-[var(--coral-500)] data-[state=on]:shadow-sm"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="list"
              aria-label="List view"
              className="h-7 w-7 rounded-md data-[state=on]:bg-[var(--card)] data-[state=on]:text-[var(--coral-500)] data-[state=on]:shadow-sm"
            >
              <List className="w-3.5 h-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex-1" />

        {/* Selection Actions or New Capture */}
        {selectedCount > 0 ? (
          <div className="flex items-center gap-2 animate-fade-in">
            <Badge
              variant="secondary"
              className="bg-[var(--polar-mist)] text-[var(--ink-muted)] border-[var(--polar-frost)] text-xs"
            >
              {selectedCount} selected
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDeleteSelected}
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
                  onClick={onClearSelection}
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
              onClick={onOpenLibraryFolder}
              variant="outline"
              className="h-8 px-3 gap-1.5 rounded-lg text-sm font-medium bg-[var(--card)] border-[var(--polar-frost)] text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Open Folder
            </Button>
            <Button
              onClick={onAllMonitorsCapture}
              variant="outline"
              className="h-8 px-3 gap-1.5 rounded-lg text-sm font-medium bg-[var(--card)] border-[var(--polar-frost)] text-[var(--ink-muted)] hover:text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
            >
              <Monitor className="w-3.5 h-3.5" />
              All Monitors
            </Button>
            <Button
              onClick={onNewCapture}
              className="btn-coral h-8 px-3 gap-1.5 rounded-lg text-sm font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              New Capture
            </Button>
          </div>
        )}
      </div>
    </header>
  );
};
