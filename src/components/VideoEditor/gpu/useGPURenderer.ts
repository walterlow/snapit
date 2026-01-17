/**
 * useGPURenderer - GPU device management with device lost recovery.
 *
 * This hook manages GPU device lifecycle and provides automatic recovery
 * when the GPU device is lost due to:
 * - Driver crashes
 * - GPU timeout (TDR on Windows)
 * - Switching between integrated/discrete GPUs
 * - Resource pressure
 *
 * The GPU rendering is performed by Rust (wgpu), and this hook communicates
 * with the backend via Tauri invoke commands.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { videoEditorLogger } from '@/utils/logger';

/** Device lost reason categories */
type DeviceLostReason = 'destroyed' | 'driver_crash' | 'timeout' | 'resource_pressure' | 'unknown';

/** GPU device state */
interface GPUDeviceState {
  /** Whether the device is currently available */
  isAvailable: boolean;
  /** Whether recovery is in progress */
  isRecovering: boolean;
  /** Number of recovery attempts made */
  recoveryAttempts: number;
  /** Last error message if any */
  lastError: string | null;
  /** Last device lost reason */
  lastLostReason: DeviceLostReason | null;
}

interface UseGPURendererOptions {
  /** Callback when device is lost and cannot be recovered */
  onDeviceLost?: () => void;
  /** Callback when device is successfully recovered */
  onDeviceRecovered?: () => void;
  /** Callback on any GPU error */
  onError?: (error: string) => void;
  /** Maximum number of recovery attempts before giving up */
  maxRecoveryAttempts?: number;
  /** Delay between recovery attempts in milliseconds */
  recoveryDelayMs?: number;
}

interface UseGPURendererResult {
  /** Current device state */
  deviceState: GPUDeviceState;
  /** Initialize the GPU preview system */
  initPreview: () => Promise<boolean>;
  /** Shutdown the GPU preview system */
  shutdownPreview: () => Promise<void>;
  /** Manually trigger device recovery */
  recoverDevice: () => Promise<boolean>;
  /** Reset recovery attempt counter */
  resetRecoveryCounter: () => void;
  /** Handle GPU errors from backend - triggers recovery if device lost */
  handleGPUError: (error: string) => Promise<void>;
}

/** Error patterns that indicate device lost scenarios */
const DEVICE_LOST_PATTERNS = [
  /device.*lost/i,
  /gpu.*lost/i,
  /adapter.*lost/i,
  /driver.*crash/i,
  /tdr/i,
  /timeout.*detection/i,
  /device.*removed/i,
  /device.*reset/i,
  /gpu.*hang/i,
  /wgpu.*device.*error/i,
];

/** Error patterns that indicate intentional destruction (no recovery needed) */
const INTENTIONAL_DESTROY_PATTERNS = [
  /destroyed.*intentionally/i,
  /device.*destroyed/i,
  /shutdown/i,
];

/**
 * Determine the device lost reason from an error message.
 */
function categorizeDeviceLostReason(error: string): DeviceLostReason {
  const lowerError = error.toLowerCase();

  // Check if this was an intentional destruction
  for (const pattern of INTENTIONAL_DESTROY_PATTERNS) {
    if (pattern.test(error)) {
      return 'destroyed';
    }
  }

  // Check for specific device lost scenarios
  if (lowerError.includes('tdr') || lowerError.includes('timeout')) {
    return 'timeout';
  }

  if (lowerError.includes('driver') || lowerError.includes('crash')) {
    return 'driver_crash';
  }

  if (lowerError.includes('resource') || lowerError.includes('memory') || lowerError.includes('oom')) {
    return 'resource_pressure';
  }

  return 'unknown';
}

/**
 * Check if an error indicates a device lost scenario.
 */
function isDeviceLostError(error: string): boolean {
  return DEVICE_LOST_PATTERNS.some(pattern => pattern.test(error));
}

/**
 * Hook for managing GPU device lifecycle with automatic recovery.
 */
