/**
 * AudioLevelMeter - Visual audio level indicator
 *
 * Shows a small bar that fills based on audio input level.
 * Used to provide visual feedback that the microphone/audio is working.
 *
 * Can operate in two modes:
 * 1. Self-managed: Uses Web Audio API internally (when deviceIndex is provided)
 * 2. External: Uses level prop directly (when level is provided)
 *
 * Styling is controlled via CSS classes - use .glass-audio-meter--column
 * for the full-width variant below the toolbar devices section.
 */

import React, { useEffect, useState } from 'react';
import { useAudioLevel } from '@/hooks/useAudioLevel';

interface AudioLevelMeterProps {
  /** Whether monitoring is enabled */
  enabled?: boolean;
  /** Device index from audioInputStore (will be matched to browser deviceId) - self-managed mode */
  deviceIndex?: number | null;
  /** External level value (0-1) - external mode, overrides deviceIndex */
  level?: number;
  /** Additional CSS class */
  className?: string;
}

/**
 * Maps a device index from the Rust backend to a browser MediaDevices deviceId.
 * Returns undefined if no matching device is found.
 */
async function getDeviceIdByIndex(index: number): Promise<string | undefined> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');

    if (index >= 0 && index < audioInputs.length) {
      return audioInputs[index].deviceId;
    }

    // Fallback: try to find by similar position
    // Some systems may have different ordering between Rust and browser
    return audioInputs[0]?.deviceId;
  } catch {
    return undefined;
  }
}

export const AudioLevelMeter: React.FC<AudioLevelMeterProps> = ({
  enabled = true,
  deviceIndex,
  level: externalLevel,
  className = '',
}) => {
  const [browserDeviceId, setBrowserDeviceId] = useState<string | undefined>(undefined);

  // Determine if we're in external mode (level provided) or self-managed mode
  const isExternalMode = externalLevel !== undefined;

  // Resolve device index to browser deviceId (only in self-managed mode)
  useEffect(() => {
    if (isExternalMode || !enabled || deviceIndex === null || deviceIndex === undefined) {
      setBrowserDeviceId(undefined);
      return;
    }

    getDeviceIdByIndex(deviceIndex).then(setBrowserDeviceId);
  }, [enabled, deviceIndex, isExternalMode]);

  // Monitor audio level via Web Audio API (only in self-managed mode)
  const { level: browserLevel, isActive } = useAudioLevel({
    deviceId: browserDeviceId,
    enabled: !isExternalMode && enabled && !!browserDeviceId,
    updateInterval: 50,
    smoothing: 0.8,
  });

  // Use external level if provided, otherwise use browser level
  const displayLevel = isExternalMode ? externalLevel : browserLevel;

  // Calculate fill percentage
  const fillPercent = Math.round(displayLevel * 100);

  // Don't render if disabled
  if (!enabled) {
    return null;
  }

  // In self-managed mode, also don't render if no device selected
  if (!isExternalMode && (deviceIndex === null || deviceIndex === undefined)) {
    return null;
  }

  return (
    <div
      className={`glass-audio-meter ${className}`}
      title={isExternalMode || isActive ? `Audio level: ${fillPercent}%` : 'Connecting...'}
    >
      <div className="glass-audio-meter-fill" style={{ width: `${fillPercent}%` }} />
    </div>
  );
};

export default AudioLevelMeter;
