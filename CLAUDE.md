# Dispatcher

Personal kanban board + Claude Code orchestration app.

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

## Guardrails

- **DB file:** `data/dispatcher.db` — Schema additions (`ALTER TABLE ADD COLUMN`) via sqlite3 CLI are safe anytime. NEVER modify data (INSERT/UPDATE/DELETE) outside the app — use WS mutations. NEVER run WAL management commands (`wal_checkpoint`, `PRAGMA journal_mode`, etc.) — SQLite handles this automatically. A `wal_checkpoint(TRUNCATE)` previously destroyed ~68 cards.
- **Vite HMR:** works through tunnel — do NOT hardcode `hmr.host` in vite.config.ts (let Vite auto-detect)
