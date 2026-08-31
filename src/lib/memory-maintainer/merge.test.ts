import { describe, expect, it } from 'vitest';
import { collectWeekEntries, groupByServer } from './merge';
import type { StagingEntry } from './staging';

describe('merge grouping', () => {
  it('groups staging entries strictly within one memory server set', () => {
    const entries: StagingEntry[] = [
      { project: 'trackable', apiUrl: 'https://memory.trackable.io', sessionId: 'a', source: 'a', ops: [{ op: 'store', title: 't1', text: 'x' }] },
      { project: 'trackable', apiUrl: 'https://memory.trackable.io', sessionId: 'b', source: 'b', ops: [{ op: 'store', title: 't2', text: 'y' }] },
      { project: 'okkanti', apiUrl: 'http://localhost:3100', sessionId: 'c', source: 'c', ops: [{ op: 'store', title: 't3', text: 'z' }] },
    ];
    const groups = groupByServer(entries);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === 'trackable@https://memory.trackable.io')?.entries).toHaveLength(2);
  });

  it('collectWeekEntries ignores merge files older than 7 days', () => {
    expect(collectWeekEntries('/nonexistent')).toEqual([]);
  });
});
