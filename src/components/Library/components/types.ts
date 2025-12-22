import type { CaptureListItem } from '../../../types';

export interface CaptureCardProps {
  capture: CaptureListItem;
  selected: boolean;
  staggerIndex?: number;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onOpenInFolder: () => void;
  onCopyToClipboard: () => void;
  formatDate: (date: string) => string;
}

// Custom comparison for memo - only re-render when capture data or selection changes
export const capturePropsAreEqual = (
  prev: CaptureCardProps,
  next: CaptureCardProps
): boolean => {
  return (
    prev.capture.id === next.capture.id &&
    prev.capture.favorite === next.capture.favorite &&
    prev.capture.thumbnail_path === next.capture.thumbnail_path &&
    prev.selected === next.selected &&
    prev.staggerIndex === next.staggerIndex
  );
};
