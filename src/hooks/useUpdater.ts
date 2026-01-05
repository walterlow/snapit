import { useEffect, useState, useCallback, useRef } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';

interface UpdateState {
  available: boolean;
  version: string | null;
  downloading: boolean;
  progress: number;
  error: string | null;
}

export function useUpdater(checkOnMount = true) {
  const [state, setState] = useState<UpdateState>({
    available: false,
    version: null,
    downloading: false,
    progress: 0,
    error: null,
  });
  const [update, setUpdate] = useState<Update | null>(null);

  const downloadAndInstallRef = useRef<((updateToInstall?: Update) => Promise<void>) | null>(null);

  const checkForUpdates = useCallback(async (showNoUpdateToast = false) => {
    try {
      setState(prev => ({ ...prev, error: null }));
      const detected = await check();

      if (detected) {
        setUpdate(detected);
        setState(prev => ({
          ...prev,
          available: true,
          version: detected.version,
        }));

        toast.info(`Update available: v${detected.version}`, {
          action: {
            label: 'Install',
            onClick: () => downloadAndInstallRef.current?.(detected),
          },
          duration: 10000,
        });
      } else if (showNoUpdateToast) {
        toast.success('You are on the latest version');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check for updates';
      setState(prev => ({ ...prev, error: message }));
      console.error('Update check failed:', error);
    }
  }, []);

  const downloadAndInstall = useCallback(async (updateToInstall?: Update) => {
    const target = updateToInstall || update;
    if (!target) return;

    const toastId = toast.loading('Downloading update...', { duration: Infinity });

    setState(prev => ({ ...prev, downloading: true, progress: 0 }));

    try {
      await target.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          setState(prev => ({ ...prev, progress: 0 }));
        } else if (event.event === 'Progress') {
          const progress = event.data.chunkLength;
          setState(prev => ({ ...prev, progress: prev.progress + progress }));
        } else if (event.event === 'Finished') {
          setState(prev => ({ ...prev, progress: 100 }));
        }
      });

      toast.success('Update installed! Restarting...', { id: toastId });

      // Brief delay to show the success message
      await new Promise(resolve => setTimeout(resolve, 1500));
      await relaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install update';
      setState(prev => ({ ...prev, error: message, downloading: false }));
      toast.error(`Update failed: ${message}`, { id: toastId });
    }
  }, [update]);

  // Keep ref in sync with the latest downloadAndInstall function
  downloadAndInstallRef.current = downloadAndInstall;

  // Check for updates on mount (with delay to not slow down startup)
  useEffect(() => {
    if (checkOnMount) {
      const timer = setTimeout(() => {
        checkForUpdates(false);
      }, 5000); // Wait 5 seconds after app starts

      return () => clearTimeout(timer);
    }
  }, [checkOnMount, checkForUpdates]);

  return {
    ...state,
    checkForUpdates,
    downloadAndInstall: () => downloadAndInstall(),
  };
}
