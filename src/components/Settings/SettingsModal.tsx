import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Tabs } from '@base-ui/react/tabs';
import { ShortcutsTab } from './ShortcutsTab';
import { GeneralTab } from './GeneralTab';
import { useSettingsStore } from '@/stores/settingsStore';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { setActiveTab } = useSettingsStore();

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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-card border border-(--polar-frost) rounded-lg shadow-2xl w-140 mx-4 max-h-[80vh] flex flex-col overflow-hidden animate-scale-in">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-(--polar-frost) bg-(--polar-ice)">
          <h2 className="text-lg font-semibold text-(--ink-black)">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-(--ink-muted) hover:text-(--ink-black) hover:bg-(--polar-mist) transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <Tabs.Root
          defaultValue="general"
          onValueChange={(value) => setActiveTab(value as 'shortcuts' | 'general')}
          className="flex-1 min-h-0 flex flex-col"
        >
          {/* Tabs */}
          <div className="shrink-0 px-4 pt-3 pb-0 bg-card">
            <Tabs.List className="relative flex w-full p-1 rounded-lg bg-(--polar-frost)/60">
              <Tabs.Tab
                value="general"
                className="relative flex-1 py-2 text-sm font-medium text-center rounded-md transition-all duration-200 ease-out text-(--ink-muted) hover:text-(--ink-dark) hover:bg-card data-active:bg-(--coral-400)! data-active:text-white! data-active:shadow-sm"
              >
                General
              </Tabs.Tab>
              <Tabs.Tab
                value="shortcuts"
                className="relative flex-1 py-2 text-sm font-medium text-center rounded-md transition-all duration-200 ease-out text-(--ink-muted) hover:text-(--ink-dark) hover:bg-card data-active:bg-(--coral-400)! data-active:text-white! data-active:shadow-sm"
              >
                Shortcuts
              </Tabs.Tab>
            </Tabs.List>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            <Tabs.Panel value="general">
              <GeneralTab />
            </Tabs.Panel>
            <Tabs.Panel value="shortcuts">
              <ShortcutsTab />
            </Tabs.Panel>
          </div>
        </Tabs.Root>
      </div>
    </div>
  );
};
