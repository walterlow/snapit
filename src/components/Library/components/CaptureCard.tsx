import React, { memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Star, Trash2, Check, Copy, ExternalLink } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { CaptureCardProps } from './types';
import { capturePropsAreEqual } from './types';

export const CaptureCard: React.FC<CaptureCardProps> = memo(
  ({
    capture,
    selected,
    staggerIndex,
    onSelect,
    onToggleFavorite,
    onDelete,
    onOpenInFolder,
    onCopyToClipboard,
    formatDate,
  }) => {
    const thumbnailSrc = convertFileSrc(capture.thumbnail_path);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={`capture-card group ${selected ? 'selected' : ''}`}
            style={{ '--stagger-index': staggerIndex } as React.CSSProperties}
            data-capture-id={capture.id}
            onClick={(e) => onSelect(capture.id, e)}
          >
            {/* Thumbnail */}
            <div className="thumbnail">
              <img src={thumbnailSrc} alt="Capture" loading="lazy" />

              {/* Selection Checkbox */}
              <div
                className={`absolute top-3 left-3 transition-all duration-200 ${
                  selected
                    ? 'opacity-100 scale-100'
                    : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
                }`}
              >
                <div className={`checkbox-custom ${selected ? 'checked' : ''}`}>
                  {selected && <Check className="w-3 h-3" />}
                </div>
              </div>

              {/* Favorite Badge */}
              {capture.favorite && (
                <div className="absolute top-3 right-3 animate-scale-in">
                  <div className="w-7 h-7 rounded-lg bg-white/90 backdrop-blur-sm flex items-center justify-center border border-[var(--coral-200)] shadow-sm">
                    <Star className="w-3.5 h-3.5 text-[var(--coral-400)]" fill="currentColor" />
                  </div>
                </div>
              )}

              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </div>

            {/* Card Footer */}
            <div className="card-footer flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">
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
                  className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--polar-mist)] transition-colors"
                >
                  <Star
                    className="w-4 h-4 transition-colors"
                    fill={capture.favorite ? 'currentColor' : 'none'}
                    style={{
                      color: capture.favorite ? 'var(--coral-400)' : 'var(--ink-subtle)',
                    }}
                  />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onCopyToClipboard}>
            <Copy className="w-4 h-4 mr-2" />
            Copy to Clipboard
          </ContextMenuItem>
          <ContextMenuItem onClick={onOpenInFolder}>
            <ExternalLink className="w-4 h-4 mr-2" />
            Show in Folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onToggleFavorite}>
            <Star className="w-4 h-4 mr-2" fill={capture.favorite ? 'currentColor' : 'none'} />
            {capture.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={onDelete}
            className="text-red-500 focus:text-red-500 focus:bg-red-50"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
            <ContextMenuShortcut>Del</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  },
  capturePropsAreEqual
);
