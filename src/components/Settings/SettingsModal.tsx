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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[var(--card)] border border-[var(--polar-frost)] rounded-lg shadow-2xl w-[560px] mx-4 max-h-[80vh] flex flex-col overflow-hidden animate-scale-in">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-[var(--polar-frost)] bg-[var(--polar-ice)]">
          <h2 className="text-lg font-semibold text-[var(--ink-black)]">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-black)] hover:bg-[var(--polar-mist)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as 'shortcuts' | 'general')}
          className="flex-1 min-h-0 flex flex-col"
        >
          {/* Sticky Tabs */}
          <div className="flex-shrink-0 px-5 pt-4 border-b border-[var(--polar-frost)] bg-[var(--card)]">
            <TabsList className="relative w-full justify-start bg-transparent p-0 h-auto">
              <TabsTrigger
                value="general"
                className="relative px-4 py-2 text-sm font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-[var(--coral-400)] data-[state=active]:text-[var(--coral-500)] data-[state=active]:bg-transparent text-[var(--ink-muted)] hover:text-[var(--ink-dark)] transition-all duration-200 data-[state=active]:scale-[1.02] hover:scale-[1.01]"
              >
                General
              </TabsTrigger>
              <TabsTrigger
                value="shortcuts"
                className="relative px-4 py-2 text-sm font-medium rounded-none border-b-2 border-transparent data-[state=active]:border-[var(--coral-400)] data-[state=active]:text-[var(--coral-500)] data-[state=active]:bg-transparent text-[var(--ink-muted)] hover:text-[var(--ink-dark)] transition-all duration-200 data-[state=active]:scale-[1.02] hover:scale-[1.01]"
              >
                Shortcuts
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            <TabsContent value="general" className="m-0 focus-visible:outline-none animate-in fade-in-0 slide-in-from-top-2 duration-200">
              <GeneralTab />
            </TabsContent>
            <TabsContent value="shortcuts" className="m-0 focus-visible:outline-none animate-in fade-in-0 slide-in-from-top-2 duration-200">
              <ShortcutsTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
};
