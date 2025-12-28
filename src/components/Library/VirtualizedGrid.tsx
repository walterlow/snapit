import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CaptureListItem } from '../../types';
import { DateHeader, CaptureCard, CaptureRow } from './components';

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

// Row heights
const HEADER_HEIGHT = 56;
const CARD_ROW_HEIGHT = 280;
const LIST_ROW_HEIGHT = 64;

// Breakpoint-based columns (fewer transitions = smoother resize)
// Matches CSS breakpoints for consistency
const BREAKPOINTS = [
  { min: 1800, cols: 6 },
  { min: 1400, cols: 5 },
  { min: 1100, cols: 4 },
  { min: 800, cols: 3 },
  { min: 500, cols: 2 },
  { min: 0, cols: 1 },
];

function getColumnsForWidth(width: number): number {
  for (const bp of BREAKPOINTS) {
    if (width >= bp.min) return bp.cols;
  }
  return 1;
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

    const updateColumns = () => {
      const width = container.clientWidth;
      const cols = getColumnsForWidth(width);
      setCardsPerRow(prev => prev !== cols ? cols : prev);
    };

    updateColumns();

    const observer = new ResizeObserver(updateColumns);
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

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return CARD_ROW_HEIGHT;
      if (row.type === 'header') return HEADER_HEIGHT;
      return viewMode === 'list' ? LIST_ROW_HEIGHT : CARD_ROW_HEIGHT;
    },
    overscan: 5,
  });

  // Render row content
  const renderRowContent = useCallback(
    (row: VirtualRow) => {
      if (row.type === 'header') {
        return (
          <DateHeader
            label={row.label}
            count={row.count}
            isFirst={row.isFirst}
          />
        );
      }

      if (viewMode === 'list') {
        return row.captures.map((capture) => (
          <CaptureRow
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
        ));
      }

      return (
        <div
          className="grid gap-5"
          style={{ gridTemplateColumns: `repeat(${cardsPerRow}, minmax(0, 1fr))` }}
        >
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
      );
    },
    [
      viewMode,
      cardsPerRow,
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

  const virtualItems = virtualizer.getVirtualItems();

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
