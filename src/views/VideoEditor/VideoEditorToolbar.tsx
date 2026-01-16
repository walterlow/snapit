/**
 * VideoEditorToolbar - Top bar with back button and project name.
 */
import { ArrowLeft } from 'lucide-react';
import type { VideoProject } from '../../types';

export interface VideoEditorToolbarProps {
  project: VideoProject | null;
  onBack: () => void;
}

export function VideoEditorToolbar({ project, onBack }: VideoEditorToolbarProps) {
  return (
    <div className="h-10 flex items-center px-3 border-b border-[var(--glass-border)] bg-[var(--polar-mist)]">
      <button
        onClick={onBack}
        className="glass-btn h-7 w-7 flex items-center justify-center"
        title="Back to Library"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <span className="ml-3 text-sm font-medium text-[var(--ink-dark)]">
        {project?.name || 'Video Editor'}
      </span>
    </div>
  );
}
