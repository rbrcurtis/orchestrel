import { describe, expect, it } from 'vitest';
import { msUntil, startMemoryMaintainer } from './scheduler';

describe('msUntil', () => {
  it('computes positive ms to the next daily fire', () => {
    const ms = msUntil(2, 0);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(25 * 60 * 60 * 1000);
  });
});

describe('startMemoryMaintainer', () => {
  it('is idempotent and returns a stop function', () => {
    const stop1 = startMemoryMaintainer();
    const stop2 = startMemoryMaintainer();
    expect(typeof stop1).toBe('function');
    stop1();
    stop2();
  });
});
