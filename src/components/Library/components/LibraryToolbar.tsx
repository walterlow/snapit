import React from 'react';
import {
  Search,
  Trash2,
  X,
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

interface LibraryToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filterFavorites: boolean;
  onFilterFavoritesChange: (value: boolean) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
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
  selectedCount,
  onDeleteSelected,
  onClearSelection,
  onAllMonitorsCapture,
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

        <div className="flex-1" />

        {/* Selection Actions (appears when items selected) */}
        {selectedCount > 0 && (
          <div className="flex items-center gap-2">
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

        {/* All Monitors Quick Capture */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onAllMonitorsCapture}
              className="glass-btn-action h-9 w-9 p-0"
            >
              <ScreenShare className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">Capture All Monitors</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
};
