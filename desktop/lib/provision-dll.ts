// DDL executed by desktop/provision-db.cjs to create the base tables the
// backend opens with synchronize:false (it only ALTERs/adds columns, never
// creates tables).
//
// SYNC OBLIGATION: this must match the FULL post-initDatabase column set for
// every table the backend touches on a fresh boot (entities + the ALTER chain
// in src/server/models/index.ts). A column added upstream there will NOT
// appear here until this is updated — the desktop/provision-db.test.ts
// PRAGMA table_info tripwire exists to catch exactly that drift.
export const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
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
  archived INTEGER NOT NULL DEFAULT 0,
  default_sandbox INTEGER NOT NULL DEFAULT 0,
  node_name TEXT NOT NULL DEFAULT 'local',
  default_summarize_threshold REAL NOT NULL DEFAULT 0
);`,
  `CREATE TABLE IF NOT EXISTS cards (
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
);`,
  `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS project_users (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS api_idempotency (
  request_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
]
