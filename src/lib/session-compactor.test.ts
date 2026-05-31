import { describe, expect, it, vi } from 'vitest';
import { applyCompaction } from './session-compactor';

describe('applyCompaction', () => {
  it('delegates compaction to a Pi session', async () => {
    const compact = vi.fn(async () => ({
      messagesBefore: 20,
      messagesCovered: 10,
      summaryTokens: 143,
      summaryChars: 500,
      durationMs: 42,
    }));

    const result = await applyCompaction({
      sessionId: 's1',
      messagesBefore: 0,
      messagesCovered: 0,
      summaryChars: 0,
      prepareDurationMs: 0,
      compact,
    });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      sessionId: 's1',
      messagesBefore: 20,
      messagesCovered: 10,
      summaryTokens: 143,
      summaryChars: 500,
      durationMs: 42,
    });
  });

  it('returns sane defaults when Pi compact returns no metadata', async () => {
    const result = await applyCompaction({
      sessionId: 's2',
      messagesBefore: 7,
      messagesCovered: 3,
      summaryChars: 350,
      prepareDurationMs: 0,
      compact: vi.fn(async () => undefined),
    });

    expect(result.sessionId).toBe('s2');
    expect(result.messagesBefore).toBe(7);
    expect(result.messagesCovered).toBe(3);
    expect(result.summaryChars).toBe(350);
    expect(result.summaryTokens).toBe(100);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
