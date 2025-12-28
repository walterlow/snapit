/**
 * ModeSelector - Segmented toggle group for capture mode selection.
 *
 * A connected toggle group where only one mode can be active (solo mode).
 * Visual style: segmented control with sliding highlight.
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
  { id: 'video', icon: <Video size={14} />, label: 'Video' },
  { id: 'gif', icon: <ImagePlay size={14} />, label: 'GIF' },
  { id: 'screenshot', icon: <Camera size={14} />, label: 'Photo' },
];

export const ModeSelector: React.FC<ModeSelectorProps> = ({
  activeMode,
  onModeChange,
  disabled = false,
}) => {
  return (
    <div className={`glass-toggle-group-vertical ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {modes.map((mode) => (
        <button
          key={mode.id}
          onClick={() => onModeChange(mode.id)}
          className={`glass-toggle-item-vertical ${activeMode === mode.id ? 'glass-toggle-item-vertical--active' : ''}`}
          title={mode.label}
          disabled={disabled}
        >
          {mode.icon}
          <span className="glass-toggle-label">{mode.label}</span>
        </button>
      ))}
    </div>
  );
};

export default ModeSelector;
