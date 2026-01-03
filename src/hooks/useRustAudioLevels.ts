/**
 * useRustAudioLevels - Hook to monitor audio levels via Rust WASAPI backend
 *
 * Calls Rust commands to start/stop audio monitoring and listens for
 * 'audio-levels' events emitted by the backend. Supports both microphone
 * and system audio monitoring.
 *
 * This is the preferred method during recording as it uses WASAPI which
 * can monitor both mic and system audio simultaneously.
 */

import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AudioLevels } from '@/types/generated';
import { audioLogger } from '@/utils/logger';

interface UseRustAudioLevelsOptions {
  /** Microphone device index (null = disabled) */
  micDeviceIndex?: number | null;
  /** Whether to monitor system audio */
  monitorSystemAudio?: boolean;
  /** Whether monitoring is enabled at all */
  enabled?: boolean;
}

interface UseRustAudioLevelsResult {
  /** Current microphone level (0-1) */
  micLevel: number;
  /** Current system audio level (0-1) */
  systemLevel: number;
  /** Whether microphone monitoring is active */
  micActive: boolean;
  /** Whether system audio monitoring is active */
  systemActive: boolean;
  /** Error message if monitoring failed */
  error: string | null;
  /** Whether we're currently starting up monitoring */
  isStarting: boolean;
}

export function useRustAudioLevels({
  micDeviceIndex = null,
  monitorSystemAudio = false,
  enabled = true,
}: UseRustAudioLevelsOptions = {}): UseRustAudioLevelsResult {
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [micActive, setMicActive] = useState(false);
  const [systemActive, setSystemActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Effect to start/stop monitoring based on enabled state and device settings
  useEffect(() => {
    const shouldMonitor = enabled && (micDeviceIndex !== null || monitorSystemAudio);

    if (!shouldMonitor) {
      // Stop monitoring and clean up
      invoke('stop_audio_monitoring').catch((err) => {
        audioLogger.error('Failed to stop monitoring:', err);
      });

      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      setMicLevel(0);
      setSystemLevel(0);
      setMicActive(false);
      setSystemActive(false);
      return;
    }

    // Start monitoring
    let cancelled = false;

    const startMonitoring = async () => {
      setIsStarting(true);
      setError(null);

      audioLogger.debug('Starting monitoring:', { micDeviceIndex, monitorSystemAudio });

      try {
        // Set up event listener first
        const unlisten = await listen<AudioLevels>('audio-levels', (event) => {
          if (cancelled) return;
          const { micLevel, systemLevel, micActive, systemActive } = event.payload;
          setMicLevel(micLevel);
          setSystemLevel(systemLevel);
          setMicActive(micActive);
          setSystemActive(systemActive);
        });

        audioLogger.debug('Event listener registered');

        if (cancelled) {
          unlisten();
          return;
        }

        unlistenRef.current = unlisten;

        // Start the Rust audio monitoring
        await invoke('start_audio_monitoring', {
          micDeviceIndex: micDeviceIndex,
          monitorSystemAudio: monitorSystemAudio,
        });

        audioLogger.debug('Rust monitoring started successfully');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        audioLogger.error('Failed to start monitoring:', err);
      } finally {
        if (!cancelled) {
          setIsStarting(false);
        }
      }
    };

    startMonitoring();

    // Cleanup on unmount or when dependencies change
    return () => {
      cancelled = true;

      invoke('stop_audio_monitoring').catch((err) => {
        audioLogger.error('Failed to stop monitoring on cleanup:', err);
      });

      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [enabled, micDeviceIndex, monitorSystemAudio]);

  return {
    micLevel,
    systemLevel,
    micActive,
    systemActive,
    error,
    isStarting,
  };
}

export default useRustAudioLevels;
