import React, { useEffect, useRef } from 'react';

interface TextEditorOverlayProps {
  position: { left: number; top: number; fontSize: number; color: string } | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Fixed-position textarea overlay for inline text editing
 */
export const TextEditorOverlay: React.FC<TextEditorOverlayProps> = React.memo(({
  position,
  value,
  onChange,
  onSave,
  onCancel,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when opened
  useEffect(() => {
    if (position && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [position]);

  if (!position) return null;

  return (
    <div
      className="fixed z-50"
      style={{
        left: position.left,
        top: position.top,
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSave();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={onSave}
        className="bg-transparent border-none outline-none resize-none"
        style={{
          fontSize: position.fontSize,
          color: position.color,
          minWidth: '100px',
          minHeight: '1em',
        }}
      />
    </div>
  );
});

TextEditorOverlay.displayName = 'TextEditorOverlay';
