import React from 'react';
import { Star, Trash2, Copy, ExternalLink } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';

interface CaptureContextMenuProps {
  favorite: boolean;
  isMissing?: boolean;
  onCopyToClipboard: () => void;
  onOpenInFolder: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

export const CaptureContextMenu: React.FC<CaptureContextMenuProps> = ({
  favorite,
  isMissing = false,
  onCopyToClipboard,
  onOpenInFolder,
  onToggleFavorite,
  onDelete,
}) => {
  return (
    <ContextMenuContent>
      <ContextMenuItem
        onClick={onCopyToClipboard}
        disabled={isMissing}
        className={isMissing ? 'opacity-50 cursor-not-allowed' : ''}
      >
        <Copy className="w-4 h-4 mr-2" />
        Copy to Clipboard
      </ContextMenuItem>
      <ContextMenuItem onClick={onOpenInFolder}>
        <ExternalLink className="w-4 h-4 mr-2" />
        Show in Folder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onToggleFavorite}>
        <Star className="w-4 h-4 mr-2" fill={favorite ? 'currentColor' : 'none'} />
        {favorite ? 'Remove from Favorites' : 'Add to Favorites'}
      </ContextMenuItem>
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
