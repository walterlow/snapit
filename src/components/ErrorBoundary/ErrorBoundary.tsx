import { Component, ReactNode } from 'react';
import { reportError } from '../../utils/errorReporting';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  /** Keys that trigger reset when changed (e.g., project ID) */
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary component that catches render errors in children.
 *
 * Features:
 * - Catches JavaScript errors in child component tree
 * - Logs errors via the error reporting system
 * - Shows fallback UI instead of crashing
 * - Auto-resets when resetKeys change
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log to our error reporting system
    reportError(error, {
      operation: 'React render',
      userMessage: 'Something went wrong',
      silent: false,
    });

    // Log component stack for debugging
    console.error('Error Boundary caught an error:', error);
    console.error('Component stack:', errorInfo.componentStack);

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Reset error state when resetKeys change
    if (
      this.state.hasError &&
      this.props.resetKeys &&
      prevProps.resetKeys &&
      !arraysEqual(this.props.resetKeys, prevProps.resetKeys)
    ) {
      this.reset();
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      const { error } = this.state;

      // If fallback is a function, call it with error and reset
      if (typeof fallback === 'function') {
        return fallback(error!, this.reset);
      }

      // If fallback is provided as element, use it
      if (fallback) {
        return fallback;
      }

      // Default fallback
      return <DefaultErrorFallback error={error} onReset={this.reset} />;
    }

    return this.props.children;
  }
}

// Helper to compare arrays
function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

// Default fallback component
interface DefaultErrorFallbackProps {
  error: Error | null;
  onReset: () => void;
}

function DefaultErrorFallback({ error, onReset }: DefaultErrorFallbackProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
        <svg
          className="w-6 h-6 text-red-500"
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
      <h2 className="text-lg font-medium text-[var(--ink-black)] mb-2">
        Something went wrong
      </h2>
      <p className="text-sm text-[var(--text-muted)] mb-4 max-w-md">
        {error?.message || 'An unexpected error occurred.'}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onReset}
          className="px-4 py-2 text-sm font-medium text-white bg-[var(--aurora-blue)] rounded-lg hover:opacity-90 transition-opacity"
        >
          Try Again
        </button>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm font-medium text-[var(--ink-black)] bg-[var(--polar-frost)] rounded-lg hover:bg-[var(--polar-snow)] transition-colors"
        >
          Reload App
        </button>
      </div>
    </div>
  );
}

export default ErrorBoundary;
