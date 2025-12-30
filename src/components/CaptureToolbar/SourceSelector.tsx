/**
 * SourceSelector - Capture source selection buttons (Display/Window/Area)
 * 
 * Horizontal layout with icon + label for each capture source type.
 * Uses glass styling consistent with the toolbar aesthetic.
 */

import React from 'react';
import { Monitor, AppWindow, SquareDashedMousePointer } from 'lucide-react';

export type CaptureSource = 'display' | 'window' | 'area';

interface SourceSelectorProps {
  activeSource: CaptureSource;
  onSourceChange: (source: CaptureSource) => void;
  disabled?: boolean;
}

const sources: { id: CaptureSource; icon: React.ReactNode; label: string }[] = [
  { id: 'display', icon: <Monitor size={18} strokeWidth={1.5} />, label: 'Display' },
  { id: 'window', icon: <AppWindow size={18} strokeWidth={1.5} />, label: 'Window' },
  { id: 'area', icon: <SquareDashedMousePointer size={18} strokeWidth={1.5} />, label: 'Area' },
];

export const SourceSelector: React.FC<SourceSelectorProps> = ({
  activeSource,
  onSourceChange,
  disabled = false,
}) => {
  return (
    <div className={`glass-source-group ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {sources.map((source) => (
        <button
          key={source.id}
          onClick={() => onSourceChange(source.id)}
          className={`glass-source-btn ${activeSource === source.id ? 'glass-source-btn--active' : ''}`}
          title={source.label}
          disabled={disabled}
        >
          <span className="glass-source-icon">{source.icon}</span>
          <span className="glass-source-label">{source.label}</span>
        </button>
      ))}
    </div>
  );
};

export default SourceSelector;
