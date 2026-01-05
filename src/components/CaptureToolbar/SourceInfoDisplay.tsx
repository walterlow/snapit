/**
 * SourceInfoDisplay - Shows info about the selected capture source
 *
 * For window selection: Shows window icon + title
 * For display selection: Shows monitor icon + name
 */

import React from 'react';
import { AppWindow, Monitor, ChevronLeft } from 'lucide-react';

interface SourceInfoDisplayProps {
  sourceType: 'window' | 'display';
  sourceTitle?: string | null;
  monitorName?: string | null;
  monitorIndex?: number | null;
  onBack?: () => void;
  disabled?: boolean;
}

export const SourceInfoDisplay: React.FC<SourceInfoDisplayProps> = ({
  sourceType,
  sourceTitle,
  monitorName,
  monitorIndex,
  onBack,
  disabled = false,
}) => {
  // Format display text
  const getDisplayText = () => {
    if (sourceType === 'window') {
      if (!sourceTitle) return 'Window';
      // Truncate long titles
      return sourceTitle.length > 30 ? sourceTitle.substring(0, 30) + '...' : sourceTitle;
    } else {
      // Display mode
      if (monitorName) {
        return monitorName;
      }
      if (monitorIndex !== null && monitorIndex !== undefined) {
        return `Display ${monitorIndex + 1}`;
      }
      return 'Display';
    }
  };

  const Icon = sourceType === 'window' ? AppWindow : Monitor;

  return (
    <div className="glass-source-group">
      {/* Back button */}
      <button
        onClick={onBack}
        className="glass-source-btn glass-source-btn--back"
        disabled={disabled}
        title="Back to source selection"
      >
        <ChevronLeft size={18} strokeWidth={1.5} />
      </button>

      {/* Source info display */}
      <div className="glass-source-info">
        <span className="glass-source-icon">
          <Icon size={16} strokeWidth={1.5} />
        </span>
        <span className="glass-source-label glass-source-label--truncate">
          {getDisplayText()}
        </span>
      </div>
    </div>
  );
};

export default SourceInfoDisplay;
