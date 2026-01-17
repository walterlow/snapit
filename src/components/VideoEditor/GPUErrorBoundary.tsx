import { ReactNode } from 'react';
import { RefreshCw, Monitor } from 'lucide-react';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary';
import { createLogger } from '../../utils/logger';

const gpuLogger = createLogger('GPU');

interface GPUErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error) => void;
}

/**
 * Specialized error boundary for GPU video preview rendering.
 *
 * Provides:
 * - Recovery options for GPU rendering failures
 * - Retry button to attempt re-rendering
 * - Fallback UI when GPU preview is unavailable
 */
export function GPUErrorBoundary({ children, onError }: GPUErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <GPUErrorFallback error={error} onReset={reset} />
      )}
      onError={(error, errorInfo) => {
        gpuLogger.error('GPU rendering error:', error);
        gpuLogger.error('Component stack:', errorInfo.componentStack);
        onError?.(error);
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

interface GPUErrorFallbackProps {
  error: Error;
  onReset: () => void;
}

function GPUErrorFallback({ error, onReset }: GPUErrorFallbackProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-[var(--card)]">
      <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-6">
        <Monitor className="w-8 h-8 text-amber-600" />
      </div>
      <h2 className="text-xl font-semibold text-[var(--ink-black)] mb-2">
        GPU Rendering Failed
      </h2>
      <p className="text-[var(--text-muted)] mb-2 max-w-md">
        The video preview encountered a rendering error.
      </p>
      <p className="text-sm text-[var(--text-muted)] mb-6 max-w-md opacity-70">
        Your project is safe. Try again or check your GPU drivers.
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
          Retry
        </button>
      </div>
    </div>
  );
}

export default GPUErrorBoundary;
