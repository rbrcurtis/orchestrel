# MobX + WebSocket Architecture Migration

## Problem

The current architecture uses React Query (TanStack Query) with tRPC for all data flow. This is fundamentally pull-based: clients fetch data and rely on manual `invalidateQueries()` calls after mutations. Server-side changes (Claude session exits, counter updates, worktree creation) don't push to the UI. An upcoming external API will allow other home mesh services to create/update cards, making server-push essential.

## Architecture

Replace React Query + tRPC with:

- **MobX** — client-side observable stores, single source of truth
- **WebSocket** — bidirectional, typed channel for all internal app communication
- **REST + OpenAPI** — external API for mesh service consumers
- **Zod schemas** (derived from Drizzle) — single type source of truth for WS protocol, REST validation, and MobX store types

### Communication Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| WebSocket | Bidirectional | Internal app: reads, writes, subscriptions, search, pagination |
| REST | External → Server | External API consumers (home mesh services) |
| WS broadcast | Server → Client | Any DB mutation (from WS or REST) pushes updates to subscribed clients |

### Data Flow

```
                  ┌─────────────┐
                  │  Drizzle DB │
                  └──────┬──────┘
                         │
                  ┌──────┴──────┐
                  │  DB Mutator │ ← wraps all writes, emits WS events
                  └──┬───────┬──┘
                     │       │
              ┌──────┴──┐ ┌──┴────────┐
              │ WS Handlers │ REST Routes │
              └──────┬──┘ └──┬────────┘
                     │       │
              ┌──────┴──┐    │
              │ WebSocket│    │
              └──────┬──┘    │
                     │       │
              ┌──────┴──────────────┐
              │  MobX Store (client)│
              └──────┬──────────────┘
                     │
              ┌──────┴──────┐
              │  React UI   │
              └─────────────┘
```

## Authentication

The app is behind Cloudflare Access (email OTP). Cloudflare sets a `CF_Authorization` cookie on authenticated sessions.

**WebSocket auth:** On the HTTP upgrade request, the server validates the `CF_Authorization` JWT cookie before accepting the upgrade. The `ws` library's `handleUpgrade` receives the raw `http.IncomingMessage`, which includes cookies. Validate using Cloudflare's public keys (fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). Reject the upgrade with 401 if invalid or missing.

**REST auth:** Same Cloudflare Access JWT validation on each request via middleware.

**Dev mode:** Skip JWT validation when `NODE_ENV === 'development'` (LAN access).

## Shared Protocol (Zod)

Source of truth: Drizzle schema → `drizzle-zod` `createSelectSchema()` → WS protocol → MobX types.

Entity schemas use `createSelectSchema()` for read types (full row). Mutation inputs use `createInsertSchema()` with `.pick()` / `.omit()` to exclude server-managed fields (`id`, `createdAt`, `updatedAt`, `sessionId`, `worktreePath`, `worktreeBranch`, `promptsSent`, `turnsCompleted`).

