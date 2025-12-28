import { describe, it, expect } from 'vitest';

describe('Test Infrastructure', () => {
  it('should run a basic test', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have Tauri mocks available', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    expect(invoke).toBeDefined();
  });
});
