/**
 * CaptureTypeSelector - Toolbar for switching between Screenshot/Video/GIF capture modes.
 * 
 * Appears at the top of the RegionSelector overlay, allowing users to choose
 * what type of capture they want to perform.
 */

import React from 'react';
import { Camera, Video, Film } from 'lucide-react';
import type { CaptureType } from '../../types';

interface CaptureTypeSelectorProps {
  captureType: CaptureType;
  onCaptureTypeChange: (type: CaptureType) => void;
  disabled?: boolean;
}

export const CaptureTypeSelector: React.FC<CaptureTypeSelectorProps> = ({
  captureType,
  onCaptureTypeChange,
  disabled = false,
}) => {
  const options: { type: CaptureType; icon: React.ReactNode; label: string; shortcut: string }[] = [
    {
      type: 'screenshot',
      icon: <Camera size={16} />,
      label: 'Screenshot',
      shortcut: '1',
    },
    {
      type: 'video',
      icon: <Video size={16} />,
      label: 'Video',
      shortcut: '2',
    },
    {
      type: 'gif',
      icon: <Film size={16} />,
      label: 'GIF',
      shortcut: '3',
    },
  ];

  return (
    <div
      className="absolute top-6 left-6 z-50 pointer-events-auto"
      style={{
        padding: '4px',
        borderRadius: '12px',
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
      }}
    >
      <div className="flex items-center gap-1">
        {options.map((option) => {
          const isSelected = captureType === option.type;
          return (
            <button
              key={option.type}
              onClick={() => !disabled && onCaptureTypeChange(option.type)}
              disabled={disabled}
              className={`
                flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-150
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                ${isSelected
                  ? 'bg-white/20 text-white'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
                }
              `}
              title={`${option.label} (${option.shortcut})`}
            >
              {option.icon}
              <span className="text-sm font-medium">{option.label}</span>
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: isSelected ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)',
                  color: isSelected ? 'white' : 'rgba(255,255,255,0.5)',
                }}
              >
                {option.shortcut}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default CaptureTypeSelector;
