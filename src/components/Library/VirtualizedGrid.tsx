import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CaptureListItem } from '../../types';
import { DateHeader, CaptureCard, CaptureRow } from './components';
import { useThumbnailPrefetch } from './hooks';
import { LAYOUT } from '../../constants';

interface DateGroup {
  label: string;
  captures: CaptureListItem[];
}

// Row types for virtualization
type VirtualRow =
  | { type: 'header'; label: string; count: number; isFirst: boolean }
  | { type: 'cardRow'; captures: CaptureListItem[] };

interface VirtualizedGridProps {
  dateGroups: DateGroup[];
  viewMode: 'grid' | 'list';
  selectedIds: Set<string>;
  loadingProjectId: string | null;
  allTags: string[];
  onSelect: (id: string, e: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onUpdateTags: (id: string, tags: string[]) => void;
  onDelete: (id: string) => void;
  onOpenInFolder: (capture: CaptureListItem) => void;
  onCopyToClipboard: (capture: CaptureListItem) => void;
  onPlayMedia: (capture: CaptureListItem) => void;
  formatDate: (dateStr: string) => string;
  // Marquee selection props
  containerRef?: React.RefObject<HTMLDivElement>;
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp?: () => void;
  isSelecting?: boolean;
  selectionRect?: { left: number; top: number; width: number; height: number };
}

// Layout constants
const CARD_GAP = 20;
const CONTAINER_PADDING = 64; // px-8 on container + px-8 on rows
const FOOTER_HEIGHT = 80;
const MAX_CARD_WIDTH = 320; // Cards won't grow beyond this

// Column breakpoints: min 3, max 5 columns
// Cards resize to fill available width, capped at MAX_CARD_WIDTH
const COLUMN_BREAKPOINTS = [
  { minWidth: 1600, cols: 5 },
  { minWidth: 1200, cols: 4 },
  { minWidth: 0, cols: 3 },
];

export function getColumnsForWidth(width: number): number {
  for (const bp of COLUMN_BREAKPOINTS) {
    if (width >= bp.minWidth) return bp.cols;
  }
  return 3;
}

// Calculate card width to fit exactly N columns, capped at MAX_CARD_WIDTH
export function getCardWidth(containerWidth: number, columns: number): number {
  const availableWidth = containerWidth - CONTAINER_PADDING;
  const totalGaps = CARD_GAP * (columns - 1);
  const calculatedWidth = Math.floor((availableWidth - totalGaps) / columns);
  return Math.min(calculatedWidth, MAX_CARD_WIDTH);
}

// Calculate row height based on card width (16:9 thumbnail + footer)
// Gap is included in row height for predictable sizing during resize
export function calculateRowHeight(containerWidth: number, columns: number): number {
  const cardWidth = getCardWidth(containerWidth, columns);
  const thumbnailHeight = Math.round((cardWidth * 9) / 16);
  return thumbnailHeight + FOOTER_HEIGHT + CARD_GAP;
}

// Calculate total grid width (for centering headers and cards together)
export function getGridWidth(containerWidth: number, columns: number): number {
  const cardWidth = getCardWidth(containerWidth, columns);
  return columns * cardWidth + (columns - 1) * CARD_GAP;
}

export function VirtualizedGrid({
  dateGroups,
  viewMode,
  selectedIds,
  loadingProjectId,
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
  containerRef: externalContainerRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  isSelecting,
  selectionRect,
}: VirtualizedGridProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [cardsPerRow, setCardsPerRow] = useState(4);
  const [containerWidth, setContainerWidth] = useState(1200);

  // Sync external ref
  useEffect(() => {
    if (externalContainerRef && 'current' in externalContainerRef) {
      (externalContainerRef as React.MutableRefObject<HTMLDivElement | null>).current =
        scrollContainerRef.current;
    }
  });

  // Track container width for responsive layout (breakpoint-based)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || viewMode === 'list') return;

    const updateLayout = () => {
      const width = container.clientWidth;
      const cols = getColumnsForWidth(width);
      setCardsPerRow(prev => prev !== cols ? cols : prev);
      setContainerWidth(width);
    };

    updateLayout();

    const observer = new ResizeObserver(updateLayout);
    observer.observe(container);

    return () => observer.disconnect();
  }, [viewMode]);

  // Build rows: headers + card/list rows
  const rows = useMemo<VirtualRow[]>(() => {
    const result: VirtualRow[] = [];
    const itemsPerRow = viewMode === 'list' ? 1 : cardsPerRow;

    dateGroups.forEach((group, groupIndex) => {
      result.push({
        type: 'header',
        label: group.label,
        count: group.captures.length,
        isFirst: groupIndex === 0,
      });

      for (let i = 0; i < group.captures.length; i += itemsPerRow) {
        result.push({
          type: 'cardRow',
          captures: group.captures.slice(i, i + itemsPerRow),
        });
      }
    });

    return result;
  }, [dateGroups, cardsPerRow, viewMode]);

  // Calculate dynamic row height based on actual card dimensions
  const gridRowHeight = useMemo(
    () => calculateRowHeight(containerWidth, cardsPerRow),
    [containerWidth, cardsPerRow]
  );

  // Virtualizer with dynamic row heights based on card size
  // Gap is included in gridRowHeight for predictable resize behavior
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return gridRowHeight;
      if (row.type === 'header') return LAYOUT.HEADER_HEIGHT;
      return viewMode === 'list' ? LAYOUT.LIST_ROW_HEIGHT : gridRowHeight;
    },
    overscan: 5,
  });

  // Force virtualizer to recalculate when row height changes during resize
  useEffect(() => {
    virtualizer.measure();
  }, [gridRowHeight, virtualizer]);

  // Prefetch thumbnails for rows about to enter the viewport
  const virtualItems = virtualizer.getVirtualItems();
  const visibleRange = useMemo(() => ({
    startIndex: virtualItems[0]?.index ?? 0,
    endIndex: virtualItems[virtualItems.length - 1]?.index ?? 0,
  }), [virtualItems]);

  useThumbnailPrefetch(rows, visibleRange, 3);

  // Calculate grid width for centering (same width for headers and cards)
  const gridWidth = useMemo(
    () => getGridWidth(containerWidth, cardsPerRow),
    [containerWidth, cardsPerRow]
  );

  // Render row content
  const renderRowContent = useCallback(
    (row: VirtualRow) => {
      if (row.type === 'header') {
        return (
          <div className="mx-auto" style={{ width: gridWidth }}>
            <DateHeader
              label={row.label}
              count={row.count}
              isFirst={row.isFirst}
            />
          </div>
        );
      }

      if (viewMode === 'list') {
        // List view: single row per virtual item with proper spacing
        const capture = row.captures[0];
        if (!capture) return null;
        return (
          <div className="pb-2">
            <CaptureRow
              capture={capture}
              selected={selectedIds.has(capture.id)}
              isLoading={loadingProjectId === capture.id}
              allTags={allTags}
              onSelect={onSelect}
              onOpen={onOpen}
              onToggleFavorite={() => onToggleFavorite(capture.id)}
              onUpdateTags={(tags) => onUpdateTags(capture.id, tags)}
              onDelete={() => onDelete(capture.id)}
              onOpenInFolder={() => onOpenInFolder(capture)}
              onCopyToClipboard={() => onCopyToClipboard(capture)}
              onPlayMedia={() => onPlayMedia(capture)}
              formatDate={formatDate}
            />
          </div>
        );
      }

      const cardWidth = getCardWidth(containerWidth, cardsPerRow);

      return (
        <div className="flex gap-5 mx-auto" style={{ width: gridWidth }}>
          {row.captures.map((capture) => (
            <div key={capture.id} style={{ width: cardWidth, flexShrink: 0 }}>
              <CaptureCard
                capture={capture}
                selected={selectedIds.has(capture.id)}
                isLoading={loadingProjectId === capture.id}
                allTags={allTags}
                onSelect={onSelect}
                onOpen={onOpen}
                onToggleFavorite={() => onToggleFavorite(capture.id)}
                onUpdateTags={(tags) => onUpdateTags(capture.id, tags)}
                onDelete={() => onDelete(capture.id)}
                onOpenInFolder={() => onOpenInFolder(capture)}
                onCopyToClipboard={() => onCopyToClipboard(capture)}
                onPlayMedia={() => onPlayMedia(capture)}
                formatDate={formatDate}
              />
            </div>
          ))}
        </div>
      );
    },
    [
      viewMode,
      cardsPerRow,
      containerWidth,
      gridWidth,
      selectedIds,
      loadingProjectId,
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
    ]
  );

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-auto relative select-none library-scroll"
      style={{ contain: 'strict' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {isSelecting && selectionRect && (
        <div
          className="absolute pointer-events-none z-50 border-2 border-[var(--coral-400)] bg-[var(--coral-glow)] rounded-sm"
          style={{
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
          }}
        />
      )}

      <div
        className="relative w-full px-8"
        style={{ height: virtualizer.getTotalSize() + 128, paddingTop: 32 }}
      >
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;

          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 right-0 px-8"
              style={{
                top: virtualRow.start + 32,
                height: virtualRow.size,
              }}
            >
              {renderRowContent(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default VirtualizedGrid;
