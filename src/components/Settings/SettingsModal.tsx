import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ShortcutsTab } from './ShortcutsTab';
import { GeneralTab } from './GeneralTab';
import { useSettingsStore } from '@/stores/settingsStore';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { activeTab, setActiveTab } = useSettingsStore();

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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative bg-[var(--obsidian-base)] border border-[var(--border-default)] rounded-xl shadow-2xl w-[560px] mx-4 max-h-[85vh] overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--obsidian-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-[calc(85vh-80px)]">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as 'shortcuts' | 'general')}
            className="w-full"
          >
            <div className="px-5 pt-4 border-b border-[var(--border-subtle)]">
              <TabsList className="w-full justify-start bg-transparent p-0 h-auto">
                <TabsTrigger
                  value="shortcuts"
                  className="px-4 py-2 text-sm font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-amber-400 data-[state=active]:text-amber-400 data-[state=active]:bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Shortcuts
                </TabsTrigger>
                <TabsTrigger
                  value="general"
                  className="px-4 py-2 text-sm font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-amber-400 data-[state=active]:text-amber-400 data-[state=active]:bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  General
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="p-5">
              <TabsContent value="shortcuts" className="m-0 focus-visible:outline-none">
                <ShortcutsTab />
              </TabsContent>
              <TabsContent value="general" className="m-0 focus-visible:outline-none">
                <GeneralTab />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
};
