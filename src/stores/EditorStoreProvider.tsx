/**
 * EditorStoreProvider - React context provider for window-based editor stores.
 *
 * Each editor window creates its own store instance, and this provider
 * makes it available to all child components via React context.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { EditorStore } from './editorStore';

// React Context for window-based editors
export const EditorStoreContext = createContext<EditorStore | null>(null);

/**
 * Provider for window-based editor stores.
 * Each editor window creates its own store instance.
 */
export const EditorStoreProvider: React.FC<{
  store: EditorStore;
  children: ReactNode;
}> = ({ store, children }) => {
  return (
    <EditorStoreContext.Provider value={store}>
      {children}
    </EditorStoreContext.Provider>
  );
};

/**
 * Hook to get the editor store context.
 * Returns null if not within a provider (will fall back to global store).
 */
export function useEditorStoreContext(): EditorStore | null {
  return useContext(EditorStoreContext);
}
