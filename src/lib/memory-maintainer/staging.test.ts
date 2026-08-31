import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { appendStaging, readStagingFile } from './staging';
import type { StagingEntry } from './staging';

describe('staging', () => {
  it('appends entries to a per-day file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-stage-'));
    const entry: StagingEntry = {
      project: 'trackable',
      apiUrl: 'https://memory.trackable.io',
      sessionId: 's1',
      source: 'a.jsonl',
      ops: [{ op: 'store', title: 't', text: 'x' }],
    };
    const file = appendStaging(dir, entry);
    appendStaging(dir, { ...entry, sessionId: 's2' });
    const day = readStagingFile(file);
    expect(day?.entries).toHaveLength(2);
    expect(JSON.parse(readFileSync(file, 'utf8')).date).toBe(new Date().toISOString().slice(0, 10));
  });
});
