import React, { useState, useRef, useEffect } from 'react';
import {
  Star,
  LayoutGrid,
  List,
  Camera,
  Film,
  ImagePlay,
  FolderOpen,
  Settings,
  Search,
  X,
  ScreenShare,
  Trash2,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface GlassBlobToolbarProps {
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
  onOpenSettings?: () => void;
}

export const GlassBlobToolbar: React.FC<GlassBlobToolbarProps> = ({
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
  onOpenSettings,
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

        <div className="cloud-divider" />

        {/* CENTER: Capture buttons */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onNewVideo} className="cloud-btn cloud-btn--medium">
              <Film className="w-[24px] h-[24px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">New Video</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onNewImage} className="cloud-btn cloud-btn--large cloud-btn--coral">
              <Camera className="w-[32px] h-[32px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">New Screenshot</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onNewGif} className="cloud-btn cloud-btn--medium">
              <ImagePlay className="w-[24px] h-[24px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">New GIF</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onAllMonitorsCapture} className="cloud-btn cloud-btn--medium">
              <ScreenShare className="w-[18px] h-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">All Monitors</p>
          </TooltipContent>
        </Tooltip>

        <div className="cloud-divider" />

        {/* RIGHT: View modes */}
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

        <div className="cloud-divider" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenSettings} className="cloud-btn cloud-btn--small">
              <Settings className="w-[15px] h-[15px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Settings</p>
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
