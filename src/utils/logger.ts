/**
 * Unified logging system for SnapIt frontend.
 * 
 * In dev mode:
 * - Intercepts all console.* calls and sends to backend
 * - Logs all Tauri events automatically
 * - Press Ctrl+Shift+L to open log directory
 * 
 * In production:
 * - Only explicit logger calls are persisted
 * - Errors are always logged
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Track if dev mode logging is enabled
let devModeEnabled = false;
let eventUnlisteners: UnlistenFn[] = [];

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

interface LogEntry {
  level: LogLevel;
  source: string;
  message: string;
  timestamp: number;
}

// Buffer for batching logs
let logBuffer: LogEntry[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 1000; // Flush every 1 second
const MAX_BUFFER_SIZE = 50; // Or when buffer reaches this size

/**
 * Flush buffered logs to backend
 */
async function flushLogs(): Promise<void> {
  if (logBuffer.length === 0) return;

  const logsToSend = logBuffer;
  logBuffer = [];

  try {
    await invoke('write_logs', {
      logs: logsToSend.map(log => [log.level, log.source, log.message])
    });
  } catch (error) {
    // If backend fails, just log to console
    console.error('[Logger] Failed to write logs to backend:', error);
  }
}

/**
 * Schedule a flush if not already scheduled
 */
function scheduleFlush(): void {
  if (flushTimeout) return;
  
  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    flushLogs();
  }, FLUSH_INTERVAL);
}

/**
 * Add a log entry to the buffer
 */
function addLog(level: LogLevel, source: string, message: string): void {
  const entry: LogEntry = {
    level,
    source,
    message,
    timestamp: Date.now(),
  };

  logBuffer.push(entry);

  // Flush immediately if buffer is full or if it's an error
  if (logBuffer.length >= MAX_BUFFER_SIZE || level === 'error') {
    flushLogs();
  } else {
    scheduleFlush();
  }
}

/**
 * Format arguments into a string message
 */
