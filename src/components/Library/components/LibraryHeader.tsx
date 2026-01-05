import React, { useState, useRef } from 'react';
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

interface LibraryHeaderProps {
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

export const LibraryHeader: React.FC<LibraryHeaderProps> = ({
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
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onSearchChange('');
      searchInputRef.current?.blur();
    }
  };

  const handleClearSearch = () => {
    onSearchChange('');
    searchInputRef.current?.focus();
  };

  return (
    <header className="library-header">
      <div className="library-header__inner">
        {/* Left section: Search */}
        <div className="library-header__section">
          <div className={`library-header__search ${searchFocused || searchQuery ? 'library-header__search--active' : ''}`}>
            <Search className="library-header__search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search"
              className="library-header__search-input"
            />
            {searchQuery && (
              <button
                onClick={handleClearSearch}
                className="library-header__search-clear"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Center section: Filters */}
        <div className="library-header__section library-header__section--center">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onFilterFavoritesChange(!filterFavorites)}
                className={`library-header__btn ${filterFavorites ? 'library-header__btn--active' : ''}`}
              >
                <Star className="w-4 h-4" fill={filterFavorites ? 'currentColor' : 'none'} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Favorites</p>
            </TooltipContent>
          </Tooltip>

          <TagFilterDropdown
            allTags={allTags}
            selectedTags={filterTags}
            onSelectionChange={onFilterTagsChange}
          />

          <div className="library-header__divider" />

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenLibraryFolder}
                className="library-header__btn"
              >
                <FolderOpen className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Open Folder</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Right section: View modes & Selection */}
        <div className="library-header__section library-header__section--right">
          {/* Selection actions */}
          {selectedCount > 0 && (
            <>
              <div className="library-header__selection">
                <span className="library-header__selection-count">{selectedCount}</span>
                <span className="library-header__selection-label">selected</span>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onDeleteSelected}
                    className="library-header__btn library-header__btn--danger"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Delete</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onClearSelection}
                    className="library-header__btn"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Clear</p>
                </TooltipContent>
              </Tooltip>

              <div className="library-header__divider" />
            </>
          )}

          {/* View mode toggle */}
          <div className="library-header__view-toggle">
            <button
              onClick={() => onViewModeChange('grid')}
              className={`library-header__view-btn ${viewMode === 'grid' ? 'library-header__view-btn--active' : ''}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => onViewModeChange('list')}
              className={`library-header__view-btn ${viewMode === 'list' ? 'library-header__view-btn--active' : ''}`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
