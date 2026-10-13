// One-shot DB base-table provisioner, run by the Electron main process in a
// short-lived child of the BUNDLED node (out/node/node) — not Electron's
// node, so the bundled better-sqlite3 ABI loads correctly. Usage:
//   node provision-db.cjs <dbPath>
// Creates projects/cards (IF NOT EXISTS) before the backend boots: the
// backend opens the DB with synchronize:false and only ALTERs/adds columns,
// so the base tables must already exist on a fresh install. Columns mirror
// the production data/orchestrel.db schema; the unique index on
// cards(session_id) is intentionally absent — the backend creates it after
// its own dedupe check. Exit code 0 on success (idempotent).
'use strict'
const path = require('node:path')
const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: node provision-db.cjs <dbPath>')
  process.exit(2)
}
const Database = require(path.join(__dirname, 'node_modules', 'better-sqlite3'))
const db = new Database(dbPath)
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL,
  path text NOT NULL,
  setup_commands text DEFAULT '',
  is_git_repo integer DEFAULT false NOT NULL,
  default_branch text,
  default_worktree integer DEFAULT false NOT NULL,
  color text,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  default_model text DEFAULT 'sonnet' NOT NULL,
  default_thinking_level text DEFAULT 'high' NOT NULL,
  provider_id text DEFAULT 'anthropic' NOT NULL,
  memory_base_url TEXT,
  memory_api_key TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  default_sandbox INTEGER NOT NULL DEFAULT 0,
  node_name TEXT NOT NULL DEFAULT 'local',
  default_summarize_threshold REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cards (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  title text NOT NULL,
  description text DEFAULT '',
  \`column\` text DEFAULT 'backlog' NOT NULL,
  position real DEFAULT 0 NOT NULL,
  project_id integer REFERENCES projects(id) ON UPDATE no action ON DELETE set null,
  pr_url text,
  session_id text,
  worktree_branch text,
  source_branch text,
  prompts_sent integer DEFAULT 0 NOT NULL,
  turns_completed integer DEFAULT 0 NOT NULL,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  updated_at text DEFAULT (datetime('now')) NOT NULL,
  model text DEFAULT 'sonnet' NOT NULL,
  thinking_level text DEFAULT 'high' NOT NULL,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 200000,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  queue_position INTEGER DEFAULT NULL,
  pending_prompt TEXT DEFAULT NULL,
  pending_files TEXT DEFAULT NULL,
  summarize_threshold REAL NOT NULL DEFAULT 0,
  sandbox INTEGER NOT NULL DEFAULT 0,
  node_name TEXT NOT NULL DEFAULT 'local',
  session_cwd TEXT,
  pending_initial_files TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  sleep_until INTEGER,
  sleep_prompt TEXT,
  priority INTEGER NOT NULL DEFAULT 0
);
`)
db.close()
