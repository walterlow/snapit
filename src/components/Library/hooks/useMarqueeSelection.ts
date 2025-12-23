import { useState, useRef, useCallback, useEffect } from 'react';
import type { CaptureListItem } from '../../../types';

interface UseMarqueeSelectionProps {
  captures: CaptureListItem[];
  containerRef: React.RefObject<HTMLDivElement>;
  onOpenProject: (id: string) => void;
}

interface UseMarqueeSelectionReturn {
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  isSelecting: boolean;
  selectionRect: { left: number; top: number; width: number; height: number };
  handleMarqueeMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMarqueeMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMarqueeMouseUp: () => void;
  handleSelect: (id: string, event: React.MouseEvent) => void;
  clearSelection: () => void;
}

export function useMarqueeSelection({
  captures,
  containerRef,
  onOpenProject,
}: UseMarqueeSelectionProps): UseMarqueeSelectionReturn {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState({ x: 0, y: 0 });
  const [selectionCurrent, setSelectionCurrent] = useState({ x: 0, y: 0 });
  const [selectionStartIds, setSelectionStartIds] = useState<Set<string>>(new Set());
  const isShiftHeld = useRef(false);
  const lastClickedId = useRef<string | null>(null);

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

  // Find captures within selection rectangle
  const getSelectedCapturesInRect = useCallback(() => {
    if (!containerRef.current) return new Set<string>();

    const selectionRect = getSelectionRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    // Adjust selection rect to be relative to viewport
    const viewportSelectionRect = {
      left: selectionRect.left + containerRect.left,
      top: selectionRect.top + containerRect.top,
      width: selectionRect.width,
      height: selectionRect.height,
    };

    const selected = new Set<string>();
    const cards = containerRef.current.querySelectorAll('[data-capture-id]');

    cards.forEach((card) => {
      const cardRect = card.getBoundingClientRect();
      if (rectsIntersect(cardRect, viewportSelectionRect)) {
        const id = card.getAttribute('data-capture-id');
        if (id) selected.add(id);
      }
    });

    return selected;
  }, [containerRef, getSelectionRect, rectsIntersect]);

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
    [containerRef, selectedIds]
  );

  // Handle mouse move during selection
  const handleMarqueeMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelecting) return;

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
    [isSelecting, containerRef, getSelectedCapturesInRect, selectionStartIds]
  );

  // Handle mouse up to end selection
  const handleMarqueeMouseUp = useCallback(() => {
    if (!isSelecting) return;

    // If it was just a click (no drag), clear selection
    const rect = getSelectionRect();
    if (rect.width < 5 && rect.height < 5) {
      if (!isShiftHeld.current) {
        setSelectedIds(new Set());
      }
    }

    setIsSelecting(false);
  }, [isSelecting, getSelectionRect]);

  // Global mouse up listener to handle mouse up outside container
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isSelecting) {
        setIsSelecting(false);
      }
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isSelecting]);

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
        // Normal click: open project (if not missing)
        const capture = captures.find((c) => c.id === id);
        if (capture?.is_missing) {
          // Don't open missing captures - just select them
          setSelectedIds(new Set([id]));
        } else {
          onOpenProject(id);
        }
        lastClickedId.current = id;
      }
    },
    [captures, selectedIds, onOpenProject]
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
    clearSelection,
  };
}
