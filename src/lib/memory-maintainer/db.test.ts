import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRun, getDb, insertRun, resetDb, upsertWatermark } from './db';

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
