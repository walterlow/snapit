/**
 * SystemAudioToggle - Toggle button for system audio capture
 * 
 * Simple toggle button showing system audio state.
 */

import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useCaptureSettingsStore } from '@/stores/captureSettingsStore';

interface SystemAudioToggleProps {
  disabled?: boolean;
}

export const SystemAudioToggle: React.FC<SystemAudioToggleProps> = ({ disabled = false }) => {
  const { settings, updateVideoSettings } = useCaptureSettingsStore();
  const isEnabled = settings.video.captureSystemAudio;

  const handleToggle = () => {
    updateVideoSettings({ captureSystemAudio: !isEnabled });
  };

  return (
    <button
      onClick={handleToggle}
      className={`glass-device-btn glass-device-btn--toggle ${isEnabled ? 'glass-device-btn--active' : ''}`}
      disabled={disabled}
      title={isEnabled ? 'System audio enabled' : 'System audio disabled'}
    >
      {isEnabled ? (
        <Volume2 size={14} strokeWidth={1.5} />
      ) : (
        <VolumeX size={14} strokeWidth={1.5} />
      )}
      <span className="glass-device-label">
        {isEnabled ? 'System Audio' : 'System Muted'}
      </span>
    </button>
  );
};

export default SystemAudioToggle;