```typescript
// src/shared/ws-protocol.ts

// Entity schemas (derived from Drizzle — read types)
const cardSchema = createSelectSchema(cards)
const projectSchema = createSelectSchema(projects)

type Card = z.infer<typeof cardSchema>
type Project = z.infer<typeof projectSchema>

// Mutation input schemas (derived from Drizzle — write types)
const cardCreateSchema = createInsertSchema(cards).pick({
  title: true, description: true, column: true, projectId: true,
  model: true, thinkingLevel: true, useWorktree: true, sourceBranch: true,
})
const cardUpdateSchema = z.object({
  id: z.number(),
}).merge(cardCreateSchema.partial())
const cardMoveSchema = z.object({
  id: z.number(),
  column: columnEnum,
  position: z.number(),
})

const projectCreateSchema = createInsertSchema(projects).pick({
  name: true, path: true, setupCommands: true, defaultBranch: true,
  defaultWorktree: true, defaultModel: true, defaultThinkingLevel: true, color: true,
})
const projectUpdateSchema = z.object({
  id: z.number(),
}).merge(projectCreateSchema.partial())

// Column enum (shared)
const columnEnum = z.enum(['backlog','ready','in_progress','review','done','archive'])

// File ref (for Claude message attachments — uploaded via POST /api/upload, which is retained)
const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number(),
})

// Claude schemas
const claudeStartSchema = z.object({
  cardId: z.number(),
  prompt: z.string().min(1),
})
const claudeSendSchema = z.object({
  cardId: z.number(),
  message: z.string().min(1),
  files: z.array(fileRefSchema).optional(),
})
const claudeStatusSchema = z.object({
  cardId: z.number(),
  active: z.boolean(),
  status: z.enum(['running', 'completed', 'errored', 'stopped']),
  sessionId: z.string().nullable(),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
})
const claudeMessageSchema = z.object({
  type: z.enum(['user', 'assistant', 'result', 'system']),
  message: z.record(z.unknown()),
  isSidechain: z.boolean().optional(),
  ts: z.string().optional(),
})

// Client → Server
const clientMessage = z.discriminatedUnion('type', [
  // Subscription control
  z.object({ type: z.literal('subscribe'), columns: z.array(columnEnum) }),
  z.object({ type: z.literal('page'), column: columnEnum, cursor: z.number().optional(), limit: z.number() }),
  z.object({ type: z.literal('search'), query: z.string(), requestId: z.string() }),

  // Mutations (card)
  z.object({ type: z.literal('card:create'), requestId: z.string(), data: cardCreateSchema }),
  z.object({ type: z.literal('card:update'), requestId: z.string(), data: cardUpdateSchema }),
  z.object({ type: z.literal('card:move'), requestId: z.string(), data: cardMoveSchema }),
  z.object({ type: z.literal('card:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('card:generateTitle'), requestId: z.string(), data: z.object({ id: z.number() }) }),

  // Mutations (project)
  z.object({ type: z.literal('project:create'), requestId: z.string(), data: projectCreateSchema }),
  z.object({ type: z.literal('project:update'), requestId: z.string(), data: projectUpdateSchema }),
  z.object({ type: z.literal('project:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),

  // Claude session control
  z.object({ type: z.literal('claude:start'), requestId: z.string(), data: claudeStartSchema }),
  z.object({ type: z.literal('claude:send'), requestId: z.string(), data: claudeSendSchema }),
  z.object({ type: z.literal('claude:stop'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),
  z.object({ type: z.literal('claude:status'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),
])

// Server → Client
const serverMessage = z.discriminatedUnion('type', [
  // Mutation responses
  z.object({ type: z.literal('mutation:ok'), requestId: z.string(), data: z.unknown().optional() }),
  z.object({ type: z.literal('mutation:error'), requestId: z.string(), error: z.string() }),

  // Entity push
  z.object({ type: z.literal('sync'), cards: z.array(cardSchema), projects: z.array(projectSchema) }),
  z.object({ type: z.literal('card:updated'), data: cardSchema }),
  z.object({ type: z.literal('card:deleted'), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('project:updated'), data: projectSchema }),
  z.object({ type: z.literal('project:deleted'), data: z.object({ id: z.number() }) }),

  // Pagination
  z.object({ type: z.literal('page:result'), column: columnEnum, cards: z.array(cardSchema), nextCursor: z.number().optional(), total: z.number() }),

  // Search
  z.object({ type: z.literal('search:result'), requestId: z.string(), cards: z.array(cardSchema), total: z.number() }),

  // Claude session streaming
  z.object({ type: z.literal('claude:message'), cardId: z.number(), data: claudeMessageSchema }),
  z.object({ type: z.literal('claude:status'), data: claudeStatusSchema }),
])

type ClientMessage = z.infer<typeof clientMessage>
type ServerMessage = z.infer<typeof serverMessage>
```

## Server: WebSocket Handler

Single `ws` server mounted alongside the existing Vite dev server. The DB uses `better-sqlite3`, which is synchronous — all DbMutator methods are synchronous (not `async`). This is fine for the data volumes; long-running operations (Claude SDK, Ollama) are inherently async and don't block the event loop.

### Connection Lifecycle

1. Client sends HTTP upgrade → server validates CF_Authorization JWT → accepts/rejects
2. On connect: server stores connection with empty subscription set
3. Client sends `subscribe` with desired columns → server records and sends `sync`
4. `sync` contains all cards in subscribed columns + all projects
5. Ongoing: any DB mutation → server pushes entity updates (see Broadcast Filtering)
6. Client disconnects → cleanup connection and subscription state

### DB Mutator Pattern

All DB writes go through a central mutator that emits WS broadcasts. Methods are synchronous (matching `better-sqlite3`):

