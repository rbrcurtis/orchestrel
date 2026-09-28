import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDb } from '../memory-maintainer/db';
import { resolvePreferenceServer } from './maintain';

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
    db.prepare('INSERT INTO projects (id, memory_base_url, memory_api_key) VALUES (1, ?, ?)').run('https://db.mem', 'db-key');
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
