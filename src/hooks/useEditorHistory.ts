/**
 * useEditorHistory - Context-aware history functions for undo/redo.
 *
 * This hook provides snapshot functions that work with the editor store
 * from context. Must be used within an EditorStoreProvider.
 *
 * IMPORTANT: Always use this hook instead of importing takeSnapshot/commitSnapshot
 * directly from editorStore.
 */

import { useCallback } from 'react';
import { useEditorStoreContext } from '../stores/EditorStoreProvider';

export interface EditorHistoryActions {
  /** Take a snapshot BEFORE starting a user action (drag, transform, etc.) */
  takeSnapshot: () => void;
  /** Commit the pending snapshot to history AFTER an action completes */
  commitSnapshot: () => void;
  /** Discard pending snapshot without committing (e.g., action cancelled) */
  discardSnapshot: () => void;
  /** Convenience: take snapshot + commit in one call for instant actions */
  recordAction: (action: () => void) => void;
}

/**
 * Hook to get history actions from the editor store context.
 * Must be used within an EditorStoreProvider.
 */
export function useEditorHistory(): EditorHistoryActions {
  const store = useEditorStoreContext();

  if (!store) {
    throw new Error('useEditorHistory must be used within an EditorStoreProvider');
  }

  const takeSnapshot = useCallback(() => {
    store.getState()._takeSnapshot();
  }, [store]);

  const commitSnapshot = useCallback(() => {
    store.getState()._commitSnapshot();
  }, [store]);

  const discardSnapshot = useCallback(() => {
    store.getState()._discardSnapshot();
  }, [store]);

  const recordAction = useCallback((action: () => void) => {
    store.getState()._takeSnapshot();
    action();
    store.getState()._commitSnapshot();
  }, [store]);

  return {
    takeSnapshot,
    commitSnapshot,
    discardSnapshot,
    recordAction,
  };
}
