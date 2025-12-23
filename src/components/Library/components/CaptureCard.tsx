import React, { memo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Star, Trash2, Check, Loader2, AlertTriangle } from 'lucide-react';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CaptureContextMenu } from './CaptureContextMenu';
import { useInViewAnimation } from '../hooks';
import type { CaptureCardProps } from './types';
import { capturePropsAreEqual } from './types';

export const CaptureCard: React.FC<CaptureCardProps> = memo(
  ({
    capture,
    selected,
    isLoading,
    onSelect,
    onToggleFavorite,
    onDelete,
    onOpenInFolder,
    onCopyToClipboard,
    formatDate,
  }) => {
    const [thumbLoaded, setThumbLoaded] = useState(false);
    const { ref, isVisible } = useInViewAnimation();

    // Check if this is a placeholder (optimistic update, saving in progress)
    const isPlaceholder = capture.id.startsWith('temp_') || !capture.thumbnail_path;
    const isMissing = capture.is_missing;
    const thumbnailSrc = isPlaceholder || isMissing ? '' : convertFileSrc(capture.thumbnail_path);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            className={`capture-card group ${selected ? 'selected' : ''} ${isVisible ? 'in-view' : ''}`}
            data-capture-id={capture.id}
            onClick={(e) => onSelect(capture.id, e)}
          >
            {/* Thumbnail */}
            <div className={`thumbnail ${isMissing ? 'opacity-60' : ''}`}>
              {isPlaceholder ? (
                <div className="w-full h-full flex items-center justify-center bg-[var(--polar-mist)]">
                  <Loader2 className="w-8 h-8 text-[var(--ink-subtle)] animate-spin" />
                </div>
              ) : isMissing ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-[var(--polar-mist)] gap-2">
                  <AlertTriangle className="w-8 h-8 text-amber-500" />
                  <span className="text-xs text-[var(--ink-subtle)]">File missing</span>
                </div>
              ) : (
                <>
                  {/* Skeleton placeholder until image loads */}
                  {!thumbLoaded && (
                    <div className="absolute inset-0 bg-[var(--polar-mist)] animate-pulse" />
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

              {/* Loading Overlay - shown when opening this capture */}
              {isLoading && (
                <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center z-10 animate-fade-in">
                  <Loader2 className="w-6 h-6 text-[var(--coral-400)] animate-spin" />
                </div>
              )}
            </div>

            {/* Card Footer */}
            <div className="card-footer flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--ink-subtle)]">
                  {isPlaceholder ? 'Saving...' : formatDate(capture.created_at)}
                </span>
                <span className="pill font-mono text-[10px]">
                  {isPlaceholder ? '-- × --' : `${capture.dimensions.width} × ${capture.dimensions.height}`}
                </span>
              </div>
              {!isPlaceholder && (
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
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <CaptureContextMenu
          favorite={capture.favorite}
          isMissing={isMissing}
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
