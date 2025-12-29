import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportError, withErrorHandling, createErrorHandler } from './errorReporting';
import { toast } from 'sonner';

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

// Mock the logger
vi.mock('./logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('errorReporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reportError', () => {
    it('should show toast with user-friendly message for capture errors', () => {
      reportError(new Error('test error'), { operation: 'capture screen' });
      
      expect(toast.error).toHaveBeenCalledWith(
        'Unable to capture screen. Please try again.'
      );
    });

    it('should show toast with user-friendly message for save errors', () => {
      reportError('save failed', { operation: 'save capture' });
      
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to save. Check disk space and permissions.'
      );
    });

    it('should show toast with user-friendly message for clipboard errors', () => {
      reportError('clipboard error', { operation: 'clipboard copy' });
      
      expect(toast.error).toHaveBeenCalledWith(
        'Unable to copy to clipboard.'
      );
    });

    it('should use custom user message when provided', () => {
      reportError('error', { 
        operation: 'custom', 
        userMessage: 'Custom error message' 
      });
      
      expect(toast.error).toHaveBeenCalledWith('Custom error message');
    });

    it('should not show toast when silent is true', () => {
      reportError('error', { operation: 'background sync', silent: true });
      
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('should use fallback message for unknown operations', () => {
      reportError('error', { operation: 'unknown operation' });
      
      expect(toast.error).toHaveBeenCalledWith(
        'Something went wrong. Please try again.'
      );
    });

    it('should handle Error objects', () => {
      const error = new Error('Test error message');
      error.name = 'TestError';
      
      reportError(error, { operation: 'test' });
      
      expect(toast.error).toHaveBeenCalled();
    });

    it('should handle string errors', () => {
      reportError('string error message', { operation: 'test' });
      
      expect(toast.error).toHaveBeenCalled();
    });

    it('should handle object errors', () => {
      reportError({ code: 500, message: 'Server error' }, { operation: 'test' });
      
      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('withErrorHandling', () => {
    it('should return result on success', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      
      const result = await withErrorHandling(operation, { operation: 'test' });
      
      expect(result).toBe('success');
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('should return undefined on error', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('failed'));
      
      const result = await withErrorHandling(operation, { operation: 'test' });
      
      expect(result).toBeUndefined();
      expect(toast.error).toHaveBeenCalled();
    });

    it('should not show toast when silent is true on error', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('failed'));
      
      await withErrorHandling(operation, { operation: 'test', silent: true });
      
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('createErrorHandler', () => {
    it('should return a function that reports errors', () => {
      const handler = createErrorHandler({ operation: 'test' });
      
      expect(typeof handler).toBe('function');
      
      handler(new Error('test'));
      
      expect(toast.error).toHaveBeenCalled();
    });

    it('should pass context to reportError', () => {
      const handler = createErrorHandler({ 
        operation: 'save', 
        userMessage: 'Custom message' 
      });
      
      handler('error');
      
      expect(toast.error).toHaveBeenCalledWith('Custom message');
    });
  });
});