```typescript
// src/server/db/mutator.ts
class DbMutator {
  constructor(private db: Database, private broadcast: BroadcastFn) {}

  updateCard(id: number, data: Partial<Card>): Card {
    const [updated] = db.update(cards).set(data).where(eq(cards.id, id)).returning()
    this.broadcast({ type: 'card:updated', data: updated }, updated.column)
    return updated
  }

  moveCard(id: number, column: string, position: number): Card {
    const [prev] = db.select().from(cards).where(eq(cards.id, id))
    const [updated] = db.update(cards)
      .set({ column, position, updatedAt: new Date().toISOString() })
      .where(eq(cards.id, id))
      .returning()
    // Broadcast to both old and new column subscribers
    this.broadcast({ type: 'card:updated', data: updated }, prev.column, updated.column)
    return updated
  }
  // ... same pattern for all mutations
}
```

REST endpoints and WS handlers both use the same mutator → both trigger WS broadcasts.

### Broadcast Filtering

Server tracks per-connection subscribed columns. Entity updates are always broadcast with the full entity — the client decides whether to store or discard based on its own subscription state.

```typescript
broadcast(msg: ServerMessage, ...affectedColumns: string[]) {
  for (const conn of connections) {
    // No column filter = broadcast to all (projects, mutation responses)
    // With column filter = broadcast to connections subscribed to any affected column
    if (affectedColumns.length === 0 ||
        affectedColumns.some(col => conn.subscribedColumns.has(col))) {
      conn.ws.send(JSON.stringify(msg))
    }
  }
}
```

Projects have no column — `project:updated` / `project:deleted` always broadcast to all connections (no column filter).

When a card moves between columns, broadcast to connections subscribed to **either** the source or destination column. The client receives the full card with its new column and handles it correctly (adds to new column view, removes from old).

## Client: MobX Stores

### Store Structure

```typescript
// app/stores/card-store.ts
class CardStore {
  cards = observable.map<number, Card>()

  // Computed views
  get cardsByColumn(): Record<string, Card[]> { /* grouped + sorted by position */ }
  cardsByColumnName(col: string): Card[] { /* single column sorted */ }

  // Hydrate from sync or IDB cache
  hydrate(cards: Card[]) { cards.forEach(c => this.cards.set(c.id, c)) }

  // Handle server push
  handleUpdated(card: Card) { this.cards.set(card.id, card) }
  handleDeleted(id: number) { this.cards.delete(id) }

  // Serialization for IDB persistence
  serialize(): Card[] { return [...this.cards.values()] }
}

// app/stores/project-store.ts
class ProjectStore {
  projects = observable.map<number, Project>()

  hydrate(projects: Project[]) { projects.forEach(p => this.projects.set(p.id, p)) }
  handleUpdated(project: Project) { this.projects.set(project.id, project) }
  handleDeleted(id: number) { this.projects.delete(id) }
  serialize(): Project[] { return [...this.projects.values()] }
}

// app/stores/root-store.ts
class RootStore {
  cards = new CardStore()
  projects = new ProjectStore()
  ws: WsClient

  constructor() {
    this.ws = new WsClient(this.handleMessage)
  }

  handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case 'sync':
        this.cards.hydrate(msg.cards)
        this.projects.hydrate(msg.projects)
        break
      case 'card:updated': this.cards.handleUpdated(msg.data); break
      case 'card:deleted': this.cards.handleDeleted(msg.data.id); break
      case 'project:updated': this.projects.handleUpdated(msg.data); break
      case 'project:deleted': this.projects.handleDeleted(msg.data.id); break
      // page:result, search:result, claude:message, claude:status
      // handled by dedicated sub-stores or forwarded to components
    }
  }
}
```

### WS Client Wrapper

