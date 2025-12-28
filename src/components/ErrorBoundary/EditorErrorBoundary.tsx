import { ReactNode } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';

interface EditorErrorBoundaryProps {
  children: ReactNode;
  projectId?: string | null;
  onBack?: () => void;
}

/**
 * Specialized error boundary for the Editor view.
 *
 * Provides:
 * - Recovery options specific to editing context
 * - Option to go back to library (preserving captures)
 * - Auto-reset when switching projects
 */
export function EditorErrorBoundary({
  children,
  projectId,
  onBack,
}: EditorErrorBoundaryProps) {
  return (
    <ErrorBoundary
      resetKeys={[projectId]}
      fallback={(error, reset) => (
        <EditorErrorFallback error={error} onReset={reset} onBack={onBack} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

interface EditorErrorFallbackProps {
  error: Error;
  onReset: () => void;
  onBack?: () => void;
}

function EditorErrorFallback({ error, onReset, onBack }: EditorErrorFallbackProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-[var(--card)]">
      <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-6">
        <svg
          className="w-8 h-8 text-red-500"
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
        Editor Error
      </h2>
      <p className="text-[var(--text-muted)] mb-2 max-w-md">
        The editor encountered an error while rendering.
      </p>
      <p className="text-sm text-[var(--text-muted)] mb-6 max-w-md opacity-70">
        Your capture is safely stored. You can try again or return to the library.
      </p>
      {error?.message && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded mb-6 max-w-md font-mono">
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
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--ink-black)] bg-[var(--polar-frost)] rounded-lg hover:bg-[var(--polar-snow)] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Library
          </button>
        )}
      </div>
    </div>
  );
}

export default EditorErrorBoundary;
