import React from 'react';
import { Aperture, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShortcut } from '@/stores/settingsStore';

interface EmptyStateProps {
  onNewCapture: () => void;
}

function parseShortcut(shortcut: string): string[] {
  return shortcut.split('+').map(key => {
    // Normalize key names for display
    const normalized = key.trim();
    switch (normalized.toLowerCase()) {
      case 'printscreen':
        return 'PrtSc';
      case 'control':
      case 'ctrl':
        return 'Ctrl';
      case 'shift':
        return 'Shift';
      case 'alt':
        return 'Alt';
      case 'meta':
      case 'super':
      case 'win':
        return 'Win';
      default:
        return normalized;
    }
  });
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onNewCapture }) => {
  const shortcutConfig = useShortcut('new_capture');
  const keys = parseShortcut(shortcutConfig?.currentShortcut || 'PrintScreen');

  return (
  <div className="flex flex-col items-center justify-center py-16 animate-fade-in">
    {/* Illustration */}
    <div className="relative mb-6">
      <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-[var(--coral-50)] to-[var(--polar-ice)] flex items-center justify-center">
        <div className="w-16 h-16 rounded-xl bg-[var(--card)] shadow-lg flex items-center justify-center border border-[var(--polar-frost)]">
          <Aperture className="w-8 h-8 text-[var(--coral-400)]" />
        </div>
      </div>
      <div className="absolute -right-2 -top-2 w-6 h-6 rounded-full bg-[var(--coral-400)] flex items-center justify-center shadow-md">
        <Plus className="w-4 h-4 text-white" />
      </div>
    </div>

    <h2 className="text-lg font-semibold text-[var(--ink-black)] mb-2">No captures yet</h2>
    <p className="text-sm text-[var(--ink-muted)] text-center max-w-xs mb-6">
      Take your first screenshot to get started. Your captures will appear here for easy access.
    </p>

    <Button
      onClick={onNewCapture}
      className="btn-coral gap-2 px-5 h-10 rounded-xl text-sm font-medium shadow-md hover:shadow-lg transition-shadow"
    >
      <Aperture className="w-4 h-4" />
      Take Screenshot
    </Button>

    <div className="flex items-center gap-2 mt-5 text-xs text-[var(--ink-subtle)]">
      <span>or press</span>
      <div className="flex items-center gap-1">
        {keys.map((key, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span>+</span>}
            <kbd className="kbd">{key}</kbd>
          </React.Fragment>
        ))}
      </div>
    </div>
  </div>
  );
};
