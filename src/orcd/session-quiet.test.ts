import { describe, expect, it } from 'bun:test';
import { QUIET_MS, waitForQuiet } from './session';

/** A fake clock + scripted streaming timeline: streaming for the listed poll indices. */
function harness(streamingPolls: Set<number>) {
  let poll = -1;
  let clock = 0;
  const deps = {
    pollMs: 100,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  const isStreaming = () => {
    poll += 1;
    return streamingPolls.has(poll);
  };
  return { isStreaming, deps, clockNow: () => clock };
}

describe('waitForQuiet', () => {
  it('returns immediately-ish when the agent was never streaming', async () => {
    const h = harness(new Set());
    const quiet = await waitForQuiet(h.isStreaming, h.deps);
    expect(quiet).toBe(true);
    expect(h.clockNow()).toBeGreaterThanOrEqual(QUIET_MS);
  });

  it('waits out a follow-up turn that starts after the settle', async () => {
    // Reference shape: polls 0-1 quiet (the settle), then a nudge turn streams, then quiet again.
    const h = harness(new Set([2, 3, 4]));
    const quiet = await waitForQuiet(h.isStreaming, h.deps);
    expect(quiet).toBe(true);
    // The quiet window restarts at the last streaming poll (index 4 => 400 ms), so the wait must
    // not end before that point plus QUIET_MS.
    expect(h.clockNow()).toBeGreaterThanOrEqual(4 * 100 + QUIET_MS);
  });

  it('gives up when the agent never stops streaming', async () => {
    const h = harness(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const quiet = await waitForQuiet(h.isStreaming, { ...h.deps, maxMs: 500 });
    expect(quiet).toBe(false);
  });
});