function formatMessage(...args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

/**
 * Create a logger instance for a specific source/module
 */
export function createLogger(source: string) {
  return {
    debug(...args: unknown[]): void {
      const message = formatMessage(...args);
      // Use original console to avoid double-logging when dev mode intercepts console
      if (import.meta.env.DEV) {
        originalConsole.debug(`[${source}]`, ...args);
      }
      addLog('debug', source, message);
    },

    info(...args: unknown[]): void {
      const message = formatMessage(...args);
      if (import.meta.env.DEV) {
        originalConsole.info(`[${source}]`, ...args);
      }
      addLog('info', source, message);
    },

    warn(...args: unknown[]): void {
      const message = formatMessage(...args);
      originalConsole.warn(`[${source}]`, ...args);
      addLog('warn', source, message);
    },

    error(...args: unknown[]): void {
      const message = formatMessage(...args);
      originalConsole.error(`[${source}]`, ...args);
      addLog('error', source, message);
    },

    /**
     * Log with explicit level
     */
    log(level: LogLevel, ...args: unknown[]): void {
      const message = formatMessage(...args);
      if (import.meta.env.DEV || level === 'warn' || level === 'error') {
        originalConsole[level](`[${source}]`, ...args);
      }
      addLog(level, source, message);
    },
  };
}

// Default logger for general use
export const logger = createLogger('App');

// Pre-created loggers for common modules
export const recordingLogger = createLogger('Recording');
export const captureLogger = createLogger('Capture');
export const libraryLogger = createLogger('Library');
export const editorLogger = createLogger('Editor');

/**
 * Flush all pending logs immediately (call on app shutdown)
 */
export async function flushAllLogs(): Promise<void> {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  await flushLogs();
}

/**
 * Get the log directory path
 */
export async function getLogDirectory(): Promise<string> {
  return invoke<string>('get_log_dir');
}

/**
 * Open the log directory in file explorer
 */
export async function openLogDirectory(): Promise<void> {
  await invoke('open_log_dir');
}

/**
 * Get recent log entries
 */
export async function getRecentLogs(lines = 100): Promise<string> {
  return invoke<string>('get_recent_logs', { lines });
}

// ============================================================================
// Dev Mode - Automatic Console Interception & Event Logging
// ============================================================================

/**
 * Events to automatically log in dev mode
 * Note: Only logged from main window to avoid duplicates from overlay windows
 */
const EVENTS_TO_LOG = [
  'recording-state-changed',
  'recording-format',
  'capture-complete',
  'capture-complete-fast',
  'open-settings',
  // Excluded: 'reset-overlay' (fires for each monitor), 'selection-update' (too verbose)
];

/**
 * Enable dev mode logging:
 * - Intercepts all console.* calls
 * - Logs all Tauri events (main window only to avoid duplicates)
 * - Adds Ctrl+Shift+L shortcut to open logs
 */
export async function enableDevMode(): Promise<void> {
  if (devModeEnabled) return;
  devModeEnabled = true;

  const devLog = createLogger('Console');

  // Intercept console methods
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    addLog('debug', 'Console', formatMessage(...args));
  };

  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    addLog('debug', 'Console', formatMessage(...args));
  };

  console.info = (...args: unknown[]) => {
    originalConsole.info(...args);
    addLog('info', 'Console', formatMessage(...args));
  };

  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    addLog('warn', 'Console', formatMessage(...args));
  };

  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    addLog('error', 'Console', formatMessage(...args));
  };

  // Only listen to Tauri events from main window to avoid duplicate logs
  // Overlay windows and recording controls windows skip event logging
  const isMainWindow = window.location.pathname === '/' || window.location.pathname === '/index.html';
  
  if (isMainWindow) {
    // Set up all event listeners in parallel for faster startup
    const listenerPromises = EVENTS_TO_LOG.map(async (eventName) => {
      try {
        const unlisten = await listen(eventName, (event) => {
          addLog('debug', 'Event', `${eventName}: ${JSON.stringify(event.payload)}`);
        });
        return unlisten;
      } catch (e) {
        devLog.warn(`Failed to listen to event ${eventName}:`, e);
        return null;
      }
    });

    const results = await Promise.all(listenerPromises);
    eventUnlisteners.push(...results.filter((fn): fn is UnlistenFn => fn !== null));
  }

  // Add keyboard shortcut to open logs (Ctrl+Shift+L)
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      e.preventDefault();
      openLogDirectory().catch(console.error);
    }
  };
  window.addEventListener('keydown', handleKeyDown);

  // Log uncaught errors
  window.addEventListener('error', (event) => {
    addLog('error', 'Uncaught', `${event.message} at ${event.filename}:${event.lineno}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    addLog('error', 'UnhandledPromise', String(event.reason));
  });

  // Only log from main window to avoid duplicate "dev mode enabled" messages
  if (isMainWindow) {
    devLog.info('Dev mode enabled - Ctrl+Shift+L to open logs');
  }
}

/**
 * Disable dev mode logging
 */
export function disableDevMode(): void {
  if (!devModeEnabled) return;
  devModeEnabled = false;

  // Restore original console methods
  console.log = originalConsole.log;
  console.debug = originalConsole.debug;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;

  // Unsubscribe from events
  for (const unlisten of eventUnlisteners) {
    unlisten();
  }
  eventUnlisteners = [];
}

/**
 * Check if dev mode is enabled
 */
export function isDevModeEnabled(): boolean {
  return devModeEnabled;
}

/**
 * Initialize logging - call this once at app startup
 * Automatically enables dev mode in development builds
 */
export async function initializeLogging(): Promise<void> {
  // Always enable in dev, or check for debug flag in production
  if (import.meta.env.DEV) {
    await enableDevMode();
  }
  
  // Flush logs before page unload
  window.addEventListener('beforeunload', () => {
    flushAllLogs();
  });
}
