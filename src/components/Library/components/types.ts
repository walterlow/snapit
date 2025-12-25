import type { CaptureListItem } from '../../../types';

export interface CaptureCardProps {
  capture: CaptureListItem;
  selected: boolean;
  isLoading?: boolean; // True when this capture is being loaded into editor
  onSelect: (id: string, e: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onOpenInFolder: () => void;
  onCopyToClipboard: () => void;
  onPlayMedia?: () => void; // For video/gif - opens in system player
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
    prev.isLoading === next.isLoading
  );
};
