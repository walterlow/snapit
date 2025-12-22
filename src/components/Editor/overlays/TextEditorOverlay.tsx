import React, { useEffect, useRef, useCallback } from 'react';

interface TextEditorOverlayProps {
  position: {
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
    fontFamily: string;
    fontStyle: string;
    textDecoration: string;
    align: string;
    verticalAlign: string;
    color: string;
  } | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Fixed-position contenteditable overlay for inline text editing
 * Supports vertical alignment via flexbox
 */
export const TextEditorOverlay: React.FC<TextEditorOverlayProps> = React.memo(({
  position,
  value,
  onChange,
  onSave,
  onCancel,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const initializedRef = useRef(false);

  // Focus and set cursor at end
  const focusAndSetCursor = useCallback((element: HTMLDivElement) => {
    element.focus();

    // Set cursor at end - need to create range after content exists
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false); // collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  // Initialize when editor opens
  useEffect(() => {
    const isOpen = position !== null;
    const justOpened = isOpen && !wasOpenRef.current;
    const justClosed = !isOpen && wasOpenRef.current;

    wasOpenRef.current = isOpen;

    if (justClosed) {
      initializedRef.current = false;
    }

    if (justOpened) {
      initializedRef.current = false;
    }
  }, [position]);

  // Handle initialization after render
  useEffect(() => {
    if (position && editorRef.current && !initializedRef.current) {
      initializedRef.current = true;
      const element = editorRef.current;

      // Set content - use textContent to avoid HTML issues
      // Add zero-width space if empty to ensure cursor shows
      element.textContent = value || '\u200B';

      // Focus with multiple attempts for reliability
      requestAnimationFrame(() => {
        if (element) {
          focusAndSetCursor(element);
          // Second attempt after a short delay
          setTimeout(() => {
            if (element && document.activeElement !== element) {
              focusAndSetCursor(element);
            }
          }, 50);
        }
      });
    }
  }, [position, value, focusAndSetCursor]);

  // Stop all events from bubbling
  const stopPropagation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }, [onSave, onCancel]);

  const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    let text = target.textContent || '';
    // Remove zero-width space if user has typed something
    if (text === '\u200B') text = '';
    onChange(text.replace(/\u200B/g, ''));
  }, [onChange]);

  if (!position) return null;

  // Map fontStyle to CSS
  const isBold = position.fontStyle.includes('bold');
  const isItalic = position.fontStyle.includes('italic');

  // Map verticalAlign to flexbox
  const getVerticalAlign = (vAlign: string) => {
    switch (vAlign) {
      case 'middle': return 'center';
      case 'bottom': return 'flex-end';
      default: return 'flex-start';
    }
  };

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onKeyUp={stopPropagation}
      onKeyPress={stopPropagation}
      onMouseDown={stopPropagation}
      onClick={stopPropagation}
      onBlur={onSave}
      data-placeholder="Type here..."
      className="fixed z-[9999] whitespace-pre-wrap break-words overflow-auto empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 empty:before:pointer-events-none"
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        height: position.height,
        fontSize: position.fontSize,
        fontFamily: position.fontFamily,
        fontWeight: isBold ? 'bold' : 'normal',
        fontStyle: isItalic ? 'italic' : 'normal',
        textDecoration: position.textDecoration || 'none',
        textAlign: position.align as 'left' | 'center' | 'right',
        color: position.color,
        padding: '4px',
        lineHeight: 1.2,
        // Use flexbox for vertical alignment
        display: 'flex',
        flexDirection: 'column',
        justifyContent: getVerticalAlign(position.verticalAlign),
        // Show border to match gizmo
        border: '1px dashed #3B82F6',
        outline: 'none',
        boxShadow: 'none',
        background: 'transparent',
        caretColor: position.color,
      }}
    />
  );
});

TextEditorOverlay.displayName = 'TextEditorOverlay';
