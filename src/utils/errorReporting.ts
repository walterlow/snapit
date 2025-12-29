/**
 * Unified error reporting for SnapIt frontend.
 *
 * Provides consistent error handling that:
 * - Always logs to persistent file via the logger (developer-friendly, full details)
 * - Optionally shows toast notification to user (user-friendly, no technical jargon)
 * - Preserves error context for debugging
 */

import { toast } from 'sonner';
import { createLogger } from './logger';

const errorLogger = createLogger('Error');

/**
 * User-friendly error messages mapped by operation category.
 * These are shown to users instead of technical error details.
 */
const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  // Capture operations
  capture: 'Unable to capture screen. Please try again.',
  screenshot: 'Unable to capture screenshot. Please try again.',
  fullscreen: 'Unable to capture fullscreen. Please try again.',
  monitors: 'Unable to capture monitors. Please try again.',
  recording: 'Recording failed. Please try again.',
  
  // File operations
  save: 'Failed to save. Check disk space and permissions.',
  export: 'Failed to export. Check disk space and permissions.',
  delete: 'Failed to delete capture.',
  load: 'Unable to load capture.',
  
  // Clipboard operations
  clipboard: 'Unable to copy to clipboard.',
  copy: 'Unable to copy to clipboard.',
  
  // Media operations
  webcam: 'Webcam error. Check if another app is using it.',
  media: 'Unable to open file.',
  
  // Folder operations
  folder: 'Unable to open folder location.',
  
  // Settings operations
  settings: 'Failed to save settings.',
};

export interface ErrorContext {
  /** What operation was being performed when the error occurred */
  operation: string;
  /** Optional user-friendly message to show in toast (overrides automatic mapping) */
  userMessage?: string;
  /** If true, log to file but don't show toast to user */
  silent?: boolean;
}

/**
 * Format an error into a loggable string with full technical details.
 * This is for developer logs, not user-facing messages.
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
 * Get a user-friendly message for an operation.
 * Extracts the first word as the category and looks up a friendly message.
 */
function getUserFriendlyMessage(operation: string, customMessage?: string): string {
  if (customMessage) {
    return customMessage;
  }
  
  // Extract first word as category (e.g., "capture screen" → "capture")
  const category = operation.split(' ')[0].toLowerCase();
  
  return USER_FRIENDLY_MESSAGES[category] ?? 'Something went wrong. Please try again.';
}

/**
 * Report an error consistently - logs to file and optionally shows toast.
 *
 * @param error - The error object or message
 * @param context - Context about what was happening when the error occurred
 *
 * @example
 * // Auto-mapped user message based on operation
 * reportError(error, { operation: 'capture screen' });
 * // → Logs full error, shows "Unable to capture screen. Please try again."
 *
 * @example
 * // Custom user message
 * reportError(error, { operation: 'save capture', userMessage: 'Could not save your work' });
 *
 * @example
 * // Silent - log only, no toast
 * reportError(error, { operation: 'background sync', silent: true });
 */
export function reportError(error: unknown, context: ErrorContext): void {
  const errorMessage = formatError(error);

  // Always log to persistent file with full technical context
  errorLogger.error(`[${context.operation}] ${errorMessage}`);

  // Show user-friendly toast unless silent mode
  if (!context.silent) {
    const displayMessage = getUserFriendlyMessage(context.operation, context.userMessage);
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
