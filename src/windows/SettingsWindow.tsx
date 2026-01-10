import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getVersion } from '@tauri-apps/api/app';
import {
  Settings,
  Keyboard,
  Video,
  Camera,
  MessageSquare,
  FileText,
} from 'lucide-react';
import { Titlebar } from '@/components/Titlebar/Titlebar';
import { ShortcutsTab } from '@/components/Settings/ShortcutsTab';
import { GeneralTab } from '@/components/Settings/GeneralTab';
import { ScreenshotsTab } from '@/components/Settings/ScreenshotsTab';
import { FeedbackTab } from '@/components/Settings/FeedbackTab';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTheme } from '@/hooks/useTheme';
import { useUpdater } from '@/hooks/useUpdater';

type SettingsSection =
  | 'general'
  | 'shortcuts'
  | 'recordings'
  | 'screenshots'
  | 'feedback'
  | 'changelog';

interface SidebarItem {
  id: SettingsSection;
  label: string;
  icon: React.ReactNode;
}

const sidebarItems: SidebarItem[] = [
  { id: 'general', label: 'General', icon: <Settings className="w-4 h-4" /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="w-4 h-4" /> },
  { id: 'recordings', label: 'Recordings', icon: <Video className="w-4 h-4" /> },
  { id: 'screenshots', label: 'Screenshots', icon: <Camera className="w-4 h-4" /> },
  { id: 'feedback', label: 'Feedback', icon: <MessageSquare className="w-4 h-4" /> },
  { id: 'changelog', label: 'Changelog', icon: <FileText className="w-4 h-4" /> },
];

// Placeholder components for sections not yet implemented
const PlaceholderSection: React.FC<{ title: string }> = ({ title }) => (
  <div className="flex items-center justify-center h-full text-(--ink-muted)">
    <p>{title} settings coming soon...</p>
  </div>
);

/**
 * SettingsWindow - Dedicated window for application settings.
 */
const SettingsWindow: React.FC = () => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [appVersion, setAppVersion] = useState<string>('');
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const { loadSettings, saveSettings, isInitialized } = useSettingsStore();
  const { available, checkForUpdates, downloadAndInstall, downloading } = useUpdater(false);

  // Apply theme
  useTheme();

  // Load app version on mount
  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true);
    await checkForUpdates();
    setIsCheckingUpdates(false);
  };

  // Load settings on mount
  useEffect(() => {
    if (!isInitialized) {
      loadSettings();
    }
  }, [isInitialized, loadSettings]);

  // Save settings when window is about to close
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();
    const unlisten = currentWindow.onCloseRequested(async () => {
      await saveSettings();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [saveSettings]);

  // Listen for section change events (when opened from other windows with specific section)
  useEffect(() => {
    const unlisten = listen<{ tab: SettingsSection }>(
      'settings-tab-change',
      (event) => {
        setActiveSection(event.payload.tab);
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        await saveSettings();
        getCurrentWebviewWindow().close();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveSettings]);

  const renderContent = () => {
    switch (activeSection) {
      case 'general':
        return <GeneralTab />;
      case 'shortcuts':
        return <ShortcutsTab />;
      case 'recordings':
        return <PlaceholderSection title="Recordings" />;
      case 'screenshots':
        return <ScreenshotsTab />;
      case 'feedback':
        return <FeedbackTab />;
      case 'changelog':
        return <PlaceholderSection title="Changelog" />;
      default:
        return <GeneralTab />;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-card overflow-hidden rounded-lg">
      <Titlebar title="Settings" showLogo={true} showMaximize={true} />

      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <div className="w-48 shrink-0 border-r border-(--polar-frost) bg-(--polar-ice) p-2 flex flex-col">
          <div className="flex flex-col gap-1 flex-1">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 w-full text-left ${
                  activeSection === item.id
                    ? 'bg-(--coral-400) text-white shadow-sm'
                    : 'text-(--ink-muted) hover:text-(--ink-dark) hover:bg-(--polar-frost)/50'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>

          {/* Version & Updates */}
          <div className="py-3 mt-2 border-t border-(--polar-frost) px-2">
            <p className="text-xs text-(--ink-muted) mb-2">v{appVersion}</p>
            {available ? (
              <button
                onClick={downloadAndInstall}
                disabled={downloading}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
              >
                {downloading ? 'Installing...' : 'Install Update'}
              </button>
            ) : (
              <button
                onClick={handleCheckUpdates}
                disabled={isCheckingUpdates}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-md border border-(--polar-frost) bg-(--card) text-(--ink-dark) hover:bg-(--polar-frost)/50 transition-colors disabled:opacity-50"
              >
                {isCheckingUpdates ? 'Checking...' : 'Check for Updates'}
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5">{renderContent()}</div>
      </div>
    </div>
  );
};

export default SettingsWindow;
