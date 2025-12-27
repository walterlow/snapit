import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Plus } from 'lucide-react';

interface TagInputProps {
  existingTags: string[];
  selectedTags: string[];
  onAddTag: (tag: string) => void;
  onEscapeEmpty?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export const TagInput: React.FC<TagInputProps> = ({
  existingTags,
  selectedTags,
  onAddTag,
  onEscapeEmpty,
  placeholder = 'Add tag...',
  autoFocus = false,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Filter suggestions: existing tags that aren't already selected and match input
  const suggestions = useMemo(() => {
    const normalizedInput = inputValue.toLowerCase().trim();
    return existingTags
      .filter(tag =>
        !selectedTags.includes(tag) &&
        tag.toLowerCase().includes(normalizedInput)
      )
      .slice(0, 8); // Limit to 8 suggestions
  }, [existingTags, selectedTags, inputValue]);

  // Check if we should show "Create new tag" option
  const showCreateOption = useMemo(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return false;
    const normalizedInput = trimmed.toLowerCase();
    // Show create if input doesn't exactly match any existing tag
    return !existingTags.some(tag => tag.toLowerCase() === normalizedInput) &&
           !selectedTags.includes(trimmed);
  }, [inputValue, existingTags, selectedTags]);

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [suggestions, showCreateOption]);

  // Auto focus
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  const handleAddTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !selectedTags.includes(trimmed)) {
      onAddTag(trimmed);
      setInputValue('');
      setIsOpen(false);
      inputRef.current?.focus();
    }
  };

  const totalItems = suggestions.length + (showCreateOption ? 1 : 0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!inputValue.trim() && onEscapeEmpty) {
        // Input is empty, close the popover
        onEscapeEmpty();
      } else {
        // Clear input and close dropdown
        setIsOpen(false);
        setInputValue('');
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(true);
      setHighlightedIndex(prev =>
        prev < totalItems - 1 ? prev + 1 : 0
      );
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setHighlightedIndex(prev =>
        prev > 0 ? prev - 1 : totalItems - 1
      );
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const trimmedInput = inputValue.trim();

      // If there are suggestions and dropdown is open, use highlighted item
      if (isOpen && suggestions.length > 0 && highlightedIndex < suggestions.length) {
        handleAddTag(suggestions[highlightedIndex]);
      } else if (trimmedInput) {
        // Otherwise, just add the typed input directly
        handleAddTag(trimmedInput);
      }
      return;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setIsOpen(true);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          // Delay to allow click on suggestions
          setTimeout(() => setIsOpen(false), 150);
        }}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm rounded-md border border-[var(--polar-frost)]
          bg-[var(--card)] text-[var(--ink-base)]
          placeholder:text-[var(--ink-muted)]
          focus:outline-none"
      />

      {/* Suggestions dropdown */}
      {isOpen && totalItems > 0 && (
        <ul
          ref={listRef}
          className="absolute top-full left-0 right-0 mt-1 py-1
            bg-[var(--card)] border border-[var(--polar-frost)] rounded-md shadow-lg
            max-h-48 overflow-y-auto z-50"
        >
          {suggestions.map((tag, index) => (
            <li
              key={tag}
              onClick={() => handleAddTag(tag)}
              className={`
                px-3 py-1.5 text-sm cursor-pointer transition-colors
                ${index === highlightedIndex
                  ? 'bg-[var(--polar-mist)] text-[var(--ink-base)]'
                  : 'text-[var(--ink-subtle)] hover:bg-[var(--polar-mist)]'
                }
              `}
            >
              {tag}
            </li>
          ))}
          {showCreateOption && (
            <li
              onClick={() => handleAddTag(inputValue.trim())}
              className={`
                px-3 py-1.5 text-sm cursor-pointer transition-colors flex items-center gap-2
                ${highlightedIndex === suggestions.length
                  ? 'bg-[var(--coral-subtle)] text-[var(--coral-400)]'
                  : 'text-[var(--coral-400)] hover:bg-[var(--coral-subtle)]'
                }
              `}
            >
              <Plus className="w-3.5 h-3.5" />
              Create "{inputValue.trim()}"
            </li>
          )}
        </ul>
      )}
    </div>
  );
};
