import { useEffect, useCallback } from 'react';

/**
 * Keyboard shortcuts for the video editor.
 *
 * Single keys (no modifiers):
 * - Space: Toggle playback
 * - Home: Seek to start
 * - End: Seek to end
 * - ArrowLeft: Skip back 5 seconds
 * - ArrowRight: Skip forward 5 seconds
 * - C: Split selected region at playhead
 * - S: Toggle split mode
 * - Delete/Backspace: Delete selected region(s)
 * - Escape: Deselect all / exit split mode
 *
 * With modifiers:
 * - Ctrl+S: Save project
 * - Ctrl+-: Zoom out timeline
 * - Ctrl+=: Zoom in timeline
 * - Ctrl+E: Export
 */

interface UseVideoEditorShortcutsProps {
  enabled: boolean;
  onTogglePlayback: () => void;
  onSeekToStart: () => void;
  onSeekToEnd: () => void;
  onSkipBack: () => void;
  onSkipForward: () => void;
  onSplitAtPlayhead: () => void;
  onToggleSplitMode: () => void;
  onDeleteSelected: () => void;
  onTimelineZoomIn: () => void;
  onTimelineZoomOut: () => void;
  onDeselect: () => void;
  onSave: () => void;
  onExport: () => void;
}

export function useVideoEditorShortcuts({
  enabled,
  onTogglePlayback,
  onSeekToStart,
  onSeekToEnd,
  onSkipBack,
  onSkipForward,
  onSplitAtPlayhead,
  onToggleSplitMode,
  onDeleteSelected,
  onTimelineZoomIn,
  onTimelineZoomOut,
  onDeselect,
  onSave,
  onExport,
}: UseVideoEditorShortcutsProps) {
  // Check if event target is an input field
  const isInputTarget = useCallback((e: KeyboardEvent): boolean => {
    return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in an input
      if (isInputTarget(e)) return;

      const isMod = e.ctrlKey || e.metaKey;

      // Modifier shortcuts
      if (isMod) {
        switch (e.key) {
          case 's':
            e.preventDefault();
            onSave();
            return;
          case '-':
          case '_':
            e.preventDefault();
            onTimelineZoomOut();
            return;
          case '=':
          case '+':
            e.preventDefault();
            onTimelineZoomIn();
            return;
          case 'e':
            e.preventDefault();
            onExport();
            return;
        }
        return;
      }

      // Single key shortcuts (no modifiers)
      if (e.altKey) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          onTogglePlayback();
          break;
        case 'Home':
          e.preventDefault();
          onSeekToStart();
          break;
        case 'End':
          e.preventDefault();
          onSeekToEnd();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onSkipBack();
          break;
        case 'ArrowRight':
          e.preventDefault();
          onSkipForward();
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          onSplitAtPlayhead();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          onToggleSplitMode();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          onDeleteSelected();
          break;
        case 'Escape':
          e.preventDefault();
          onDeselect();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    enabled,
    isInputTarget,
    onTogglePlayback,
    onSeekToStart,
    onSeekToEnd,
    onSkipBack,
    onSkipForward,
    onSplitAtPlayhead,
    onToggleSplitMode,
    onDeleteSelected,
    onTimelineZoomIn,
    onTimelineZoomOut,
    onDeselect,
    onSave,
    onExport,
  ]);
}
