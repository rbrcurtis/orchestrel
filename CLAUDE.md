# Orchestrel

Personal kanban board + Claude Code orchestration app.

## Commands

- `pnpm dev` — start Vite dev server (used by systemd service)
- `pnpm build` — production build (SPA mode, outputs to build/client/)
- `pnpm start` — run built server directly
- `sudo systemctl restart orchestrel` — restart the service (needed for server-side changes; frontend uses HMR)

## Session Backend

Orc uses [meridian](https://github.com/rynfar/meridian) as its session backend. Meridian runs as a separate systemd service (`claude-max-proxy`) on port 3456.

- **Provider routing:** `x-meridian-profile` header selects the provider. Default = Anthropic (Claude Max), `kiro` = Kiro pool proxy (port 3457).
- **Session tracking:** `x-opencode-session` header identifies sessions across requests.
- **Streaming:** Meridian returns SSE (`text/event-stream`) responses. Orc parses SSE events, translates them to the existing socket.io message format, and forwards to the browser.
- **Working directory:** Passed via `<env>` block in the system prompt; meridian's `extractClientCwd()` parses it.
- **Config:** `~/.config/meridian/profiles.json` for provider profiles.
- **Override:** Set `MERIDIAN_URL` env var to point to a different meridian instance.

## Code Style

- TypeScript strict mode
- Never use `any` — use `unknown` and narrow
- No barrel exports (index.ts re-exports)
- Direct, simple code — no unnecessary abstractions
- Early returns, guard clauses, no deep nesting
- Short variable names in local scope (`e`, `el`, `ctx`, `req`, `res`, `err`)
- Use `arg` library for any CLI scripts, parse args at top then `main()`

## Event-Driven Architecture (CRITICAL)

This is a **purely event-driven system**. Every handler reacts to a single event in complete isolation. System behavior emerges from the composition of independent handlers — no handler should encode or assume a workflow sequence.

**Rules:**
- Never write a handler that assumes a prior step occurred (e.g., don't assume "card moved to running" means a worktree exists)
- Each handler reacts only to the event it receives + current observable state
- Don't couple handlers — they must be independently composable
- The system must be resilient to events arriving in any order, being replayed, or steps being skipped
- Add new behavior as new independent listeners, not by extending existing handler chains
- Think "what does this event + current state imply?" — never "what step comes next?"

## Vite Dev Server Restart Survival

`vite.config.ts` is bundled by esbuild — module-level variables in files **statically** imported by it reset on every re-bundle. But **dynamic imports** go through the Node.js module cache and persist across restarts.

**Rule:** State that must survive Vite dev server restarts (singletons, initialization flags, cached server instances) must live in dynamically imported modules, never in files statically imported by `vite.config.ts`.

- `src/server/init-state.ts` — holds WSS instance, initialization flag, and upgrade handler attachment. Always dynamically imported.
- `src/server/ws/server.ts` — statically imported by `vite.config.ts` (exports `wsServerPlugin`). NO persistent state here.
- On each `configureServer` call: REST middleware is re-wired (restApp closure), WSS upgrade handler is re-attached to the new httpServer. WSS creation, OC bus listeners, and OpenCode server start only happen once (guarded by `init-state.initialized`).
- **SessionManager** also lives in a dynamically imported module and must survive restarts — it tracks active session IDs in memory. Meridian owns the actual agent sessions; SessionManager is lightweight (just in-memory session ID tracking).

## Dev Server

- **Local URL:** `http://localhost:6194`
- **Tunnel URL:** `https://dispatch.rbrcurtis.com` (Cloudflare tunnel, requires Access auth)

## DB Backups

- **Cron:** every 15 minutes via `scripts/backup-db.sh`
- **Location:** `/mnt/D/Sync/orchestra-backups/orchestrel-YYYYMMDD-HHMMSS.db`
- **Retention:** 3-day rolling (older backups auto-pruned)

## UI Rules

- **No native scrollbars.** Use Radix ScrollArea (`~/components/ui/scroll-area`) for all scrollable containers. For content that might overflow horizontally (code blocks, long text), wrap with `whitespace-pre-wrap break-all overflow-hidden` — never `overflow-x-auto`.

## DB Schema

```sql
CREATE TABLE projects (
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
  provider_id text DEFAULT 'anthropic' NOT NULL
);

CREATE TABLE cards (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  title text NOT NULL,
  description text DEFAULT '',
  column text DEFAULT 'backlog' NOT NULL,
  position real DEFAULT 0 NOT NULL,
  project_id integer REFERENCES projects(id) ON DELETE SET NULL,
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
  queue_position INTEGER DEFAULT NULL,
  pending_prompt TEXT DEFAULT NULL,
  pending_files TEXT DEFAULT NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic'
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);

CREATE TABLE project_users (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
```

## Guardrails

- **DB file:** `data/orchestrel.db` — Schema additions (`ALTER TABLE ADD COLUMN`) via sqlite3 CLI are safe anytime. NEVER truncate DB files or run WAL management commands (`wal_checkpoint`, `PRAGMA journal_mode`, etc.) — SQLite handles this automatically. A `wal_checkpoint(TRUNCATE)` previously destroyed ~68 cards.
- **Vite HMR:** works through tunnel — do NOT hardcode `hmr.host` in vite.config.ts (let Vite auto-detect)
