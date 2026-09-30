import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/memory-maintainer/maintain', () => ({ runMaintain: vi.fn(async () => ({ projects: [] })) }));
vi.mock('../lib/memory-maintainer/merge', () => ({ runMerge: vi.fn(async () => ({ groups: 0 })) }));
vi.mock('../lib/preference-maintainer/maintain', () => ({ runPreferences: vi.fn(async () => ({ users: [] })) }));
vi.mock('../shared/config', () => ({
  loadConfig: () => ({ memory: { preferences: { apiUrl: 'http://memory.test', project: 'preferences' } } }),
}));

import { runMaintain } from '../lib/memory-maintainer/maintain';
import { runMerge } from '../lib/memory-maintainer/merge';
import { runPreferences } from '../lib/preference-maintainer/maintain';
import { msUntil, startMaintainerScheduler, stopMaintainerScheduler } from './maintainer-scheduler';

const HOUR = 60 * 60 * 1000;

describe('msUntil', () => {
  it('computes positive ms to the next daily fire', () => {
    const ms = msUntil(2, 0);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(25 * HOUR);
  });
});

describe('startMaintainerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday 2026-09-30, 01:00 local time.
    vi.setSystemTime(new Date(2026, 8, 30, 1, 0, 0));
  });

  afterEach(() => {
    stopMaintainerScheduler();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('runs nothing before a fire time', () => {
    startMaintainerScheduler();
    expect(runMaintain).not.toHaveBeenCalled();
    expect(runMerge).not.toHaveBeenCalled();
    expect(runPreferences).not.toHaveBeenCalled();
  });

  it('runs the memory daily job at 02:00 and nothing else', async () => {
    startMaintainerScheduler();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(runMaintain).toHaveBeenCalledTimes(1);
    expect(runMerge).not.toHaveBeenCalled();
    expect(runPreferences).not.toHaveBeenCalled();
  });

  it('runs the preferences job at the next midnight', async () => {
    startMaintainerScheduler();
    await vi.advanceTimersByTimeAsync(23 * HOUR);
    expect(runPreferences).toHaveBeenCalledTimes(1);
    expect(runMaintain).toHaveBeenCalledTimes(1);
  });

  it('runs the weekly merge on Sunday 03:00 only', async () => {
    startMaintainerScheduler();
    // Wednesday 01:00 -> Sunday 03:00 is four days and two hours.
    await vi.advanceTimersByTimeAsync(4 * 24 * HOUR + 2 * HOUR);
    expect(runMerge).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second start does not double-schedule', async () => {
    startMaintainerScheduler();
    startMaintainerScheduler();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(runMaintain).toHaveBeenCalledTimes(1);
  });
});
