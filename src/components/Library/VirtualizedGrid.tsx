import { useRef, useMemo, useCallback, useState, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CaptureListItem } from '../../types';
import { DateHeader, CaptureCard, CaptureRow } from './components';
import { useMomentumScroll } from './hooks';

interface DateGroup {
  label: string;
  captures: CaptureListItem[];
}

// Virtual row types
type VirtualRow =
  | { type: 'header'; label: string; count: number; isFirst: boolean }
  | { type: 'grid-row'; captures: CaptureListItem[] }
  | { type: 'list-item'; capture: CaptureListItem };

// Layout constants
const HEADER_HEIGHT = 56; // Date header height in px
const LIST_ITEM_HEIGHT = 80; // Height of a list row + spacing
const GRID_GAP = 20; // Gap between grid items (matches CSS 1.25rem)
const MIN_CARD_WIDTH = 240; // Minimum card width (matches CSS minmax)
const CONTAINER_PADDING = 64; // Container padding (p-8 = 32px * 2)
const CARD_FOOTER_HEIGHT = 85; // Card footer (padding + text + badges + tags + wrap buffer)
const CARD_ASPECT_RATIO = 9 / 16; // Thumbnail aspect ratio (16:9)
const ROW_SPACING = 24; // Vertical spacing between rows

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
  const internalRef = useRef<HTMLDivElement>(null);
  const parentRef = externalContainerRef || internalRef;
  const [containerWidth, setContainerWidth] = useState(0);

  // Apply momentum scrolling to virtualized container
  useMomentumScroll(parentRef);

  // Calculate cards per row for a given width
  const calculateCardsPerRow = useCallback((width: number) => {
    if (width === 0) return 4;
    const availableWidth = width - CONTAINER_PADDING;
    const count = Math.floor((availableWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP));
    return Math.max(1, count);
  }, []);

  // Calculate actual card width based on container width and column count
  const calculateCardWidth = useCallback((width: number, columns: number) => {
    if (width === 0 || columns === 0) return MIN_CARD_WIDTH;
    const availableWidth = width - CONTAINER_PADDING;
    const totalGaps = GRID_GAP * (columns - 1);
    return (availableWidth - totalGaps) / columns;
  }, []);

  // Calculate grid row height from card width (thumbnail + footer + spacing)
  const calculateGridRowHeight = useCallback((cardWidth: number) => {
    const thumbnailHeight = cardWidth * CARD_ASPECT_RATIO;
    const cardHeight = thumbnailHeight + CARD_FOOTER_HEIGHT;
    return Math.ceil(cardHeight + ROW_SPACING);
  }, []);

  // Track container width for responsive grid calculation
  // Debounce updates - only recalculate after resize stops for smoother performance
  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastColumnCount = calculateCardsPerRow(container.clientWidth);

    const updateWidth = () => {
      const newWidth = container.clientWidth;
      const newColumnCount = calculateCardsPerRow(newWidth);

      // Only update if column count changed - this is what actually affects layout
      if (newColumnCount !== lastColumnCount) {
        lastColumnCount = newColumnCount;
        setContainerWidth(newWidth);
      }
    };

    // Initial width
    setContainerWidth(container.clientWidth);

    const resizeObserver = new ResizeObserver(() => {
      // Debounce: wait 150ms after resize stops before recalculating
      // This lets CSS handle intermediate states smoothly
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(updateWidth, 150);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [calculateCardsPerRow]);

  // Calculate how many cards fit per row based on container width
  // This matches the CSS: grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))
  const cardsPerRow = useMemo(() => {
    return calculateCardsPerRow(containerWidth);
  }, [containerWidth, calculateCardsPerRow]);

  // Calculate dynamic grid row height based on actual card width
  const gridRowHeight = useMemo(() => {
    const cardWidth = calculateCardWidth(containerWidth, cardsPerRow);
    return calculateGridRowHeight(cardWidth);
  }, [containerWidth, cardsPerRow, calculateCardWidth, calculateGridRowHeight]);

  // Flatten date groups into virtual rows
  const virtualRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = [];

    dateGroups.forEach((group, groupIndex) => {
      // Add header row
      rows.push({
        type: 'header',
        label: group.label,
        count: group.captures.length,
        isFirst: groupIndex === 0,
      });

      if (viewMode === 'grid') {
        // Split captures into rows based on dynamic cardsPerRow
        for (let i = 0; i < group.captures.length; i += cardsPerRow) {
          rows.push({
            type: 'grid-row',
            captures: group.captures.slice(i, i + cardsPerRow),
          });
        }
      } else {
        // Each capture is its own row in list view
        group.captures.forEach((capture) => {
          rows.push({
            type: 'list-item',
            capture,
          });
        });
      }
    });

    return rows;
  }, [dateGroups, viewMode, cardsPerRow]);

  // Estimate row height based on type (uses dynamic gridRowHeight for responsive sizing)
  const estimateSize = useCallback(
    (index: number) => {
      const row = virtualRows[index];
      if (!row) return 100;

      switch (row.type) {
        case 'header':
          return HEADER_HEIGHT;
        case 'grid-row':
          return gridRowHeight;
        case 'list-item':
          return LIST_ITEM_HEIGHT;
        default:
          return 100;
      }
    },
    [virtualRows, gridRowHeight]
  );

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 3, // Render 3 extra items above/below viewport
  });

  // Re-measure virtualizer when grid row height changes (responsive resize)
  useEffect(() => {
    virtualizer.measure();
  }, [gridRowHeight, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-auto p-8 pb-32 relative select-none library-scroll"
      style={{ contain: 'strict' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* Marquee Selection Rectangle */}
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
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map((virtualRow) => {
          const row = virtualRows[virtualRow.index];
          if (!row) return null;

          // Use calculated height based on row type (gridRowHeight is dynamic based on container width)
          const rowHeight = row.type === 'header' ? HEADER_HEIGHT
            : row.type === 'grid-row' ? gridRowHeight
            : LIST_ITEM_HEIGHT;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: rowHeight,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.type === 'header' && (
                <DateHeader
                  label={row.label}
                  count={row.count}
                  isFirst={row.isFirst}
                />
              )}
              {row.type === 'grid-row' && (
                <div className="capture-grid">
                  {row.captures.map((capture) => (
                    <CaptureCard
                      key={capture.id}
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
                  ))}
                </div>
              )}
              {row.type === 'list-item' && (
                <CaptureRow
                  capture={row.capture}
                  selected={selectedIds.has(row.capture.id)}
                  isLoading={loadingProjectId === row.capture.id}
                  allTags={allTags}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onToggleFavorite={() => onToggleFavorite(row.capture.id)}
                  onUpdateTags={(tags) => onUpdateTags(row.capture.id, tags)}
                  onDelete={() => onDelete(row.capture.id)}
                  onOpenInFolder={() => onOpenInFolder(row.capture)}
                  onCopyToClipboard={() => onCopyToClipboard(row.capture)}
                  onPlayMedia={() => onPlayMedia(row.capture)}
                  formatDate={formatDate}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default VirtualizedGrid;
