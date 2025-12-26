import React from 'react';
import {
  Search,
  Star,
  Trash2,
  LayoutGrid,
  List,
  Camera,
  Video,
  Film,
  X,
  FolderOpen,
  ScreenShare,
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
  onNewImage: () => void;
  onNewVideo: () => void;
  onNewGif: () => void;
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
  onNewImage,
  onNewVideo,
  onNewGif,
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
            className="search-input h-9 pl-9 pr-3 text-sm"
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
                className={`glass-btn h-9 w-9 ${
                  filterFavorites ? 'glass-btn--active text-[var(--coral-400)]' : ''
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
            className="glass-badge p-1 rounded-lg"
          >
            <ToggleGroupItem
              value="grid"
              aria-label="Grid view"
              className="h-7 w-7 rounded-md data-[state=on]:bg-[var(--glass-highlight)] data-[state=on]:text-[var(--coral-400)]"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="list"
              aria-label="List view"
              className="h-7 w-7 rounded-md data-[state=on]:bg-[var(--glass-highlight)] data-[state=on]:text-[var(--coral-400)]"
            >
              <List className="w-3.5 h-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex-1" />

        {/* Selection Actions (appears left of Open Folder when items selected) */}
        {selectedCount > 0 && (
          <div className="flex items-center gap-2 mr-2">
            <Badge
              variant="secondary"
              className="glass-badge text-xs"
            >
              {selectedCount} selected
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDeleteSelected}
                  className="glass-btn glass-btn--danger h-8 w-8"
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
                  className="glass-btn h-8 w-8"
                >
                  <X className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">Clear selection</p>
              </TooltipContent>
            </Tooltip>
            <div className="glass-divider h-5" />
          </div>
        )}

        {/* Capture Actions (always visible) */}
        <div className="flex items-center gap-2">
          <Button
            onClick={onOpenLibraryFolder}
            variant="outline"
            className="glass-btn h-8 px-3 gap-1.5 rounded-lg text-sm font-medium"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open Folder
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onAllMonitorsCapture}
                className="glass-btn-action h-9 w-9 p-0"
                style={{
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  boxShadow: '0 4px 16px rgba(16, 185, 129, 0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
                }}
              >
                <ScreenShare className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">All Monitors</p>
            </TooltipContent>
          </Tooltip>

          {/* Circular Capture Buttons */}
          <div className="flex items-center gap-1.5 ml-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onNewVideo}
                  className="glass-btn-action h-9 w-9 p-0"
                >
                  <Video className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">New Video</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onNewGif}
                  className="glass-btn-action glass-btn-action--purple h-9 w-9 p-0"
                >
                  <Film className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">New GIF</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onNewImage}
                  className="glass-btn-action glass-btn-action--blue h-9 w-9 p-0"
                  style={{
                    background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.9) 0%, rgba(37, 99, 235, 0.95) 100%)',
                    boxShadow: '0 4px 16px rgba(59, 130, 246, 0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
                  }}
                >
                  <Camera className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">New Screenshot</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </header>
  );
};
