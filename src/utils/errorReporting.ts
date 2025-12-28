/**
 * Unified error reporting for SnapIt frontend.
 *
 * Provides consistent error handling that:
 * - Always logs to persistent file via the logger
 * - Optionally shows toast notification to user
 * - Preserves error context for debugging
 */

import { toast } from 'sonner';
import { createLogger } from './logger';

const errorLogger = createLogger('Error');

export interface ErrorContext {
  /** What operation was being performed when the error occurred */
  operation: string;
  /** Optional user-friendly message to show in toast (defaults to operation) */
  userMessage?: string;
  /** If true, log to file but don't show toast to user */
  silent?: boolean;
}

/**
 * Format an error into a loggable string
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Report an error consistently - logs to file and optionally shows toast.
 *
 * @param error - The error object or message
 * @param context - Context about what was happening when the error occurred
 *
 * @example
 * // Show toast with error
 * reportError(error, { operation: 'save capture', userMessage: 'Failed to save' });
 *
 * @example
 * // Silent - log only, no toast
 * reportError(error, { operation: 'background sync', silent: true });
 */
export function reportError(error: unknown, context: ErrorContext): void {
  const errorMessage = formatError(error);

  // Always log to persistent file with full context
  errorLogger.error(`[${context.operation}] ${errorMessage}`);

  // Show toast unless silent mode
  if (!context.silent) {
    const displayMessage = context.userMessage || `Failed: ${context.operation}`;
    toast.error(displayMessage);
  }
}

/**
 * Wrap an async operation with consistent error handling.
 * Returns the result on success, or undefined on failure.
 *
 * @param operation - The async function to execute
 * @param context - Error context for reporting
 * @returns Promise resolving to the result or undefined on error
 *
 * @example
 * const result = await withErrorHandling(
 *   () => invoke('save_capture', { data }),
 *   { operation: 'save capture', userMessage: 'Failed to save your capture' }
 * );
 * if (result) {
 *   // success
 * }
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: ErrorContext
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    reportError(error, context);
    return undefined;
  }
}

/**
 * Create a catch handler for promise chains.
 * Useful for fire-and-forget operations that still need error logging.
 *
 * @param context - Error context for reporting
 * @returns A catch handler function
 *
 * @example
 * invoke('cleanup').catch(createErrorHandler({ operation: 'cleanup', silent: true }));
 */
export function createErrorHandler(
  context: ErrorContext
): (error: unknown) => void {
  return (error: unknown) => reportError(error, context);
}
