# Orchestrel

Personal kanban board + Claude Code orchestration app.

## Commands

- `pnpm dev` — start Vite dev server (used by systemd service)
- `pnpm build` — production build (SPA mode, outputs to build/client/)
- `pnpm start` — run built server directly
- `sudo systemctl restart orchestrel` — restart the service (needed for server-side changes; frontend uses HMR)

## Architecture Layers

| # | Layer | Description | Location |
|---|-------|-------------|----------|
| 1 | **Orc UI** | React frontend, runs in browser | `app/` |
| 2 | **Orc Backend** | Vite dev server, socket.io, REST, controllers, bus | `src/server/` |
| 3 | **orcd** | Standalone daemon, manages sessions via Agent SDK | `src/orcd/` |
| 4 | **Agent Processes** | Claude Code subprocesses spawned by SDK `query()` | managed by SDK |
| 5 | **KPP / proxies** | Provider routing proxies (kiro-pool-proxy, future) | separate services |

### Session Lifecycle Ownership

**orcd (layer 3) owns session lifecycle.** The orc backend (layer 2) must not infer session state from SDK events like `result`. A `result` event means one agent turn completed, NOT that the session is done — background tasks (monitors, subagents) may still be running in the agent process.

- orcd emits `session_exit` when the SDK iterator actually closes (all work done)
- Orc backend reacts to `session_exit` to move cards to review
- `result` is just another SDK event — used for turn counting and forwarding to the UI

### Provider Routing

Provider config lives in `~/.orc/config.yaml`. Each provider has `baseUrl`, `apiKey`, and `models`. orcd sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` env vars on the agent subprocess. KPP reads the API key to determine which account pool to route to. All providers work identically — no special cases.

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
- **OrcdClient** also lives in a dynamically imported module and must survive restarts — it tracks active session IDs in memory. orcd owns the actual agent sessions; OrcdClient is lightweight (just connection + active session tracking).

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
