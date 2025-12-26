import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutItem[];
}

const sections: ShortcutSection[] = [
  {
    title: 'Tools',
    shortcuts: [
      { keys: ['V'], description: 'Select tool' },
      { keys: ['C'], description: 'Crop / Expand' },
      { keys: ['A'], description: 'Arrow' },
      { keys: ['R'], description: 'Rectangle' },
      { keys: ['E'], description: 'Ellipse' },
      { keys: ['T'], description: 'Text' },
      { keys: ['H'], description: 'Highlight' },
      { keys: ['B'], description: 'Blur / Pixelate' },
      { keys: ['S'], description: 'Step numbers' },
      { keys: ['P'], description: 'Pen / Freehand' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { keys: ['Ctrl', 'Z'], description: 'Undo' },
      { keys: ['Ctrl', 'Y'], description: 'Redo' },
      { keys: ['Ctrl', 'Shift', 'Z'], description: 'Redo (alternate)' },
      { keys: ['Ctrl', 'A'], description: 'Select all shapes' },
      { keys: ['Ctrl', 'D'], description: 'Duplicate selected' },
      { keys: ['Delete'], description: 'Delete selected' },
      { keys: ['Backspace'], description: 'Delete selected' },
      { keys: ['Escape'], description: 'Deselect / Cancel' },
    ],
  },
  {
    title: 'Editor',
    shortcuts: [
      { keys: ['G'], description: 'Toggle compositor' },
      { keys: ['F'], description: 'Fit to center' },
      { keys: ['Double-click'], description: 'Edit text' },
      { keys: ['Shift', 'Drag'], description: 'Proportional resize' },
      { keys: ['Middle Mouse'], description: 'Pan canvas' },
      { keys: ['Scroll'], description: 'Zoom in/out' },
    ],
  },
];

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono font-medium bg-[var(--polar-ice)] border border-[var(--polar-frost)] rounded-md text-[var(--ink-black)] shadow-sm">
    {children}
  </kbd>
);

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  open,
  onClose,
}) => {
  // Handle escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative bg-[var(--card)] border border-[var(--polar-frost)] rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[80vh] overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--polar-frost)] bg-[var(--polar-ice)]">
          <h2 className="text-lg font-semibold text-[var(--ink-black)]">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-black)] hover:bg-[var(--polar-mist)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 overflow-y-auto max-h-[60vh]">
          <div className="space-y-6">
            {sections.map((section) => (
              <div key={section.title}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
                  {section.title}
                </h3>
                <div className="space-y-2">
                  {section.shortcuts.map((shortcut, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between py-1.5"
                    >
                      <span className="text-sm text-[var(--ink-dark)]">
                        {shortcut.description}
                      </span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, keyIdx) => (
                          <React.Fragment key={keyIdx}>
                            {keyIdx > 0 && (
                              <span className="text-[var(--ink-muted)] text-xs">+</span>
                            )}
                            <Kbd>{key}</Kbd>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--polar-frost)] bg-[var(--polar-ice)]">
          <p className="text-xs text-[var(--ink-muted)] text-center">
            Press <Kbd>?</Kbd> to toggle this overlay
          </p>
        </div>
      </div>
    </div>
  );
};
