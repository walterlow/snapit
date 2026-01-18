import { useState, useCallback, useMemo, Activity } from 'react';
import { Toaster } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { Titlebar } from './components/Titlebar/Titlebar';
import { CaptureLibrary } from './components/Library/CaptureLibrary';
import { LibraryErrorBoundary } from './components/ErrorBoundary';
import { KeyboardShortcutsModal } from './components/KeyboardShortcuts/KeyboardShortcutsModal';
import { VideoEditorView } from './views/VideoEditorView';
import { useCaptureStore } from './stores/captureStore';
import { useSettingsStore } from './stores/settingsStore';
import { useCaptureSettingsStore } from './stores/captureSettingsStore';
import { useUpdater } from './hooks/useUpdater';
import { useTheme } from './hooks/useTheme';
import { useAppEventListeners } from './hooks/useAppEventListeners';
import { useAppInitialization } from './hooks/useAppInitialization';
import { useCaptureActions } from './hooks/useCaptureActions';

function App() {
  const {
    view,
    saveNewCaptureFromFile,
    loadCaptures,
  } = useCaptureStore();

  // Initialize theme (applies theme class to document root)
  useTheme();

  // Auto-update checker (runs 5s after app starts)
  useUpdater(true);

  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Capture actions for shortcuts
  const { triggerNewCapture, triggerFullscreenCapture, triggerAllMonitorsCapture } = useCaptureActions();

  // App initialization (settings, shortcuts, cleanup)
  useAppInitialization({
    triggerNewCapture,
    triggerFullscreenCapture,
    triggerAllMonitorsCapture,
  });

  // Consolidated event listener callbacks
  const eventCallbacks = useMemo(
    () => ({
      onRecordingComplete: loadCaptures,
      onThumbnailReady: useCaptureStore.getState().updateCaptureThumbnail,
      onCaptureCompleteFast: async (data: { file_path: string; width: number; height: number }) => {
        // Open editor immediately with RGBA file (fast path - no waiting for save)
        invoke('show_image_editor_window', { capturePath: data.file_path }).catch((error) => {
          console.error('Failed to open image editor:', error);
        });

        // Save to library in background (don't block editor)
        saveNewCaptureFromFile(data.file_path, data.width, data.height, 'region', {}, { silent: true })
          .then(async ({ imagePath }) => {
            // Copy to clipboard after save completes (if enabled)
            const copyToClipboard = useCaptureSettingsStore.getState().copyToClipboardAfterCapture;
            if (copyToClipboard) {
              try {
                await invoke('copy_image_to_clipboard', { path: imagePath });
              } catch (error) {
                console.error('Failed to copy to clipboard:', error);
              }
            }
          })
          .catch((error) => {
            console.error('Failed to save capture:', error);
          });
      },
    }),
    [loadCaptures, saveNewCaptureFromFile]
  );

  // Consolidated Tauri event listeners
  useAppEventListeners(eventCallbacks);

  // Settings handler
  const handleOpenSettings = useCallback(() => {
    useSettingsStore.getState().openSettingsModal();
  }, []);

  // Show capture toolbar window (startup mode)
  const handleShowCaptureToolbar = useCallback(async () => {
    await invoke('show_startup_toolbar');
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--polar-snow)] overflow-hidden">
      {/* Toast Notifications */}
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: 'var(--card)',
            border: '1px solid var(--polar-frost)',
            color: 'var(--ink-black)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          },
        }}
      />

      {/* Keyboard Shortcuts Help Modal */}
      <KeyboardShortcutsModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />

      {/* Custom Titlebar */}
      <Titlebar
        title="SnapIt Library"
        onCapture={handleShowCaptureToolbar}
        onOpenSettings={handleOpenSettings}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Library */}
        <Activity mode={view === 'library' ? 'visible' : 'hidden'}>
          <LibraryErrorBoundary>
            <CaptureLibrary />
          </LibraryErrorBoundary>
        </Activity>

        {/* Video Editor (legacy embedded view - kept for video playback) */}
        <Activity mode={view === 'videoEditor' ? 'visible' : 'hidden'}>
          <VideoEditorView />
        </Activity>
      </div>
    </div>
  );
}

export default App;
