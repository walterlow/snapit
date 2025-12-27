import React from 'react';
import { Star, Trash2, Copy, ExternalLink, Play, Tag } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';

interface CaptureContextMenuProps {
  favorite: boolean;
  isMissing?: boolean;
  captureType?: string;
  onCopyToClipboard: () => void;
  onOpenInFolder: () => void;
  onToggleFavorite: () => void;
  onManageTags?: () => void;
  onDelete: () => void;
  onPlayMedia?: () => void;
}

// Check if capture is a video or gif
const isMediaType = (type?: string) => type === 'video' || type === 'gif';

export const CaptureContextMenu: React.FC<CaptureContextMenuProps> = ({
  favorite,
  isMissing = false,
  captureType,
  onCopyToClipboard,
  onOpenInFolder,
  onToggleFavorite,
  onManageTags,
  onDelete,
  onPlayMedia,
}) => {
  const isMedia = isMediaType(captureType);

  return (
    <ContextMenuContent>
      {isMedia && onPlayMedia && (
        <ContextMenuItem
          onClick={onPlayMedia}
          disabled={isMissing}
          className={isMissing ? 'opacity-50 cursor-not-allowed' : ''}
        >
          <Play className="w-4 h-4 mr-2" />
          Play {captureType === 'gif' ? 'GIF' : 'Video'}
        </ContextMenuItem>
      )}
      {!isMedia && (
        <ContextMenuItem
          onClick={onCopyToClipboard}
          disabled={isMissing}
          className={isMissing ? 'opacity-50 cursor-not-allowed' : ''}
        >
          <Copy className="w-4 h-4 mr-2" />
          Copy to Clipboard
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={onOpenInFolder}>
        <ExternalLink className="w-4 h-4 mr-2" />
        Show in Folder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onToggleFavorite}>
        <Star className="w-4 h-4 mr-2" fill={favorite ? 'currentColor' : 'none'} />
        {favorite ? 'Remove from Favorites' : 'Add to Favorites'}
      </ContextMenuItem>
      {onManageTags && (
        <ContextMenuItem onClick={onManageTags}>
          <Tag className="w-4 h-4 mr-2" />
          Manage Tags
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={onDelete}
        className="text-red-500 focus:text-red-500 focus:bg-red-50"
      >
        <Trash2 className="w-4 h-4 mr-2" />
        {isMissing ? 'Remove Entry' : 'Delete'}
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );
};
