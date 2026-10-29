# Orchestrel

Personal kanban board + agent session orchestration.

## Running it

- Production is `orchestrel.service` (port 6194): esbuild bundle `dist/server.mjs` under plain `node`, `NODE_ENV=production`, serving the client from `build/client`. There is **no HMR** — `sudo systemctl restart orchestrel` is the deploy step for *any* change, frontend included (its `ExecStartPost` rebuilds the client and API routes).
- `orchestrel-dev.service` (Vite middleware + HMR, port 6197) is **disabled**; never assume it is running.
- Never restart a service (or the orcd daemon) without Ryan's approval.
- `orcd` runs as `orcd.service` (systemd, journald-logged). Restarting it SIGTERMs **every** in-flight card session on the node — sessions die mid-turn with unresolved tool calls (looks like a "subagent failed"). Prefer not to schedule deferred restarts (`systemd-run --on-active=... restart orcd.service`) while cards are actively running.
- Scripts: `bun run dev` | `build` | `start`. Scratch TypeScript goes in `src/bin/scratch-*` and is deleted when done.

## Layers

| # | Layer | What it is | Location |
|---|-------|------------|----------|
| 1 | Orc UI | React frontend (browser) | `app/` |
| 2 | Orc backend | express + socket.io, REST, controllers, bus | `src/server/` |
| 3 | orcd | daemon that owns agent sessions | `src/orcd/` |
| 4 | Agent processes | spawned by the Agent SDK | SDK-managed |
| 5 | Proxies / Pi extensions | provider routing, auth reshaping | outside this repo |

orcd nodes are registered in `orc.yaml` and configured by `orcd.yaml` (both gitignored; see the `.example` files). A project's `node_name` decides which node runs its cards.

## Hard rules

- **orcd owns session lifecycle.** A `result` event means one turn finished, not that the session is done; `session_exit` is the real end. The backend must not infer session state from `result`.
- **Purely event-driven.** Every handler reacts to one event plus current observable state. Never assume a prior step happened, never chain handlers — add new behavior as a new independent listener.
- **Server state lives on `globalThis`** via `src/server/init-state.ts`. esbuild inlines imports when rebundling, so module-level singletons reset; never hold a singleton in a module variable.
- **Providers are generic in orcd** (config only, no provider-specific branches). Provider-specific behavior such as Claude Max OAuth belongs in Pi extensions, never in orcd.
- **Slash commands:** app commands (`/done`, `/archive`, `/sleep`) are parsed by `parseAppCommands` in `src/shared/slash-commands.ts`; skill/prompt commands are expanded by orcd. Details: `docs/slash-commands.md`.
- **Code style:** TypeScript strict, never `any` (narrow `unknown`), no barrel exports, direct code with early returns, `arg` for CLI scripts.
- **UI:** no native scrollbars (use Radix `ScrollArea`); wrap overflowing content with `whitespace-pre-wrap break-all overflow-hidden`, never `overflow-x-auto`.

## Data

- DB: `data/orchestrel.db`. Schema changes: `ALTER TABLE ADD COLUMN` is safe anytime. **Never truncate the DB** and never run WAL pragmas (`wal_checkpoint`, `PRAGMA journal_mode`) — a `wal_checkpoint(TRUNCATE)` once destroyed ~68 cards.
- Read the schema from the live DB (`.schema`), not from stale copies in docs.
