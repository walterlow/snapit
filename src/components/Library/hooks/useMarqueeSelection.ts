import { useState, useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CaptureListItem } from '../../../types';

export interface VirtualLayoutInfo {
  viewMode: 'grid' | 'list';
  cardsPerRow: number;
  gridRowHeight: number;
  listRowHeight: number;
  cardWidth: number;
  headerHeight: number;
  gridGap: number;
  // Layout offsets to match VirtualizedGrid positioning
  contentOffsetY: number; // vertical offset from `top: virtualRow.start + 32` in VirtualizedGrid
  contentOffsetX: number; // horizontal padding (px-8 = 32px) on virtual items
  dateGroups: { label: string; captures: CaptureListItem[] }[];
}

interface UseMarqueeSelectionProps {
  captures: CaptureListItem[];
  containerRef: React.RefObject<HTMLDivElement>;
  onOpenProject: (id: string) => void;
  virtualLayout?: VirtualLayoutInfo; // Optional for virtualized grids
}

// Check if capture is a video or gif recording
const isVideoOrGif = (captureType: string) => captureType === 'video' || captureType === 'gif';

interface UseMarqueeSelectionReturn {
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  isSelecting: boolean;
  selectionRect: { left: number; top: number; width: number; height: number };
  handleMarqueeMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMarqueeMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMarqueeMouseUp: () => void;
  handleSelect: (id: string, event: React.MouseEvent) => void;
  handleOpen: (id: string) => void;
  clearSelection: () => void;
}

