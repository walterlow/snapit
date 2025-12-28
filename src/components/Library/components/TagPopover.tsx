import React from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { TagChip } from './TagChip';
import { TagInput } from './TagInput';

interface TagPopoverProps {
  currentTags: string[];
  allTags: string[];
  onTagsChange: (tags: string[]) => void;
  trigger: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const TagPopover: React.FC<TagPopoverProps> = ({
  currentTags,
  allTags,
  onTagsChange,
  trigger,
  align = 'start',
  side = 'bottom',
  open,
  onOpenChange,
}) => {
  const handleAddTag = (tag: string) => {
    if (!currentTags.includes(tag)) {
      onTagsChange([...currentTags, tag]);
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onTagsChange(currentTags.filter(tag => tag !== tagToRemove));
  };

  // Build props for controlled or uncontrolled mode
  const popoverProps = open !== undefined ? { open, onOpenChange } : {};

  return (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        className="w-64 p-3"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="space-y-3">
          <TagInput
            existingTags={allTags}
            selectedTags={currentTags}
            onAddTag={handleAddTag}
            onEscapeEmpty={() => onOpenChange?.(false)}
            autoFocus
          />

          {currentTags.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[10px] font-medium text-[var(--ink-muted)] uppercase tracking-wide">
                Current tags
              </span>
              <div className="flex flex-wrap gap-1.5">
                {currentTags.map(tag => (
                  <TagChip
                    key={tag}
                    tag={tag}
                    size="md"
                    onRemove={() => handleRemoveTag(tag)}
                  />
                ))}
              </div>
            </div>
          )}

          {currentTags.length === 0 && (
            <p className="text-xs text-[var(--ink-muted)] text-center py-2">
              No tags yet. Type to add one.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
