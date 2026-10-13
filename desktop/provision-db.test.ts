// Drift tripwire between the desktop DB provisioner and the backend schema.
// Runs the exact DDL provision-db.cjs executes (DDL_STATEMENTS, the single
// source of truth it requires at runtime) against a TEMP database, then
// asserts via PRAGMA table_info that every table the backend touches on a
// fresh boot has the expected columns. The expected lists are small explicit
// arrays — when src/server/models gains a column (new @Column or new ALTER in
// initDatabase in src/server/models/index.ts) this test fails until
// lib/provision-dll.ts is updated. That failure is the point: it names the
// column, before the next desktop fresh-install silently boots a backend on a
// schema missing it.
//
// Note: the backend creates its own unique index on cards(session_id) after a
// dedupe check, so the provisioner intentionally omits it; the table_info
// check below covers columns only.
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { test, expect } from 'vitest'
import { DDL_STATEMENTS } from './lib/provision-dll'

// Keep in sync with src/server/models (entities + initDatabase ALTER chain);
// a column added upstream will fail this test until provision-db is updated.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  projects: [
    'id',
    'name',
    'path',
    'setup_commands',
    'is_git_repo',
    'default_branch',
    'default_worktree',
    'color',
    'created_at',
    'default_model',
    'default_thinking_level',
    'provider_id',
    'archived',
    'default_sandbox',
    'node_name',
    'default_summarize_threshold',
  ],
  cards: [
    'id',
    'title',
    'description',
    'column',
    'position',
    'project_id',
    'pr_url',
    'session_id',
    'worktree_branch',
    'source_branch',
    'prompts_sent',
    'turns_completed',
    'created_at',
    'updated_at',
    'model',
    'thinking_level',
    'context_tokens',
    'context_window',
    'provider',
    'queue_position',
    'pending_prompt',
    'pending_files',
    'summarize_threshold',
    'sandbox',
    'node_name',
    'session_cwd',
    'pending_initial_files',
    'version',
    'sleep_until',
    'sleep_prompt',
    'priority',
  ],
  users: ['id', 'email', 'role', 'created_at'],
  project_users: ['project_id', 'user_id'],
  api_idempotency: ['request_key', 'operation', 'request_hash', 'response_json', 'created_at'],
}

test('provision DDL creates every base table with the full backend column set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provision-db-test-'))
  const db = new Database(join(dir, 'orchestrel.db'))
  try {
    for (const stmt of DDL_STATEMENTS) db.exec(stmt)
    for (const [table, wanted] of Object.entries(EXPECTED_COLUMNS)) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      const got = rows.map((r) => r.name)
      const missing = wanted.filter((c) => !got.includes(c))
      expect(missing, `table ${table} missing columns`).toEqual([])
      const extra = got.filter((c) => !wanted.includes(c))
      expect(extra, `table ${table} has unexpected columns`).toEqual([])
    }
  } finally {
    db.close()
    void rm(dir, { recursive: true, force: true })
  }
})
