import React, { memo } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Star, Trash2, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CaptureContextMenu } from './CaptureContextMenu';
import type { CaptureCardProps } from './types';
import { capturePropsAreEqual } from './types';

export const CaptureRow: React.FC<CaptureCardProps> = memo(
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
            className={`capture-row group ${selected ? 'selected' : ''}`}
            style={{ '--stagger-index': staggerIndex } as React.CSSProperties}
            data-capture-id={capture.id}
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
                <span className="text-sm font-medium text-[var(--ink-black)] capitalize">
                  {capture.capture_type} capture
                </span>
                {capture.has_annotations && (
                  <Badge className="pill-coral text-[10px] px-2 py-0.5">Edited</Badge>
                )}
              </div>
              <div className="text-xs text-[var(--ink-subtle)] font-mono">
                {capture.dimensions.width} × {capture.dimensions.height}
                <span className="mx-2 text-[var(--polar-frost)]">·</span>
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
                    className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--polar-mist)] transition-colors"
                  >
                    <Star
                      className="w-4 h-4"
                      fill={capture.favorite ? 'currentColor' : 'none'}
                      style={{
                        color: capture.favorite ? 'var(--coral-400)' : 'var(--ink-subtle)',
                      }}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">
                    {capture.favorite ? 'Remove from favorites' : 'Add to favorites'}
                  </p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 transition-colors"
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
        </ContextMenuTrigger>
        <CaptureContextMenu
          favorite={capture.favorite}
          onCopyToClipboard={onCopyToClipboard}
          onOpenInFolder={onOpenInFolder}
          onToggleFavorite={onToggleFavorite}
          onDelete={onDelete}
        />
      </ContextMenu>
    );
  },
  capturePropsAreEqual
);
