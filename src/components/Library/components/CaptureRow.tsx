import React, { memo, useState, useMemo, useEffect, useRef } from 'react';
import { Star, Trash2, Check, AlertTriangle, Loader2, Video, Film, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CaptureContextMenu } from './CaptureContextMenu';
import { TagChip } from './TagChip';
import { TagPopover } from './TagPopover';
import { useInViewAnimation, getCachedThumbnailUrl } from '../hooks';
import type { CaptureCardProps } from './types';
import { capturePropsAreEqual } from './types';

// Check if capture is a video or gif recording
const isVideoOrGif = (captureType: string) => captureType === 'video' || captureType === 'gif';

export const CaptureRow: React.FC<CaptureCardProps> = memo(
  ({
    capture,
    selected,
    isLoading,
    allTags,
    onSelect,
    onOpen,
    onToggleFavorite,
    onUpdateTags,
    onDelete,
    onOpenInFolder,
    onCopyToClipboard,
    onPlayMedia,
    formatDate,
  }) => {
    const [thumbLoaded, setThumbLoaded] = useState(false);
    const [thumbError, setThumbError] = useState(false);
    const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
    const { ref, isVisible } = useInViewAnimation();
    const isPlaceholder = capture.id.startsWith('temp_');
    const isMissing = capture.is_missing;
    const isMedia = isVideoOrGif(capture.capture_type);
    const hasThumbnail = capture.thumbnail_path && capture.thumbnail_path.length > 0;

    // Use cached URL to avoid repeated convertFileSrc calls
    const thumbnailSrc = useMemo(() => {
      if (isPlaceholder || isMissing || !hasThumbnail) return '';
      return getCachedThumbnailUrl(capture.thumbnail_path);
    }, [capture.thumbnail_path, isPlaceholder, isMissing, hasThumbnail]);

    // Key to force img remount when needed (fixes Activity visibility issue)
    const [imgKey, setImgKey] = useState(0);
    const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reset load state when thumbnail path changes
    useEffect(() => {
      setThumbLoaded(false);
      setThumbError(false);
      setImgKey(k => k + 1);
    }, [capture.thumbnail_path]);

    // Detect stale img that never loaded (Activity visibility issue)
    useEffect(() => {
      if (thumbnailSrc && !thumbLoaded && !thumbError) {
        loadTimeoutRef.current = setTimeout(() => {
          if (!thumbLoaded && !thumbError) {
            setImgKey(k => k + 1);
          }
        }, 500);
      }
      return () => {
        if (loadTimeoutRef.current) {
          clearTimeout(loadTimeoutRef.current);
        }
      };
    }, [thumbnailSrc, thumbLoaded, thumbError, imgKey]);

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
              ) : isPlaceholder ? (
                <div className="w-full h-full flex items-center justify-center bg-[var(--polar-mist)]">
                  <Loader2 className="w-5 h-5 text-[var(--ink-subtle)] animate-spin" />
                </div>
              ) : thumbError ? (
                <div className="w-full h-full flex items-center justify-center bg-[var(--polar-mist)]">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                </div>
              ) : (
                <>
                  {!thumbLoaded && (
                    <div className="absolute inset-0 bg-[var(--polar-mist)] animate-pulse rounded" />
                  )}
                  <img
                    key={imgKey}
                    src={thumbnailSrc}
                    alt="Capture"
                    onLoad={() => setThumbLoaded(true)}
                    onError={() => setThumbError(true)}
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
                {/* Display up to 4 tags in list view */}
                {capture.tags.slice(0, 4).map(tag => (
                  <TagChip key={tag} tag={tag} size="sm" />
                ))}
                {capture.tags.length > 4 && (
                  <span className="text-[10px] text-[var(--ink-muted)]">
                    +{capture.tags.length - 4}
                  </span>
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
              <TagPopover
                currentTags={capture.tags}
                allTags={allTags}
                onTagsChange={onUpdateTags}
                open={tagPopoverOpen}
                onOpenChange={setTagPopoverOpen}
                trigger={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--polar-mist)] transition-colors"
                      >
                        <Tag
                          className="w-4 h-4"
                          style={{
                            color: capture.tags.length > 0 ? 'var(--coral-400)' : 'var(--ink-subtle)',
                          }}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p className="text-xs">Manage tags</p>
                    </TooltipContent>
                  </Tooltip>
                }
              />
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
          onManageTags={() => setTagPopoverOpen(true)}
          onDelete={onDelete}
          onPlayMedia={onPlayMedia}
        />
      </ContextMenu>
    );
  },
  capturePropsAreEqual
);
