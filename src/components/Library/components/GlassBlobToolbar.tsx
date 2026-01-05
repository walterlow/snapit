import React, { useState, useRef, useEffect } from 'react';
import {
  Star,
  LayoutGrid,
  List,
  FolderOpen,
  Search,
  X,
  Trash2,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { TagFilterDropdown } from './TagFilterDropdown';

interface GlassBlobToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filterFavorites: boolean;
  onFilterFavoritesChange: (value: boolean) => void;
  filterTags: string[];
  onFilterTagsChange: (tags: string[]) => void;
  allTags: string[];
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
  onOpenLibraryFolder: () => void;
}

export const GlassBlobToolbar: React.FC<GlassBlobToolbarProps> = ({
  searchQuery,
  onSearchChange,
  filterFavorites,
  onFilterFavoritesChange,
  filterTags,
  onFilterTagsChange,
  allTags,
  viewMode,
  onViewModeChange,
  selectedCount,
  onDeleteSelected,
  onClearSelection,
  onOpenLibraryFolder,
}) => {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchExpanded && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchExpanded]);

  const handleSearchToggle = () => {
    if (searchExpanded && searchQuery) {
      onSearchChange('');
    }
    setSearchExpanded(!searchExpanded);
  };

  const handleSearchBlur = () => {
    if (!searchQuery) {
      setSearchExpanded(false);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onSearchChange('');
      setSearchExpanded(false);
      searchInputRef.current?.blur();
    }
  };
  return (
    <div className="cloud-toolbar">
      <div className="cloud-toolbar__glass" />
      <div className="cloud-toolbar__inner">
        {/* LEFT: Search, Folder, Favorites */}
        <div className={`cloud-search ${searchExpanded ? 'cloud-search--expanded' : ''}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleSearchToggle}
                className={`cloud-btn cloud-btn--small ${searchQuery ? 'cloud-btn--active' : ''}`}
              >
                {searchExpanded && searchQuery ? (
                  <X className="w-[15px] h-[15px]" />
                ) : (
                  <Search className="w-[15px] h-[15px]" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">{searchExpanded ? 'Clear Search' : 'Search'}</p>
            </TooltipContent>
          </Tooltip>
          {searchExpanded && (
          <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onBlur={handleSearchBlur}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search..."
              className="cloud-search__input"
            />
          )}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenLibraryFolder} className="cloud-btn cloud-btn--small">
              <FolderOpen className="w-[15px] h-[15px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Open Folder</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onFilterFavoritesChange(!filterFavorites)}
              className={`cloud-btn cloud-btn--small ${filterFavorites ? 'cloud-btn--active' : ''}`}
            >
              <Star className="w-[15px] h-[15px]" fill={filterFavorites ? 'currentColor' : 'none'} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Favorites</p>
          </TooltipContent>
        </Tooltip>

        <TagFilterDropdown
          allTags={allTags}
          selectedTags={filterTags}
          onSelectionChange={onFilterTagsChange}
        />

        <div className="cloud-divider" />

        {/* View modes */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onViewModeChange('grid')}
              className={`cloud-btn cloud-btn--small ${viewMode === 'grid' ? 'cloud-btn--active' : ''}`}
            >
              <LayoutGrid className="w-[15px] h-[15px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Grid View</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onViewModeChange('list')}
              className={`cloud-btn cloud-btn--small ${viewMode === 'list' ? 'cloud-btn--active' : ''}`}
            >
              <List className="w-[15px] h-[15px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">List View</p>
          </TooltipContent>
        </Tooltip>

        {/* Selection actions - appended on right */}
        {selectedCount > 0 && (
          <>
            <div className="cloud-divider" />

            <div className="cloud-selection">
              <span className="cloud-selection__count">{selectedCount}</span>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onDeleteSelected} className="cloud-btn cloud-btn--small cloud-btn--danger">
                  <Trash2 className="w-[15px] h-[15px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Delete Selected</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onClearSelection} className="cloud-btn cloud-btn--small">
                  <X className="w-[15px] h-[15px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Clear Selection</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
};
