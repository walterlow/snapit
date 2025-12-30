/**
 * ModeSelector - Horizontal toggle group for capture mode selection.
 *
 * A connected toggle group where only one mode can be active.
 * Visual style: horizontal segmented control with glass styling.
 */

import React from 'react';
import { Video, ImagePlay, Camera } from 'lucide-react';
import type { CaptureType } from '../../types';

interface ModeSelectorProps {
  activeMode: CaptureType;
  onModeChange: (mode: CaptureType) => void;
  disabled?: boolean;
}

const modes: { id: CaptureType; icon: React.ReactNode; label: string }[] = [
  { id: 'video', icon: <Video size={14} strokeWidth={1.5} />, label: 'Video' },
  { id: 'gif', icon: <ImagePlay size={14} strokeWidth={1.5} />, label: 'GIF' },
  { id: 'screenshot', icon: <Camera size={14} strokeWidth={1.5} />, label: 'Photo' },
];

export const ModeSelector: React.FC<ModeSelectorProps> = ({
  activeMode,
  onModeChange,
  disabled = false,
}) => {
  return (
    <div className={`glass-mode-group ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {modes.map((mode) => (
        <button
          key={mode.id}
          onClick={() => onModeChange(mode.id)}
          className={`glass-mode-btn ${activeMode === mode.id ? 'glass-mode-btn--active' : ''}`}
          title={mode.label}
          disabled={disabled}
        >
          <span className="glass-mode-icon">{mode.icon}</span>
          <span className="glass-mode-label">{mode.label}</span>
        </button>
      ))}
    </div>
  );
};

export default ModeSelector;
