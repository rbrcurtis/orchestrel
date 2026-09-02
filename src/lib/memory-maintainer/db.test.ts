import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRun, getDb, insertRun, recentActiveRun, resetDb, upsertWatermark } from './db';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-db-'));
  process.env.ORCHESTREL_DB_PATH = join(dir, 'test.db');
});
afterEach(() => {
  delete process.env.ORCHESTREL_DB_PATH;
  resetDb();
});

describe('maintainer db', () => {
  it('creates tables and tracks watermarks', () => {
    const db = getDb();
    upsertWatermark(db, '/s/1.jsonl', 100, 50);
    const row = db.prepare('SELECT mtime_ms, size FROM memory_maintainer_watermark WHERE path = ?').get('/s/1.jsonl');
    expect(row).toEqual({ mtime_ms: 100, size: 50 });
  });

  it('records runs with status transitions', () => {
    const db = getDb();
    const id = insertRun(db, 'daily', '2026-08-31T00:00:00Z');
    finishRun(db, id, 'done', '{"sessions":2}');
    const row = db.prepare('SELECT status, summary_json FROM memory_maintainer_runs WHERE id = ?').get(id);
    expect(row).toMatchObject({ status: 'done', summary_json: '{"sessions":2}' });
  });
});

describe('recentActiveRun', () => {
  it('blocks the earlier run when a later fresh run of the same type exists', () => {
    const db = getDb();
    const earlier = insertRun(db, 'daily', new Date().toISOString());
    const later = insertRun(db, 'daily', new Date().toISOString());
    expect(recentActiveRun(db, 'daily', earlier)).toBe(true); // earlier sees later
    expect(recentActiveRun(db, 'daily', later)).toBe(false); // later sees only itself
  });

  it('ignores stale running runs of the same type', () => {
    const db = getDb();
    const mine = insertRun(db, 'daily', new Date().toISOString());
    insertRun(db, 'daily', new Date(Date.now() - 7 * 3600_000).toISOString());
    expect(recentActiveRun(db, 'daily', mine)).toBe(false); // stale daily ignored
  });
});
