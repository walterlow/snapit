/**
 * useAudioLevel - Hook to monitor audio input levels using Web Audio API
 * 
 * Returns a normalized level (0-1) that can be used for visualization.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { audioLogger } from '@/utils/logger';

interface UseAudioLevelOptions {
  /** Device ID to monitor (from navigator.mediaDevices) */
  deviceId?: string;
  /** Whether monitoring is enabled */
  enabled?: boolean;
  /** Update interval in ms (default: 50) */
  updateInterval?: number;
  /** Smoothing factor for level transitions (0-1, default: 0.8) */
  smoothing?: number;
}

interface UseAudioLevelResult {
  /** Current audio level (0-1) */
  level: number;
  /** Whether audio is currently being captured */
  isActive: boolean;
  /** Error message if audio capture failed */
  error: string | null;
}

export function useAudioLevel({
  deviceId,
  enabled = true,
  updateInterval = 50,
  smoothing = 0.8,
}: UseAudioLevelOptions = {}): UseAudioLevelResult {
  const [level, setLevel] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs to persist across renders
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationIdRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (animationIdRef.current) {
      cancelAnimationFrame(animationIdRef.current);
      animationIdRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    smoothedLevelRef.current = 0;
    setLevel(0);
    setIsActive(false);
  }, []);

  // Start audio capture and analysis
  const startCapture = useCallback(async () => {
    cleanup();
    setError(null);

    try {
      // Request microphone access
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // Create audio context and analyser
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = smoothing;
      analyserRef.current = analyser;

      // Connect stream to analyser
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      setIsActive(true);

      // Create data buffer
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let lastUpdate = 0;

      // Animation loop to read audio levels
      const updateLevel = (timestamp: number) => {
        if (!analyserRef.current) return;

        // Throttle updates
        if (timestamp - lastUpdate >= updateInterval) {
          analyserRef.current.getByteFrequencyData(dataArray);

          // Calculate RMS (root mean square) for more accurate level
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sum / dataArray.length);
          
          // Normalize to 0-1 range (255 is max value)
          const rawLevel = Math.min(1, rms / 128);

          // Apply smoothing for visual appeal
          smoothedLevelRef.current = 
            smoothedLevelRef.current * 0.7 + rawLevel * 0.3;
          
          setLevel(smoothedLevelRef.current);
          lastUpdate = timestamp;
        }

        animationIdRef.current = requestAnimationFrame(updateLevel);
      };

      animationIdRef.current = requestAnimationFrame(updateLevel);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to capture audio';
      setError(message);
      audioLogger.error('Audio capture error:', err);
      cleanup();
    }
  }, [deviceId, smoothing, updateInterval, cleanup]);

  // Effect to start/stop capture based on enabled state
  useEffect(() => {
    if (enabled && deviceId) {
      startCapture();
    } else {
      cleanup();
    }

    return cleanup;
  }, [enabled, deviceId, startCapture, cleanup]);

  return { level, isActive, error };
}

export default useAudioLevel;