```typescript
// app/lib/ws-client.ts
class WsClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, { resolve, reject, timeout: ReturnType<typeof setTimeout> }>()
  private onEntityMessage: (msg: ServerMessage) => void
  private subscribedColumns: string[] = []
  private reconnectAttempt = 0
  private maxReconnectDelay = 30_000

  constructor(onEntityMessage: (msg: ServerMessage) => void) {
    this.onEntityMessage = onEntityMessage
    this.connect()
  }

  // --- Connection Management ---

  private connect() {
    this.ws = new WebSocket(wsUrl())
    this.ws.onopen = () => {
      this.reconnectAttempt = 0
      // Re-subscribe on reconnect — server sends fresh sync
      if (this.subscribedColumns.length > 0) {
        this.send({ type: 'subscribe', columns: this.subscribedColumns })
      }
    }
    this.ws.onmessage = (evt) => this.onMessage(evt.data)
    this.ws.onclose = () => this.scheduleReconnect()
    this.ws.onerror = () => this.ws?.close()
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay)
    this.reconnectAttempt++
    // Reject all pending mutations — callers will rollback optimistic state
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout)
      p.reject(new Error('WebSocket disconnected'))
    }
    this.pending.clear()
    setTimeout(() => this.connect(), delay)
  }

  // --- Typed Send ---

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  subscribe(columns: string[]) {
    this.subscribedColumns = columns
    this.send({ type: 'subscribe', columns })
  }

  // --- Mutation with request/response correlation ---

  async mutate(msg: ClientMessage & { requestId: string }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.requestId)
        reject(new Error('Mutation timeout'))
      }, 15_000)
      this.pending.set(msg.requestId, { resolve, reject, timeout })
      this.send(msg)
    })
  }

  // --- Message Router ---

  private onMessage(raw: string) {
    const msg = serverMessage.parse(JSON.parse(raw))
    if (msg.type === 'mutation:ok' || msg.type === 'mutation:error') {
      const p = this.pending.get(msg.requestId)
      if (p) {
        clearTimeout(p.timeout)
        this.pending.delete(msg.requestId)
        msg.type === 'mutation:ok' ? p.resolve(msg.data) : p.reject(new Error(msg.error))
      }
    } else {
      this.onEntityMessage(msg)
    }
  }
}
```

Key reconnection behavior:
- Exponential backoff (1s, 2s, 4s, ... up to 30s)
- All pending mutations rejected on disconnect → optimistic updates roll back
- Re-sends `subscribe` on reconnect → server sends fresh `sync` → store reconciles
- `subscribedColumns` persisted in the client so reconnect re-subscribes automatically

### Optimistic Updates

```typescript
// In CardStore
moveCard(id: number, column: string, position: number) {
  const prev = toJS(this.cards.get(id))
  this.cards.set(id, { ...prev!, column, position })

  this.ws.mutate({
    type: 'card:move',
    requestId: nanoid(),
    data: { id, column, position },
  }).catch(() => {
    if (prev) this.cards.set(id, prev)  // rollback
  })
  // WS broadcast arrives separately and confirms/corrects
}
```

### IndexedDB Persistence

```typescript
// app/lib/store-persist.ts
import { autorun, toJS } from 'mobx'
import { get, set } from 'idb-keyval'

function persistStore<T extends { serialize(): unknown[]; hydrate(data: unknown[]): void }>(
  store: T,
  key: string,
) {
  // Load from IDB on init
  get(key).then(cached => {
    if (cached) store.hydrate(cached as unknown[])
  })

  // Save to IDB on change (debounced 1s)
  autorun(() => {
    const data = store.serialize()
    set(key, toJS(data))
  }, { delay: 1000 })
}

// Usage
persistStore(rootStore.cards, 'orchestrel:cards')
persistStore(rootStore.projects, 'orchestrel:projects')
```

Startup order:
1. Create MobX stores
2. Hydrate from IndexedDB (instant render with cached data)
3. Connect WebSocket → send `subscribe` with current view's columns → receive `sync` → store reconciles
4. MobX detects changes from sync vs. cache → components re-render only where data actually changed

## Scoped Subscriptions

The main board subscribes to `['backlog', 'ready', 'in_progress', 'review', 'done']` — archive is excluded. The subscribed column set is driven by the current route:

- `/board` → `['backlog', 'ready', 'in_progress', 'review', 'done']`
- `/board/archive` → adds `archive` (paginated via `page` messages)
- Future views may use different column sets

When the route changes, the client sends a new `subscribe` message. The server updates the connection's subscription set and sends a fresh `sync` for any newly-added columns. Columns removed from the subscription don't trigger immediate cleanup on the client — the store keeps stale data in memory (harmless), and IDB persistence includes whatever the store has.

## Pagination

Cursor-based by `position` (numeric cursor). The `page` client message uses `cursor: z.number().optional()` matching the `position` column type.