export function useGPURenderer(options: UseGPURendererOptions = {}): UseGPURendererResult {
  const {
    onDeviceLost,
    onDeviceRecovered,
    onError,
    maxRecoveryAttempts = 3,
    recoveryDelayMs = 1000,
  } = options;

  const [deviceState, setDeviceState] = useState<GPUDeviceState>({
    isAvailable: false,
    isRecovering: false,
    recoveryAttempts: 0,
    lastError: null,
    lastLostReason: null,
  });

  // Refs for callbacks to avoid stale closures
  const onDeviceLostRef = useRef(onDeviceLost);
  const onDeviceRecoveredRef = useRef(onDeviceRecovered);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onDeviceLostRef.current = onDeviceLost;
    onDeviceRecoveredRef.current = onDeviceRecovered;
    onErrorRef.current = onError;
  }, [onDeviceLost, onDeviceRecovered, onError]);

  // Track if component is mounted for async operations
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Track recovery attempts with ref to avoid stale closures in async callbacks
  const recoveryAttemptsRef = useRef(0);
  // Track if recovery is in progress to prevent concurrent attempts
  const isRecoveringRef = useRef(false);

  /**
   * Initialize the GPU preview system via Rust backend.
   */
  const initPreview = useCallback(async (): Promise<boolean> => {
    try {
      await invoke('init_preview');

      if (isMountedRef.current) {
        setDeviceState(prev => ({
          ...prev,
          isAvailable: true,
          isRecovering: false,
          lastError: null,
        }));
      }

      videoEditorLogger.info('GPU preview initialized successfully');
      return true;
    } catch (error) {
      const errorMessage = String(error);
      videoEditorLogger.error('GPU preview initialization failed:', errorMessage);

      if (isMountedRef.current) {
        setDeviceState(prev => ({
          ...prev,
          isAvailable: false,
          lastError: errorMessage,
        }));
      }

      onErrorRef.current?.(errorMessage);
      return false;
    }
  }, []);

  /**
   * Shutdown the GPU preview system.
   */
  const shutdownPreview = useCallback(async (): Promise<void> => {
    try {
      await invoke('shutdown_preview');

      if (isMountedRef.current) {
        setDeviceState(prev => ({
          ...prev,
          isAvailable: false,
          lastLostReason: 'destroyed',
        }));
      }

      videoEditorLogger.info('GPU preview shutdown');
    } catch (error) {
      videoEditorLogger.error('GPU preview shutdown failed:', error);
    }
  }, []);

  /**
   * Attempt to recover from device lost.
   */
  const recoverDevice = useCallback(async (): Promise<boolean> => {
    // Prevent concurrent recovery attempts
    if (isRecoveringRef.current) {
      videoEditorLogger.warn('GPU recovery already in progress, skipping');
      return false;
    }

    // Use ref to avoid stale closure issues with rapid calls
    const currentAttempts = recoveryAttemptsRef.current;
    if (currentAttempts >= maxRecoveryAttempts) {
      videoEditorLogger.error('GPU recovery failed: max attempts exceeded', {
        attempts: currentAttempts,
        max: maxRecoveryAttempts,
      });
      onDeviceLostRef.current?.();
      return false;
    }

    // Mark recovery as in progress
    isRecoveringRef.current = true;
    recoveryAttemptsRef.current = currentAttempts + 1;

    videoEditorLogger.warn('Attempting GPU device recovery', {
      attempt: currentAttempts + 1,
      maxAttempts: maxRecoveryAttempts,
    });

    if (isMountedRef.current) {
      setDeviceState(prev => ({
        ...prev,
        isRecovering: true,
        recoveryAttempts: recoveryAttemptsRef.current,
      }));
    }

    // Wait before attempting recovery (allows driver/GPU to stabilize)
    await new Promise(resolve => setTimeout(resolve, recoveryDelayMs));

    // Attempt to reinitialize
    try {
      // First try to shutdown any existing resources
      try {
        await invoke('shutdown_preview');
      } catch {
        // Ignore shutdown errors during recovery
      }

      // Wait a bit more after shutdown
      await new Promise(resolve => setTimeout(resolve, recoveryDelayMs / 2));

      // Request new GPU device
      await invoke('init_preview');

      // Reset recovery counter on success
      recoveryAttemptsRef.current = 0;
      isRecoveringRef.current = false;

      if (isMountedRef.current) {
        setDeviceState(prev => ({
          ...prev,
          isAvailable: true,
          isRecovering: false,
          lastError: null,
          recoveryAttempts: 0,
        }));
      }

      videoEditorLogger.info('GPU device recovered successfully');
      onDeviceRecoveredRef.current?.();
      return true;
    } catch (error) {
      const errorMessage = String(error);
      isRecoveringRef.current = false;

      videoEditorLogger.error('GPU recovery attempt failed:', {
        error: errorMessage,
        attempt: currentAttempts + 1,
      });

      if (isMountedRef.current) {
        setDeviceState(prev => ({
          ...prev,
          isRecovering: false,
          lastError: errorMessage,
        }));
      }

      onErrorRef.current?.(errorMessage);

      // If we haven't hit max attempts, we could retry
      // But we leave it to the caller to decide
      return false;
    }
  }, [maxRecoveryAttempts, recoveryDelayMs]);

  /**
   * Reset recovery attempt counter.
   */
  const resetRecoveryCounter = useCallback(() => {
    recoveryAttemptsRef.current = 0;
    setDeviceState(prev => ({
      ...prev,
      recoveryAttempts: 0,
    }));
  }, []);

  /**
   * Handle GPU errors from the backend and trigger recovery if needed.
   */
  const handleGPUError = useCallback(
    async (error: string) => {
      videoEditorLogger.warn('GPU error detected:', error);

      // Check if this is a device lost scenario
      if (isDeviceLostError(error)) {
        const reason = categorizeDeviceLostReason(error);
        videoEditorLogger.warn('GPU device lost:', { reason, error });

        if (isMountedRef.current) {
          setDeviceState(prev => ({
            ...prev,
            isAvailable: false,
            lastError: error,
            lastLostReason: reason,
          }));
        }

        // Don't attempt recovery for intentional destruction
        if (reason === 'destroyed') {
          videoEditorLogger.info('GPU device was intentionally destroyed, no recovery needed');
          return;
        }

        // Attempt recovery
        await recoverDevice();
      } else {
        // Non-device-lost error
        onErrorRef.current?.(error);
      }
    },
    [recoverDevice]
  );

  return {
    deviceState,
    initPreview,
    shutdownPreview,
    recoverDevice,
    resetRecoveryCounter,
    handleGPUError,
  };
}

export default useGPURenderer;
export type { GPUDeviceState, DeviceLostReason, UseGPURendererOptions, UseGPURendererResult };
