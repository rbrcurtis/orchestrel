import { describe, expect, it } from 'vitest';
import { reduceTranscriptState } from './transcript-reducer';
import type { TranscriptState } from './transcript-sync';

// A settle replaces the baseline with a fresh tail of the session. The start
// metadata belongs to the session, not to the baseline, so it has to survive.
describe('reduceTranscriptState baseline replacement', () => {
  it('keeps the session start when a settle replaces the baseline', () => {
    const state: TranscriptState = {
      start: { model: 'deepseek-flash', timestamp: 1793135597223 },
      baseline: [],
      baselineThrough: 0,
      overlay: [],
      events: [],
    };

    const next = reduceTranscriptState(state, { type: 'baseline_replaced', entries: [], coveredThrough: 4 });

    expect(next.start).toEqual({ model: 'deepseek-flash', timestamp: 1793135597223 });
  });
});
