# Orchestrel

A personal kanban board that orchestrates AI coding agents. Drag a card to "Running" and an AI session starts automatically — complete with git worktree isolation, real-time streaming output, and context window tracking.

Built for managing multiple concurrent AI-assisted development tasks from a single interface.

## Features

**Kanban Board**
- Five-column workflow: Backlog → Ready → Running → Review → Done (+ Archive)
- Drag-and-drop card management with sortable columns
- Full-text search across all cards
- Paginated card loading per column

**AI Agent Orchestration**
- Cards in "Running" automatically spawn an AI coding session via [OpenCode](https://github.com/nicholasgriffintn/opencode)
- Real-time streaming of agent output (text, thinking, tool calls, tool results)
- Send follow-up prompts to active sessions
- Model selection per card: Sonnet, Opus, or Auto
- Configurable thinking levels: off / low / medium / high
- Context window gauge — SVG donut showing token utilization
- Per-turn cost tracking
- File attachments on prompts
- Session resume support

**Git Worktree Integration**
- Each card gets an isolated git worktree (configurable per project)
- AI agent runs inside the worktree directory
- Worktree cleanup on card archive
- Configurable source branch (main / dev)

**Project Management**
- Register local git repositories as projects
- Per-project defaults: model, thinking level, source branch, worktree toggle
- Per-project setup commands (e.g., `pnpm install` after worktree creation)
- Auto-assigned neon accent color per project
- AI-generated card titles via local Ollama (optional)

**UI / UX**
- "Neon Decay" dark cyberpunk theme with 8 neon accent colors
- Resizable slide-out detail panel (desktop), full-screen sheet (mobile)
- Keyboard shortcuts (`/` for search, `Esc` to close)
- Auto-scroll to latest output when switching cards
- PWA support with service worker

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7 (SPA mode), MobX |
| Styling | Tailwind CSS 4, shadcn/ui (Radix primitives) |
| Server | Express 5, WebSocket (ws), Hono (REST API) |
| Database | SQLite (better-sqlite3) via TypeORM |
| AI | OpenCode SDK (`@opencode-ai/sdk`) |
| Drag & Drop | dnd-kit |
| Auth | Cloudflare Access JWT verification (optional) |
| Build | Vite 7, TypeScript 5.9 |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                        │
│  MobX stores ←→ WsClient (WebSocket) ←→ React components   │
└────────────────────────┬────────────────────────────────────┘
                         │ WebSocket
┌────────────────────────┴────────────────────────────────────┐
│                     Express Server                          │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ WS Server│  │ REST API     │  │ Session Manager       │ │
│  │ (handlers│  │ (Hono)       │  │                       │ │
│  │  subs)   │  │              │  │ OpenCode SDK sessions │ │
│  └────┬─────┘  └──────┬───────┘  │ ↕ SSE event stream   │ │
│       │               │          └───────────┬───────────┘ │
│       └───────┬───────┘                      │             │
│               │                              │             │
│  ┌────────────┴────────┐    ┌────────────────┴───────────┐ │
│  │  SQLite (TypeORM)   │    │  OpenCode subprocess       │ │
│  │  cards, projects    │    │  (AI agent runtime)        │ │
│  └─────────────────────┘    └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Key patterns:**
- **Server-owned session lifecycle** — the client never starts sessions directly. Moving a card to "Running" or sending a prompt triggers server-side session creation.
- **WebSocket-first communication** — all mutations and subscriptions flow through a typed WebSocket protocol (Zod-validated).
- **Message bus** — TypeORM entity subscribers emit events to an internal bus, which fans out to WebSocket subscriptions.
- **SSE multiplexing** — OpenCode emits server-sent events; Orchestrel filters by session ID to route messages to the correct card.

## Prerequisites

- **Node.js** 20+
- **pnpm**
- **OpenCode** — install and configure with your Anthropic API key
- **Ollama** (optional) — for AI-generated card titles. Runs on `localhost:11434`.

## Setup

```bash
git clone https://github.com/your-username/orchestrel.git
cd orchestrel
pnpm install

# Copy and configure environment
cp .env.example .env
# Edit .env — see comments for required/optional vars

# Start dev server
pnpm dev
```

The app runs on `http://localhost:6194` by default.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6194` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | — | Set to `development` for HMR |
| `OPENCODE_PORT` | `4097` | Port for the OpenCode subprocess |

### Production

```bash
pnpm build
pnpm start
```

### Cloudflare Access (optional)

If exposing via Cloudflare Tunnel, Orchestrel validates `CF_Authorization` JWTs. Set the `CF_TEAM_DOMAIN` environment variable to your Cloudflare Access team domain. In development mode, auth is bypassed.

## Project Structure

```
server.js                 # Express entry point (dev HMR + prod static)
src/
  server/
    agents/               # Session manager, factory, OpenCode integration
      opencode/           # SSE parsing, model resolution, message normalization
    models/               # TypeORM entities (Card, Project)
    services/             # Business logic (card CRUD, session orchestration, worktrees)
    ws/                   # WebSocket server, auth, handlers, subscriptions
    api/                  # REST endpoints (Hono)
    worktree.ts           # Git worktree operations
  shared/
    ws-protocol.ts        # Zod schemas for WebSocket message types
app/
  routes/                 # React Router file-based routes
    board.tsx             # Layout with nav, search, card detail panel
    board.index.tsx       # Active board (Ready/Running/Review columns, DnD)
    board.backlog.tsx     # Backlog view
    board.done.tsx        # Done view
    board.archive.tsx     # Archive view
    settings.projects.tsx # Project configuration
  components/             # SessionView, CardDetail, MessageBlock, ContextGauge, etc.
  stores/                 # MobX stores (Card, Project, Session, Root)
  lib/                    # WebSocket client, utilities
```

## Card Lifecycle

```
Backlog → Ready → Running → Review → Done → Archive
                     │          ▲
                     │          │
                     └──────────┘
                   session exits
```

1. Create a card in **Backlog** or **Ready** with a description (the prompt)
2. Drag to **Running** — a git worktree is created and an AI session starts
3. Watch the agent work in real-time via the detail panel
4. When the session completes, the card moves to **Review**
5. Send follow-up prompts to continue the conversation
6. Move to **Done** when satisfied, **Archive** to clean up (removes worktree)

## License

MIT
