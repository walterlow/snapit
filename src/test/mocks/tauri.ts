import { vi, type Mock } from 'vitest';

// Mock Tauri invoke function
export const mockInvoke: Mock = vi.fn();

// Mock Tauri event functions
export const mockListen: Mock = vi.fn(() => Promise.resolve(() => {}));
export const mockEmit: Mock = vi.fn();
export const mockOnce: Mock = vi.fn(() => Promise.resolve(() => {}));

// Mock responses storage for invoke
const invokeResponses = new Map<string, unknown>();

// Helper to set mock response for a command
export function setInvokeResponse(command: string, response: unknown) {
  invokeResponses.set(command, response);
}

// Helper to set mock error for a command
export function setInvokeError(command: string, error: string) {
  invokeResponses.set(command, { __error: error });
}

// Helper to clear all mock responses
export function clearInvokeResponses() {
  invokeResponses.clear();
}

// Setup default invoke behavior
mockInvoke.mockImplementation((command: string, args?: unknown) => {
  const response = invokeResponses.get(command);
  if (response !== undefined) {
    if (typeof response === 'object' && response !== null && '__error' in response) {
      return Promise.reject(new Error((response as { __error: string }).__error));
    }
    return Promise.resolve(response);
  }
  // Default: return undefined for unknown commands
  console.warn(`[Tauri Mock] Unhandled invoke: ${command}`, args);
  return Promise.resolve(undefined);
});

// Event listeners storage
const eventListeners = new Map<string, Set<(event: unknown) => void>>();

// Helper to emit an event to listeners
export function emitMockEvent(event: string, payload: unknown) {
  const listeners = eventListeners.get(event);
  if (listeners) {
    listeners.forEach((listener) => listener({ payload }));
  }
}

// Mock listen implementation - set up handler
mockListen.mockImplementation(
  (event: string, handler: (event: unknown) => void): Promise<() => void> => {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, new Set());
    }
    eventListeners.get(event)!.add(handler);

    // Return unsubscribe function
    return Promise.resolve(() => {
      eventListeners.get(event)?.delete(handler);
    });
  }
);

// Mock the modules
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
  emit: mockEmit,
  once: mockOnce,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    listen: mockListen,
    emit: mockEmit,
    close: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    setFocus: vi.fn(),
    center: vi.fn(),
    setSize: vi.fn(),
    setPosition: vi.fn(),
  }),
  Window: {
    getByLabel: vi.fn(() => null),
  },
}));

vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeImage: vi.fn().mockResolvedValue(undefined),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn().mockResolvedValue(null),
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: vi.fn().mockResolvedValue(undefined),
  unregister: vi.fn().mockResolvedValue(undefined),
  unregisterAll: vi.fn().mockResolvedValue(undefined),
  isRegistered: vi.fn().mockResolvedValue(false),
}));
