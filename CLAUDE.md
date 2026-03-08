# Dispatcher

Personal kanban board + Claude Code orchestration app.

## Tech Stack

- **Frontend:** React Router 7 (full-stack/SSR mode)
- **API:** tRPC (type-safe RPC, subscriptions for streaming Claude output)
- **Database:** SQLite via Drizzle ORM (better-sqlite3)
- **Styling:** Tailwind CSS — see [theme.md](theme.md) for the "Neon Decay" color system (tokens, accents, glows)
- **UI components:** shadcn/ui (new-york style, OKLCH vars, Radix primitives)
- **Hosting:** LAN server at 192.168.4.200:6194, exposed via Cloudflare tunnel at dispatch.rbrcurtis.com with email OTP auth

## Code Style

- TypeScript strict mode
- Never use `any` — use `unknown` and narrow
- No barrel exports (index.ts re-exports)
- Direct, simple code — no unnecessary abstractions
- Early returns, guard clauses, no deep nesting
- Short variable names in local scope (`e`, `el`, `ctx`, `req`, `res`, `err`)
- Use `arg` library for any CLI scripts, parse args at top then `main()`

## Project Structure

```
src/
  server/           # tRPC routers, Claude SDK manager, DB
    routers/        # tRPC router definitions (cards, claude, projects, sessions)
    claude/         # Claude Agent SDK integration
      protocol.ts   # ClaudeSession class — SDK query() async generator, MCP env setup
      manager.ts    # SessionManager (extends EventEmitter), session lifecycle
    db/             # Drizzle schema, migrations, queries
      schema.ts     # cards, projects tables
    trpc.ts         # tRPC init, context
app/
  routes/           # React Router 7 file-based routes
    board.tsx       # Layout route with Outlet, panel state, card selection
    board.index.tsx # Main board (ready/in_progress/review columns, DnD)
    board.backlog.tsx
    board.done.tsx
    board.archive.tsx
  components/       # Shared UI components
    SessionView.tsx # Live session streaming, subscribe in onMutate, merge history+live
    CardDetail.tsx  # Slide-out panel, column-aware content
    ContextGauge.tsx # SVG donut for context window fill %
  hooks/            # React hooks
  lib/              # Client-side utilities (trpc.ts, utils.ts)
```

## Key Architecture Decisions

- Claude Code integration uses `@anthropic-ai/claude-agent-sdk` `query()` async generator (migrated from subprocess spawn)
- Auto-approve all tool use (`bypassPermissions`), no approval UI
- Session logs stay in Claude's native log files, referenced by session ID — not duplicated to DB
- Every project-linked card gets a git worktree; Claude spawns into the worktree path
- tRPC SSE subscriptions stream Claude output to the client via `httpSubscriptionLink` + `tracked()`
- Card detail: slide-out panel on desktop (resizable), full-screen Sheet on mobile
- Card lifecycle: backlog → ready → in_progress (worktree created, Claude starts) → review (auto on session exit) → done
- Shared-memory MCP wired into SDK sessions — reads project's `.mcp.json` for Qdrant config, falls back to `~/.claude.json`
- Context window tracking: per-turn `message.usage` (not cumulative), dynamic contextWindow from `result.modelUsage`

## Deployment

- **Systemd service:** `dispatcher.service` runs `pnpm dev` on port 6194, bound to 192.168.4.200
- **Cloudflare tunnel:** `accordyx` tunnel routes dispatch.rbrcurtis.com → localhost:6194 (config: `/etc/cloudflared/config.yml`)
- **Cloudflare Access:** email OTP auth (wednesday@gmail.com), 720h session duration
- **DB file:** `data/dispatcher.db`
- **Vite HMR:** works through tunnel — do NOT hardcode `hmr.host` in vite.config.ts (let Vite auto-detect)
- Server-side changes (src/server/) require service restart; client changes (app/) get HMR

## Commands

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm db:push      # Push schema changes to SQLite
pnpm db:studio    # Open Drizzle Studio
sudo systemctl restart dispatcher  # Restart service after server-side changes
```

## Key Memories (shared-memory IDs for context loading)

- `17525e1b` — SDK migration details (commits, architecture, design decisions)
- `4f6df804` — Shared-memory MCP wiring (per-project Qdrant config resolution)
- `7053a845` — Cloudflare tunnel and Access setup details
- `4150d64e` — SDK session resume bug fixes (5 bugs found and fixed)
- `dc23540e` — Architecture and card lifecycle patterns
- `19947bd0` — Session streaming architecture (SSE, multi-turn, message buffer)
- `fd4a80c6` — Vite HMR through Cloudflare tunnel fix
- `7f7b2096` — Context window tracking formula
- `6fa21c59` — Session UI component structure (ContextGauge, SessionView, MessageBlock, ToolUseBlock)
- `c8c373c5` — Resume flow bugs and fixes
