/**
 * SourceSelector - Capture source selection (Display/Window/Region)
 * 
 * - Display: Opens picker panel, D2D highlights hovered monitor, click captures
 * - Window: Opens picker panel with search, D2D highlights hovered window, click captures
 * - Area: Opens D2D overlay for drag-to-select region
 */

import React from 'react';
import { SquareDashedMousePointer } from 'lucide-react';
import { DisplayPickerPanel } from './DisplayPickerPanel';
import { WindowPickerPanel } from './WindowPickerPanel';
import type { CaptureType } from '@/types';

export type CaptureSource = 'display' | 'window' | 'area';

interface SourceSelectorProps {
  onSelectArea?: () => void;
  /** Capture type for the picker panels */
  captureType?: CaptureType;
  /** Called when a capture is completed from the picker panels */
  onCaptureComplete?: () => void;
  disabled?: boolean;
}

export const SourceSelector: React.FC<SourceSelectorProps> = ({
  onSelectArea,
  captureType = 'screenshot',
  onCaptureComplete,
  disabled = false,
}) => {

  return (
    <div className={`glass-source-group ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {/* Display Picker - handles its own capture */}
      <DisplayPickerPanel
        disabled={disabled}
        captureType={captureType}
        onCaptureComplete={onCaptureComplete}
      />

      {/* Window Picker - handles its own capture */}
      <WindowPickerPanel
        disabled={disabled}
        captureType={captureType}
        onCaptureComplete={onCaptureComplete}
      />

      {/* Area/Region Selection */}
      <button
        onClick={onSelectArea}
        className="glass-source-btn"
        title="Select area"
        disabled={disabled}
      >
        <span className="glass-source-icon">
          <SquareDashedMousePointer size={18} strokeWidth={1.5} />
        </span>
        <span className="glass-source-label">Area</span>
      </button>
    </div>
  );
};

