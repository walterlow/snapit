import React, { memo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Star, Trash2, Check, AlertTriangle, Loader2, Video, Film } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CaptureContextMenu } from './CaptureContextMenu';
import { useInViewAnimation } from '../hooks';
import type { CaptureCardProps } from './types';
import { capturePropsAreEqual } from './types';

// Check if capture is a video or gif recording
const isVideoOrGif = (captureType: string) => captureType === 'video' || captureType === 'gif';

export const CaptureRow: React.FC<CaptureCardProps> = memo(
  ({
    capture,
    selected,
    isLoading,
    onSelect,
    onOpen,
    onToggleFavorite,
    onDelete,
    onOpenInFolder,
    onCopyToClipboard,
    onPlayMedia,
    formatDate,
  }) => {
    const [thumbLoaded, setThumbLoaded] = useState(false);
    const { ref, isVisible } = useInViewAnimation();
    const isMissing = capture.is_missing;
    const isMedia = isVideoOrGif(capture.capture_type);
    const hasThumbnail = capture.thumbnail_path && capture.thumbnail_path.length > 0;
    const thumbnailSrc = isMissing || !hasThumbnail ? '' : convertFileSrc(capture.thumbnail_path);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            className={`capture-row group ${selected ? 'selected' : ''} ${isVisible ? 'in-view' : ''}`}
            data-capture-id={capture.id}
            onClick={(e) => onSelect(capture.id, e)}
            onDoubleClick={() => onOpen(capture.id)}
            onContextMenu={(e) => {
              // Select on right-click if not already selected
              if (!selected) {
                onSelect(capture.id, e);
              }
            }}
          >
            {/* Checkbox */}
            <div className={`checkbox-custom ${selected ? 'checked' : ''}`}>
              {selected && <Check className="w-3 h-3" />}
            </div>

            {/* Thumbnail */}
            <div className={`row-thumbnail relative ${isMissing ? 'opacity-60' : ''}`}>
              {isMissing ? (
                <div className="w-full h-full flex items-center justify-center bg-[var(--polar-mist)]">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
              ) : isMedia && !hasThumbnail ? (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[var(--polar-mist)] to-[var(--polar-frost)]">
                  {capture.capture_type === 'gif' ? (
                    <Film className="w-6 h-6 text-purple-400" />
                  ) : (
                    <Video className="w-6 h-6 text-blue-400" />
                  )}
                </div>
              ) : (
                <>
                  {!thumbLoaded && (
                    <div className="absolute inset-0 bg-[var(--polar-mist)] animate-pulse rounded" />
                  )}
                  <img
                    src={thumbnailSrc}
                    alt="Capture"
                    loading="lazy"
                    onLoad={() => setThumbLoaded(true)}
                    className={`transition-opacity duration-200 ${thumbLoaded ? 'opacity-100' : 'opacity-0'}`}
                  />
                </>
              )}
              {/* Loading Overlay */}
              {isLoading && (
                <div className="absolute inset-0 bg-[var(--card)]/95 flex items-center justify-center rounded animate-fade-in">
                  <Loader2 className="w-4 h-4 text-[var(--coral-400)] animate-spin" />
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-sm font-medium capitalize ${isMissing ? 'text-[var(--ink-subtle)]' : 'text-[var(--ink-black)]'}`}>
                  {capture.capture_type} capture
                </span>
                {isMissing && (
                  <Badge className="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5">Missing</Badge>
                )}
                {capture.has_annotations && !isMissing && (
                  <Badge className="pill-coral text-[10px] px-2 py-0.5">Edited</Badge>
                )}
              </div>
              <div className="text-xs text-[var(--ink-subtle)] font-mono">
                {isMedia && capture.dimensions.width === 0 
                  ? capture.capture_type.toUpperCase()
                  : `${capture.dimensions.width} × ${capture.dimensions.height}`}
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
          isMissing={isMissing}
          captureType={capture.capture_type}
          onCopyToClipboard={onCopyToClipboard}
          onOpenInFolder={onOpenInFolder}
          onToggleFavorite={onToggleFavorite}
          onDelete={onDelete}
          onPlayMedia={onPlayMedia}
        />
      </ContextMenu>
    );
  },
  capturePropsAreEqual
);
