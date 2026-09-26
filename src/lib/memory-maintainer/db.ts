/* Maintainer state in the orchestrel SQLite DB. Tables owned by this module
 * (CREATE TABLE IF NOT EXISTS), so the CLI path works without TypeORM init.
 * Path comes from ORCHESTREL_DB_PATH (test hook); default data/orchestrel.db.
 * Never run WAL management pragmas (CLAUDE.md guardrail). */
import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const path = resolve(process.env.ORCHESTREL_DB_PATH ?? join(process.cwd(), 'data', 'orchestrel.db'));
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_maintainer_watermark (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_maintainer_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary_json TEXT
    );
  `);
  return db;
}

/** Test-only: close the singleton so a new path takes effect. */
export function resetDb(): void {
  db?.close();
  db = null;
}

export function upsertWatermark(db: Database.Database, path: string, mtimeMs: number, size: number): void {
  db.prepare(
    `INSERT INTO memory_maintainer_watermark (path, mtime_ms, size, processed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, processed_at = excluded.processed_at`,
  ).run(path, mtimeMs, size, new Date().toISOString());
}

export function insertRun(db: Database.Database, runType: string, startedAt: string): number {
  const info = db
    .prepare(`INSERT INTO memory_maintainer_runs (run_type, started_at, status) VALUES (?, ?, 'running')`)
    .run(runType, startedAt);
  return Number(info.lastInsertRowid);
}

export function finishRun(db: Database.Database, runId: number, status: string, summaryJson: string): void {
  db.prepare(`UPDATE memory_maintainer_runs SET status = ?, finished_at = ?, summary_json = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    summaryJson,
    runId,
  );
}

const RUN_STALENESS_MS = 6 * 60 * 60 * 1000;

/** True when a run of the same type (other than `ownRunId`) started in the
 * last 6h is still 'running' — guards against duplicate scheduler instances
 * (e.g. Vite dev bundles) or CLI + scheduler overlap. */
export function recentActiveRun(db: Database.Database, runType: string, ownRunId: number): boolean {
  const rows = db
    .prepare(
      `SELECT id, started_at FROM memory_maintainer_runs
       WHERE run_type = ? AND status = 'running' ORDER BY id DESC LIMIT 1`,
    )
    .all(runType) as Array<{ id: number; started_at: string }>;
  const latest = rows[0];
  if (!latest || latest.id === ownRunId) return false;
  return Date.now() - Date.parse(latest.started_at) < RUN_STALENESS_MS;
}