export function useMarqueeSelection({
  captures,
  containerRef,
  onOpenProject,
  virtualLayout,
}: UseMarqueeSelectionProps): UseMarqueeSelectionReturn {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelectingState] = useState(false);
  const [selectionStart, setSelectionStart] = useState({ x: 0, y: 0 });
  const [selectionCurrent, setSelectionCurrent] = useState({ x: 0, y: 0 });
  const [selectionStartIds, setSelectionStartIds] = useState<Set<string>>(new Set());
  const isShiftHeld = useRef(false);
  const lastClickedId = useRef<string | null>(null);
  
  // Ref to track latest isSelecting value - updated synchronously to avoid stale closures
  const isSelectingRef = useRef(false);
  
  // Wrapper that updates both ref (sync) and state (async) together
  const setIsSelecting = useCallback((value: boolean) => {
    isSelectingRef.current = value; // Sync update for event handlers
    setIsSelectingState(value);     // Async update for React renders
  }, []);

  // Calculate selection rectangle bounds (handles any drag direction)
  const getSelectionRect = useCallback(() => {
    const left = Math.min(selectionStart.x, selectionCurrent.x);
    const top = Math.min(selectionStart.y, selectionCurrent.y);
    const width = Math.abs(selectionCurrent.x - selectionStart.x);
    const height = Math.abs(selectionCurrent.y - selectionStart.y);
    return { left, top, width, height };
  }, [selectionStart, selectionCurrent]);

  // Check if two rectangles intersect
  const rectsIntersect = useCallback(
    (r1: DOMRect, r2: { left: number; top: number; width: number; height: number }) => {
      return !(
        r1.right < r2.left ||
        r1.left > r2.left + r2.width ||
        r1.bottom < r2.top ||
        r1.top > r2.top + r2.height
      );
    },
    []
  );

  // Calculate virtual bounds for a capture based on layout info
  const getVirtualCaptureBounds = useCallback(
    (captureId: string): { left: number; top: number; width: number; height: number } | null => {
      if (!virtualLayout) return null;

      const {
        viewMode, cardsPerRow, gridRowHeight, listRowHeight,
        cardWidth, headerHeight, gridGap,
        contentOffsetX, contentOffsetY, dateGroups
      } = virtualLayout;

      // Start Y at the content offset (accounts for paddingTop + positioning in VirtualizedGrid)
      let currentY = contentOffsetY;

      for (const group of dateGroups) {
        // Add header height
        currentY += headerHeight;

        // Find capture in this group
        const captureIndex = group.captures.findIndex(c => c.id === captureId);
        if (captureIndex !== -1) {
          if (viewMode === 'list') {
            // List view: single column, each row is one capture
            const rowHeight = listRowHeight;
            const LIST_ITEM_GAP = 8; // pb-2 class in VirtualizedGrid list rendering
            const itemHeight = rowHeight - LIST_ITEM_GAP;

            return {
              left: contentOffsetX,
              top: currentY + captureIndex * rowHeight,
              width: cardWidth,
              height: itemHeight,
            };
          } else {
            // Grid view: multiple columns
            const row = Math.floor(captureIndex / cardsPerRow);
            const col = captureIndex % cardsPerRow;
            const GRID_ROW_SPACING = 24; // ROW_SPACING constant from VirtualizedGrid
            const cardHeight = gridRowHeight - GRID_ROW_SPACING;

            return {
              left: contentOffsetX + col * (cardWidth + gridGap),
              top: currentY + row * gridRowHeight,
              width: cardWidth,
              height: cardHeight,
            };
          }
        }

        // Move past this group's rows
        if (viewMode === 'list') {
          currentY += group.captures.length * listRowHeight;
        } else {
          const rowCount = Math.ceil(group.captures.length / cardsPerRow);
          currentY += rowCount * gridRowHeight;
        }
      }

      return null;
    },
    [virtualLayout]
  );

  // Find captures within selection rectangle
  const getSelectedCapturesInRect = useCallback(() => {
    if (!containerRef.current) return new Set<string>();

    const container = containerRef.current;
    const selectionRect = getSelectionRect();
    const selected = new Set<string>();

    // Use virtual layout calculation if available (for virtualized grids)
    if (virtualLayout) {
      // Selection rect is already in content coordinates
      for (const capture of captures) {
        const bounds = getVirtualCaptureBounds(capture.id);
        if (bounds) {
          // Check intersection with selection rect (both in content coordinates)
          const intersects = !(
            bounds.left + bounds.width < selectionRect.left ||
            bounds.left > selectionRect.left + selectionRect.width ||
            bounds.top + bounds.height < selectionRect.top ||
            bounds.top > selectionRect.top + selectionRect.height
          );
          if (intersects) {
            selected.add(capture.id);
          }
        }
      }
      return selected;
    }

    // Fallback to DOM-based detection for non-virtualized grids
    const containerRect = container.getBoundingClientRect();

    // Convert selection rect from content coordinates to viewport coordinates
    const viewportSelectionRect = {
      left: selectionRect.left + containerRect.left - container.scrollLeft,
      top: selectionRect.top + containerRect.top - container.scrollTop,
      width: selectionRect.width,
      height: selectionRect.height,
    };

    const cards = container.querySelectorAll('[data-capture-id]');

    cards.forEach((card) => {
      const cardRect = card.getBoundingClientRect();
      if (rectsIntersect(cardRect, viewportSelectionRect)) {
        const id = card.getAttribute('data-capture-id');
        if (id) selected.add(id);
      }
    });

    return selected;
  }, [containerRef, getSelectionRect, rectsIntersect, virtualLayout, captures, getVirtualCaptureBounds]);

  // Handle mouse down on container
  const handleMarqueeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only start marquee on left click and on empty space
      if (e.button !== 0) return;

      // Don't start marquee if clicking on a card or button
      const target = e.target as HTMLElement;
      if (target.closest('[data-capture-id]') || target.closest('button')) {
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const x = e.clientX - containerRect.left + container.scrollLeft;
      const y = e.clientY - containerRect.top + container.scrollTop;

      isShiftHeld.current = e.shiftKey;
      setSelectionStartIds(e.shiftKey ? new Set(selectedIds) : new Set());
      setSelectionStart({ x, y });
      setSelectionCurrent({ x, y });
      setIsSelecting(true);

      // Prevent text selection
      e.preventDefault();
    },
    [containerRef, selectedIds, setIsSelecting]
  );

  // Handle mouse move during selection
  const handleMarqueeMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Use ref to avoid stale closure
      if (!isSelectingRef.current) return;

      const container = containerRef.current;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const x = e.clientX - containerRect.left + container.scrollLeft;
      const y = e.clientY - containerRect.top + container.scrollTop;

      setSelectionCurrent({ x, y });

      // Update selection in real-time
      const inRect = getSelectedCapturesInRect();
      if (isShiftHeld.current) {
        // Add to existing selection
        const combined = new Set([...selectionStartIds, ...inRect]);
        setSelectedIds(combined);
      } else {
        setSelectedIds(inRect);
      }
    },
    [containerRef, getSelectedCapturesInRect, selectionStartIds]
  );

  // Handle mouse up to end selection
  const handleMarqueeMouseUp = useCallback(() => {
    // Use ref to avoid stale closure - isSelecting state may not be updated yet
    if (!isSelectingRef.current) return;

    // If it was just a click (no drag), clear selection
    const rect = getSelectionRect();
    if (rect.width < 5 && rect.height < 5) {
      if (!isShiftHeld.current) {
        setSelectedIds(new Set());
      }
    }

    setIsSelecting(false);
  }, [getSelectionRect, setIsSelecting]);

  // Global mouse up listener to handle mouse up outside container
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      // Use ref to avoid stale closure - always check the latest value
      if (isSelectingRef.current) {
        setIsSelecting(false);
      }
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [setIsSelecting]);

  // Handle individual card selection (click, ctrl+click, shift+click)
  const handleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      if (event.shiftKey && lastClickedId.current) {
        // Shift+click: select range from last clicked to current
        const lastIndex = captures.findIndex((c) => c.id === lastClickedId.current);
        const currentIndex = captures.findIndex((c) => c.id === id);

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeIds = captures.slice(start, end + 1).map((c) => c.id);

          // Add to existing selection or create new
          const newSelected =
            event.ctrlKey || event.metaKey
              ? new Set([...selectedIds, ...rangeIds])
              : new Set(rangeIds);
          setSelectedIds(newSelected);
        }
      } else if (event.ctrlKey || event.metaKey) {
        // Ctrl/Cmd+click: toggle selection
        const newSelected = new Set(selectedIds);
        if (newSelected.has(id)) {
          newSelected.delete(id);
        } else {
          newSelected.add(id);
        }
        setSelectedIds(newSelected);
        lastClickedId.current = id;
      } else {
        // Normal click: select the card
        setSelectedIds(new Set([id]));
        lastClickedId.current = id;
      }
    },
    [captures, selectedIds]
  );

  // Handle double-click to open project
  const handleOpen = useCallback(
    async (id: string) => {
      const capture = captures.find((c) => c.id === id);
      if (!capture || capture.is_missing) return; // Don't open missing captures
      
      // Videos/GIFs open in system default player
      if (isVideoOrGif(capture.capture_type)) {
        try {
          await invoke('open_file_with_default_app', { path: capture.image_path });
        } catch (error) {
          console.error('Failed to open file:', error);
        }
        return;
      }
      
      // Screenshots open in editor
      onOpenProject(id);
    },
    [captures, onOpenProject]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  return {
    selectedIds,
    setSelectedIds,
    isSelecting,
    selectionRect: getSelectionRect(),
    handleMarqueeMouseDown,
    handleMarqueeMouseMove,
    handleMarqueeMouseUp,
    handleSelect,
    handleOpen,
    clearSelection,
  };
}
