import { ReactNode } from 'react';
import { RefreshCw, FolderOpen } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';

interface LibraryErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Specialized error boundary for the Library view.
 *
 * Provides:
 * - Recovery options for library loading failures
 * - Option to refresh or open storage location
 */
export function LibraryErrorBoundary({ children }: LibraryErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <LibraryErrorFallback error={error} onReset={reset} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

interface LibraryErrorFallbackProps {
  error: Error;
  onReset: () => void;
}

function LibraryErrorFallback({ error, onReset }: LibraryErrorFallbackProps) {
  const handleOpenStorage = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const storagePath = await invoke<string>('get_storage_path');
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(storagePath);
    } catch {
      // Fallback: just reload
      window.location.reload();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-6">
        <svg
          className="w-8 h-8 text-amber-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-[var(--ink-black)] mb-2">
        Library Error
      </h2>
      <p className="text-[var(--text-muted)] mb-2 max-w-md">
        Failed to load the capture library.
      </p>
      <p className="text-sm text-[var(--text-muted)] mb-6 max-w-md opacity-70">
        Your captures are still stored safely on disk.
      </p>
      {error?.message && (
        <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded mb-6 max-w-md font-mono">
          {error.message}
        </p>
      )}
      <div className="flex gap-3">
        <button
          onClick={onReset}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--aurora-blue)] rounded-lg hover:opacity-90 transition-opacity"
        >
          <RefreshCw className="w-4 h-4" />
          Try Again
        </button>
        <button
          onClick={handleOpenStorage}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--ink-black)] bg-[var(--polar-frost)] rounded-lg hover:bg-[var(--polar-snow)] transition-colors"
        >
          <FolderOpen className="w-4 h-4" />
          Open Storage
        </button>
      </div>
    </div>
  );
}

export default LibraryErrorBoundary;
