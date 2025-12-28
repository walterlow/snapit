import React from 'react';
import { X } from 'lucide-react';

interface TagChipProps {
  tag: string;
  onRemove?: () => void;
  onClick?: () => void;
  selected?: boolean;
  size?: 'sm' | 'md';
}

export const TagChip: React.FC<TagChipProps> = ({
  tag,
  onRemove,
  onClick,
  selected = false,
  size = 'sm',
}) => {
  const sizeClasses = size === 'sm'
    ? 'text-[10px] px-1.5 py-0.5 gap-0.5'
    : 'text-xs px-2 py-1 gap-1';

  return (
    <span
      className={`
        inline-flex items-center rounded-md font-medium transition-colors
        ${sizeClasses}
        ${selected
          ? 'bg-[var(--coral-subtle)] text-[var(--coral-400)] border border-[var(--coral-200)]'
          : 'bg-[var(--polar-mist)] text-[var(--ink-subtle)] border border-[var(--polar-frost)]'
        }
        ${onClick ? 'cursor-pointer hover:bg-[var(--polar-frost)]' : ''}
      `}
      onClick={onClick}
    >
      <span className="truncate max-w-[80px]">{tag}</span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex-shrink-0 rounded-sm hover:bg-black/10 p-0.5 -mr-0.5"
          aria-label={`Remove tag: ${tag}`}
        >
          <X className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
        </button>
      )}
    </span>
  );
};