- Main board columns: full data in `sync` (unlikely to exceed 1000)
- Archive: paginated via `page` request → `page:result` response, infinite scroll
- Search results: paginated via `search:result` with `total` count
- Client store holds pagination state per column (`nextCursor`, `hasMore`, `loading`)
- If any main board column exceeds 1000 cards, the server truncates to 1000 in the sync and includes a `nextCursor` in a `page:result` follow-up (future-proofing, not built in v1)

## File Uploads

The existing `POST /api/upload` endpoint (React Router API route) is **retained**. File uploads are inherently HTTP (multipart form data over WebSocket is impractical). The flow:

1. User attaches files in SessionView → `POST /api/upload` → returns file refs
2. File refs passed to `claude:send` WS message via the `files` field
3. Server validates file paths are within `/tmp/orchestrel-uploads/` (existing security check)

## Claude Session Streaming

Claude messages stream through the WebSocket (replaces SSE subscription):

- `claude:start` → server creates ClaudeSession via SDK, begins async generator, registers event handlers for counter persistence and auto-move to review on exit. All DB writes go through DbMutator → `card:updated` broadcast.
- Each SDK message → `claude:message` pushed over WS to the connection that started/owns the session
- `claude:status` pushed on session state changes (running, completed, errored, stopped)
- `claude:send` → sends user message to active session (or recreates from DB after server restart), supports file refs
- `claude:stop` → kills session via sessionManager
- Session exit → DbMutator moves card to `review` → `card:updated` broadcast to all subscribed connections
- Counter updates (promptsSent, turnsCompleted) → DbMutator → `card:updated` broadcast
- `card:generateTitle` → calls local Ollama (localhost:11434) to generate title from description → DbMutator → `card:updated` broadcast

## REST API (External Consumers)

Thin Hono routes, validated with the same Zod schemas, using the same DbMutator:

```typescript
// src/server/api/rest.ts
app.post('/api/cards', (c) => {
  const body = cardCreateSchema.parse(c.req.json())
  const card = mutator.createCard(body)  // sync, triggers WS broadcast
  return c.json(card, 201)
})

app.patch('/api/cards/:id', (c) => {
  const body = cardUpdateSchema.parse(c.req.json())
  const card = mutator.updateCard(+c.req.param('id'), body)
  return c.json(card)
})
```

OpenAPI spec generated from the same Zod schemas via `@hono/zod-openapi`, served at `/api/docs`.

## What Gets Removed

- `@trpc/client`, `@trpc/server`, `@trpc/react-query` — all tRPC
- `@tanstack/react-query`, `@tanstack/react-query-persist-client` — React Query
- `app/lib/trpc.ts` — tRPC client setup
- `app/lib/query-persist.ts` — React Query IDB persistence
- `src/server/trpc.ts` — tRPC init
- `src/server/routers/` — tRPC routers (logic moves to WS handlers + DbMutator)
- SSE subscription infrastructure

## What Gets Added

- `mobx`, `mobx-react-lite` — state management
- `ws` — WebSocket server
- `drizzle-zod` — Zod schema generation from Drizzle
- `nanoid` (if not already a transitive dep) — request ID generation
- `hono` + `@hono/zod-openapi` — REST API
- `src/shared/ws-protocol.ts` — shared typed protocol
- `src/server/ws/` — WebSocket server, connection manager, message handlers
- `src/server/db/mutator.ts` — centralized DB mutation + broadcast
- `src/server/api/rest.ts` — external REST endpoints
- `app/stores/` — MobX stores (card, project, root, session)
- `app/lib/ws-client.ts` — typed WebSocket client wrapper
- `app/lib/store-persist.ts` — MobX → IndexedDB persistence

## Migration Strategy

This is a full replacement, not incremental. Work in a git worktree. The switchover is atomic — once all stores, WS handlers, and components are migrated, merge in one shot. The numbered phases below are internal work order within the worktree, not separate deployable stages:

1. Shared protocol + Zod schemas (`src/shared/ws-protocol.ts`)
2. Server: DB mutator with broadcast
3. Server: WS server, connection manager, auth, message handlers
4. Server: REST API + OpenAPI
5. Client: MobX stores, WS client, IDB persistence
6. Client: Migrate all components from useQuery/useMutation to MobX observers
7. Claude session streaming over WS (replaces SSE subscription)
8. Remove tRPC + React Query dependencies
9. End-to-end testing
