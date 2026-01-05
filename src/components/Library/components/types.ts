import type { CaptureListItem } from '../../../types';

export interface CaptureCardProps {
  capture: CaptureListItem;
  selected: boolean;
  isLoading?: boolean; // True when this capture is being loaded into editor
  allTags: string[]; // All tags across library for autocomplete
  onSelect: (id: string, e: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onToggleFavorite: () => void;
  onUpdateTags: (tags: string[]) => void;
  onDelete: () => void;
  onOpenInFolder: () => void;
  onCopyToClipboard: () => void;
  onPlayMedia?: () => void; // For video/gif - opens in system player
  onEditVideo?: () => void; // For video - opens in video editor
  formatDate: (date: string) => string;
}

// Helper to compare tags arrays
const tagsEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((tag, i) => tag === b[i]);
};

// Custom comparison for memo - only re-render when capture data or selection changes
export const capturePropsAreEqual = (
  prev: CaptureCardProps,
  next: CaptureCardProps
): boolean => {
  return (
    prev.capture.id === next.capture.id &&
    prev.capture.favorite === next.capture.favorite &&
    prev.capture.thumbnail_path === next.capture.thumbnail_path &&
    tagsEqual(prev.capture.tags, next.capture.tags) &&
    prev.selected === next.selected &&
    prev.isLoading === next.isLoading
  );
};
