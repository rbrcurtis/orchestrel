import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDb } from '../memory-maintainer/db';
import { estTokens, pruneToBudget, resolvePreferenceServer } from './maintain';

const PREFS = { apiUrl: 'https://default.mem', apiKey: 'env-key', project: 'preferences', stalenessDays: 30 };

let dir: string;
let oldPath: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pref-resolve-'));
  oldPath = process.env.ORCHESTREL_DB_PATH;
  process.env.ORCHESTREL_DB_PATH = join(dir, 'test.db');
  // getDb only creates the maintainer tables; stand up a minimal projects table.
  getDb().exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, memory_base_url TEXT, memory_api_key TEXT)');
});
afterEach(() => {
  if (oldPath === undefined) delete process.env.ORCHESTREL_DB_PATH;
  else process.env.ORCHESTREL_DB_PATH = oldPath;
  resetDb();
});

describe('resolvePreferenceServer', () => {
  it('prefers the project-row memory url/key over the config default', () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, memory_base_url, memory_api_key) VALUES (1, ?, ?)').run(
      'https://db.mem',
      'db-key',
    );
    expect(resolvePreferenceServer(db, PREFS)).toEqual({
      apiUrl: 'https://db.mem',
      apiKey: 'db-key',
      project: 'preferences',
    });
  });

  it('falls back to the config default when no project row carries a key', () => {
    expect(resolvePreferenceServer(getDb(), PREFS)).toEqual({
      apiUrl: 'https://default.mem',
      apiKey: 'env-key',
      project: 'preferences',
    });
  });

  it('ignores rows with a blank key', () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, memory_base_url, memory_api_key) VALUES (1, ?, ?)').run('https://db.mem', '');
    expect(resolvePreferenceServer(db, PREFS).apiKey).toBe('env-key');
  });
});

describe('pruneToBudget', () => {
  const line = (s: string, seen: string) => `${'x'.repeat(80)} ${s} (seen: ${seen})`;

  it('returns the text unchanged when it fits the budget', () => {
    const text = [line('a', '2026-09-28'), line('b', '2026-09-29')].join('\n');
    expect(pruneToBudget(text, 2000)).toBe(text);
  });

  it('keeps the most recently seen lines first and preserves original order', () => {
    const old = line('oldest', '2026-08-01');
    const mid = line('middle', '2026-09-10');
    const recent = line('recent', '2026-09-29');
    // Budget fits exactly two of the three lines.
    const maxTokens = estTokens(recent) + estTokens(mid) + 1;
    const out = pruneToBudget([old, mid, recent].join('\n'), maxTokens);
    const outLines = out.split('\n');
    expect(outLines).toHaveLength(2);
    // Original order preserved: middle (idx 1) then recent (idx 2).
    expect(outLines[0]).toContain('middle');
    expect(outLines[1]).toContain('recent');
    expect(estTokens(out)).toBeLessThanOrEqual(maxTokens);
  });

  it('keeps the single most recent line when nothing fits', () => {
    const huge = 'y'.repeat(9999) + ' (seen: 2026-09-01)';
    const newer = 'z' + ' (seen: 2026-09-29)';
    const out = pruneToBudget(`${huge}\n${newer}`, 5);
    expect(out).toBe(newer);
  });

  it('returns empty for empty text', () => {
    expect(pruneToBudget('', 100)).toBe('');
  });
});
