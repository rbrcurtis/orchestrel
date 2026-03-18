# Event-Driven Architecture: MessageBus + Models + Service Layer

**Date:** 2026-03-14
**Status:** Draft

## Problem

The server-side session lifecycle (OpenCode ↔ Orchestrel) is tightly coupled to WebSocket client connections. Session event handlers that perform DB mutations (card column transitions, counter updates) are registered per-WebSocket in `subscribeToSession()`. If no client is connected when a session completes a turn, the DB update never fires and cards get stuck in `running`.

More broadly, the server layer has no separation of concerns: `beginSession()` takes a `ws` parameter, `DbMutator` reaches directly into `ConnectionManager.broadcast()`, and data access, business logic, and transport are interleaved throughout.

## Solution

Rearchitect into three clean layers with an in-process pub/sub MessageBus:

1. **Model Layer** — TypeORM ActiveRecord entities with lifecycle subscribers that publish domain events
2. **Service Layer** — Orchestrates business logic, owns session lifecycle, publishes agent messages
3. **Transport Layer** — Thin WS handlers that translate client commands into service calls and forward bus events to subscribed clients

## Architecture Overview

```
OpenCodeSession (raw agent events: message, exit)
       │
SessionService (server-side, no WS knowledge)
  - Registers one-time listeners per session
  - Updates models (card lifecycle, counters)
  - Publishes agent messages to MessageBus
       │
Model Layer (TypeORM entities)
  - card.save() triggers EntitySubscriber
  - Subscriber publishes domain events to MessageBus
       │
MessageBus (global EventEmitter singleton)
  - Hierarchical topics
  - In-process pub/sub, no external deps
       │
WS Transport (thin)
  - Subscribes to bus topics on behalf of connected clients
  - Translates client commands → service calls
  - Queries services for initial state on connect
```

## MessageBus

Global singleton, in-process EventEmitter with typed hierarchical topics.

### Topics

| Topic | Published when |
|---|---|
| `card:${id}:updated` | Card data changed (column, title, description, etc.) |
| `card:${id}:status` | Session status/counters changed (promptsSent, turnsCompleted, sessionId) |
| `card:${id}:message` | Agent message (text, tool_call, thinking, turn_end, etc.) |
| `card:${id}:deleted` | Card removed |
| `project:${id}:updated` | Project data changed |
| `project:${id}:deleted` | Project removed |
| `board:changed` | Any card moved columns (payload includes old + new column for filtering) |
| `system:error` | System-level errors (e.g., OpenCode server crash) |

### API

```typescript
class MessageBus extends EventEmitter {
  publish(topic: string, payload: unknown): void   // emit
  subscribe(topic: string, handler: Function): void // on
  unsubscribe(topic: string, handler: Function): void // removeListener
}

export const messageBus = new MessageBus()
```

Thin wrapper over EventEmitter. The wrapper provides a clear API boundary and a place for debug logging.

### File

`src/server/bus.ts`

## Model Layer

Replace Drizzle ORM with TypeORM using ActiveRecord pattern. Class-based entities with decorators. EntitySubscribers wire model persistence to the MessageBus.

**Important constraint:** All mutations MUST go through `entity.save()` / `entity.remove()` (ActiveRecord methods), NOT `Repository.update()` or `QueryBuilder.update()`. TypeORM only populates `event.entity` and `event.databaseEntity` in subscriber hooks when using the ActiveRecord `.save()` path.

### Card Entity

All columns match the existing Drizzle schema exactly.

```typescript
@Entity()
class Card extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'text' })
  title: string

  @Column({ type: 'text', default: '' })
  description: string

  @Column({ type: 'text', default: 'backlog' })
  column: string  // 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'archive'

  @Column({ type: 'real', default: 0 })
  position: number

  @Column({ type: 'integer', nullable: true })
  projectId: number | null

  @Column({ type: 'text', nullable: true })
  prUrl: string | null

  @Column({ type: 'text', nullable: true })
  sessionId: string | null

  @Column({ type: 'text', nullable: true })
  worktreePath: string | null

  @Column({ type: 'text', nullable: true })
  worktreeBranch: string | null

  @Column({ type: 'integer', default: true })
  useWorktree: boolean

  @Column({ type: 'text', nullable: true })
  sourceBranch: string | null  // 'main' | 'dev'

  @Column({ type: 'text', default: 'sonnet' })
  model: string  // 'sonnet' | 'opus' | 'auto'

  @Column({ type: 'text', default: 'high' })
  thinkingLevel: string  // 'off' | 'low' | 'medium' | 'high'

  @Column({ type: 'integer', default: 0 })
  promptsSent: number

  @Column({ type: 'integer', default: 0 })
  turnsCompleted: number

  @Column({ type: 'text' })
  createdAt: string

  @Column({ type: 'text' })
  updatedAt: string
}
```

### CardSubscriber

Change detection uses `databaseEntity` (the pre-update snapshot) vs `entity` (the new state). TypeORM loads `databaseEntity` automatically when using `.save()` on an already-loaded entity.

```typescript
@EventSubscriber()
class CardSubscriber implements EntitySubscriberInterface<Card> {
  listenTo() { return Card }

  afterInsert(event: InsertEvent<Card>) {
    messageBus.publish(`card:${event.entity.id}:updated`, event.entity)
    messageBus.publish('board:changed', {
      card: event.entity,
      oldColumn: null,
      newColumn: event.entity.column,
    })
  }

  afterUpdate(event: UpdateEvent<Card>) {
    const card = event.entity as Card
    const prev = event.databaseEntity as Card
    messageBus.publish(`card:${card.id}:updated`, card)

    if (prev.column !== card.column) {
      messageBus.publish('board:changed', {
        card,
        oldColumn: prev.column,
        newColumn: card.column,
      })
    }
    if (prev.promptsSent !== card.promptsSent
      || prev.turnsCompleted !== card.turnsCompleted
      || prev.sessionId !== card.sessionId) {
      messageBus.publish(`card:${card.id}:status`, card)
    }
  }

  afterRemove(event: RemoveEvent<Card>) {
    messageBus.publish(`card:${event.entityId}:deleted`, { id: event.entityId })
    messageBus.publish('board:changed', { card: null, oldColumn: null, newColumn: null, id: event.entityId })
  }
}
```

### Project Entity

All columns match the existing Drizzle schema.

```typescript
@Entity()
class Project extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'text' })
  name: string

  @Column({ type: 'text' })
  path: string

  @Column({ type: 'text', default: '' })
  setupCommands: string

  @Column({ type: 'integer', default: false })
  isGitRepo: boolean

  @Column({ type: 'text', nullable: true })
  defaultBranch: string | null  // 'main' | 'dev'

  @Column({ type: 'integer', default: false })
  defaultWorktree: boolean

  @Column({ type: 'text', default: 'sonnet' })
  defaultModel: string  // 'sonnet' | 'opus' | 'auto'

  @Column({ type: 'text', default: 'high' })
  defaultThinkingLevel: string  // 'off' | 'low' | 'medium' | 'high'

  @Column({ type: 'text', default: 'anthropic' })
  providerID: string

  @Column({ type: 'text', nullable: true })
  color: string | null

  @Column({ type: 'text' })
  createdAt: string
}
```

### ProjectSubscriber

```typescript
@EventSubscriber()
class ProjectSubscriber implements EntitySubscriberInterface<Project> {
  listenTo() { return Project }

  afterInsert(event: InsertEvent<Project>) {
    messageBus.publish(`project:${event.entity.id}:updated`, event.entity)
  }

  afterUpdate(event: UpdateEvent<Project>) {
    messageBus.publish(`project:${(event.entity as Project).id}:updated`, event.entity)
  }

  afterRemove(event: RemoveEvent<Project>) {
    messageBus.publish(`project:${event.entityId}:deleted`, { id: event.entityId })
  }
}
```

### TypeORM DataSource

```typescript
// src/server/models/index.ts
import { DataSource } from 'typeorm'

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: 'data/orchestrel.db',
  entities: [Card, Project],
  subscribers: [CardSubscriber, ProjectSubscriber],
  synchronize: false, // manage schema via migrations
})
```

Points at the existing SQLite database. Entity columns match the current Drizzle schema. Existing data stays intact.

### Migration from Drizzle

- TypeORM entities mirror the existing table structure exactly
- Use `synchronize: false` — no auto-schema changes
- Any column differences handled via TypeORM migrations
- Remove Drizzle dependencies: `drizzle-orm`, `drizzle-kit`, `db/schema.ts`, `db/index.ts`

### Files

- `src/server/models/Card.ts` — Card entity + CardSubscriber
- `src/server/models/Project.ts` — Project entity + ProjectSubscriber
- `src/server/models/index.ts` — DataSource initialization

## Service Layer

### SessionService

Owns the full session lifecycle. No knowledge of WebSocket or transport. Uses models for persistence and MessageBus for agent message publishing.

```typescript
class SessionService {
  // Commands
  async startSession(cardId: number, message?: string, files?: FileRef[]): Promise<void>
  async sendMessage(cardId: number, message: string): Promise<void>
  async stopSession(cardId: number): Promise<void>

  // Queries
  getStatus(cardId: number): SessionStatusData | null
  async getHistory(sessionId: string): Promise<AgentMessage[]>
}

export const sessionService = new SessionService()
```

#### Displayable message types

SessionService filters agent messages through `DISPLAY_TYPES` before publishing to the bus:
```typescript
const DISPLAY_TYPES = new Set([
  'user', 'text', 'tool_call', 'tool_result', 'tool_progress',
  'thinking', 'system', 'turn_end', 'error',
])
```

#### `startSession` flow

Handles both new sessions and follow-up messages to existing sessions.

**Existing session (follow-up message):**
1. `sessionManager.get(cardId)` — find running session
2. If model/thinking changed on card, call `session.updateModel()`
3. `session.sendMessage(message)` — send follow-up
4. Update card counters: `card.promptsSent = session.promptsSent; await card.save()`

**New session:**
1. `Card.findOneBy({ id: cardId })` — load card
2. Validate title/description (non-empty required for running)
3. Move card to running only if not already there: `if (card.column !== 'running') { card.column = 'running'; await card.save() }`
4. Handle file attachments: validate paths against `/tmp/orchestrel-uploads/`, build augmented prompt with file list
5. `ensureWorktree(card)` — create worktree if needed, `await card.save()` to persist path
6. Resolve provider/model from card + project
7. `sessionManager.create(cardId, opts)` — create agent session
8. If resuming (card has existing sessionId): restore `promptsSent` and `turnsCompleted` from card
9. Register **one-time session-level listeners** on the AgentSession:
   - `session.on('message', msg)` — filter through `DISPLAY_TYPES`, publish `card:${cardId}:message` to bus
   - On `turn_end`: `card.reload(); card.column = 'review'; card.promptsSent = session.promptsSent; card.turnsCompleted = session.turnsCompleted; await card.save()` — subscriber handles all broadcasting
   - On `exit` (error/stop only, not idle): same pattern — reload card, update via model, subscriber broadcasts
10. `session.start(prompt)` + `session.waitForReady()`
11. If new (not resume): `card.sessionId = session.sessionId; card.promptsSent = 1; card.turnsCompleted = 0; await card.save()`

**Note on turn_end vs exit:** `session.idle` (turn_end) keeps the session alive for follow-ups. Only `session.error` and `session.stop` emit `exit` and end the session. The exit listener should only move to review if `session.status` is `errored` or `stopped`.

**Note on race conditions:** `turn_end` and `exit` can fire in quick succession. The `card.reload()` before each update ensures we read fresh DB state. SQLite serializes writes at the DB level, so concurrent `.save()` calls won't corrupt data.

#### `sendMessage` flow

1. Get existing session from `sessionManager.get(cardId)`
2. Update model if needed (e.g., model/thinking changes on card), call `session.sendMessage(content)`
3. Card counter update happens in the session-level `turn_end` listener

#### `stopSession` flow

1. `sessionManager.kill(cardId)` — calls `session.kill()`, removes from map, session emits `exit`
2. Session-level exit listener updates card to review via model

**Note:** `SessionManager.kill()` currently deletes the session from its map before the exit handler fires. The exit handler reads `session.status` and `session.promptsSent` from the session object (which still exists in memory, just removed from the map), so this works correctly. The handler does not need to look up the session via `sessionManager.get()`.

### CardService

Handles card queries, mutations, and business logic that isn't session-related.

```typescript
class CardService {
  async listCards(columns?: string[]): Promise<Card[]>
  async createCard(data: Partial<Card>): Promise<Card>
  async updateCard(id: number, data: Partial<Card>): Promise<Card>
  async deleteCard(id: number): Promise<void>
  async searchCards(query: string): Promise<{ cards: Card[]; total: number }>
  async pageCards(column: string, cursor?: number, limit?: number): Promise<PageResult>
  async generateTitle(cardId: number): Promise<Card>
  async suggestTitle(description: string): Promise<string>
}

export const cardService = new CardService()
```

#### Business logic in CardService

- **`createCard`**: If `projectId` set, fetch project for defaults (`model`, `thinkingLevel`). If creating directly into `running`, call `sessionService.startSession()` after creation.
- **`updateCard`**: If moving to `running`, validate title/description and call `sessionService.startSession()`. If moving to `archive`, remove worktree if it exists.
- **`generateTitle` / `suggestTitle`**: Call Ollama (`gemma3:4b`) for title generation from description.
- **NEON_COLORS auto-assignment**: When creating a project without a color, auto-assign the first unused neon color (moved from old `DbMutator.createProject`).

All mutations go through the model's `.save()` / `.remove()` — subscribers handle event publishing.

### ProjectService

Handles project CRUD plus filesystem operations.

```typescript
class ProjectService {
  async listProjects(): Promise<Project[]>
  async createProject(data: Partial<Project>): Promise<Project>
  async updateProject(id: number, data: Partial<Project>): Promise<Project>
  async deleteProject(id: number): Promise<void>
  async browse(path: string): Promise<DirEntry[]>
  async mkdir(path: string): Promise<void>
}

export const projectService = new ProjectService()
```

#### Business logic in ProjectService

- **`createProject`**: Auto-detect `isGitRepo` from path. Auto-assign NEON_COLORS if no color specified.
- **`updateProject`**: Re-detect `isGitRepo` if path changes.
- **`browse`**: List directories (non-hidden) at path. Pure filesystem operation.
- **`mkdir`**: Create directory recursively. Pure filesystem operation.

### Files

- `src/server/services/session.ts`
- `src/server/services/card.ts`
- `src/server/services/project.ts`

## REST API

The existing Hono REST API (`/api/cards`) currently uses `DbMutator`. Migrate to use `CardService`:

```typescript
export function createRestApi() {
  const app = new Hono()

  app.post('/api/cards', zValidator('json', cardCreateSchema), async (c) => {
    const card = await cardService.createCard(c.req.valid('json'))
    return c.json(card, 201)
  })

  app.patch('/api/cards/:id', zValidator('json', cardUpdateSchema), async (c) => {
    const card = await cardService.updateCard(Number(c.req.param('id')), c.req.valid('json'))
    return c.json(card)
  })

  app.delete('/api/cards/:id', async (c) => {
    await cardService.deleteCard(Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  return app
}
```

No more `DbMutator` dependency. Card model subscribers handle event broadcasting automatically.

## WS Transport Layer

Thin layer with two jobs: translate client commands into service calls, and forward bus events to subscribed clients.

### Client → Server (commands)

| Client message | Handler action |
|---|---|
| `subscribe` | `cardService.listCards(columns)` + `projectService.listProjects()` + subscribe to bus |
| `page` | `cardService.pageCards(column, cursor, limit)` |
| `search` | `cardService.searchCards(query)` |
| `card:create` | `cardService.createCard(data)` |
| `card:update` | `cardService.updateCard(id, data)` |
| `card:delete` | `cardService.deleteCard(id)` |
| `card:generateTitle` | `cardService.generateTitle(id)` |
| `card:suggestTitle` | `cardService.suggestTitle(description)` |
| `project:create` | `projectService.createProject(data)` |
| `project:update` | `projectService.updateProject(id, data)` |
| `project:delete` | `projectService.deleteProject(id)` |
| `project:browse` | `projectService.browse(path)` |
| `project:mkdir` | `projectService.mkdir(path)` |
| `agent:send` | `sessionService.startSession(cardId, message, files)` |
| `agent:stop` | `sessionService.stopSession(cardId)` |
| `agent:status` | `sessionService.getStatus(cardId)` |
| `session:load` | `sessionService.getHistory(sessionId)` + subscribe to card messages |

Handlers are thin: parse message, call service, send `mutation:ok` or `mutation:error` response. No DB access, no session logic.

### Server → Client (bus subscriptions)

**Board subscription (`subscribe` message):**
1. Query `cardService.listCards(columns)` + `projectService.listProjects()` — send `sync` message with full current state
2. Record which columns this client cares about
3. Subscribe to `board:changed` on the bus — payload includes `oldColumn` and `newColumn`, check if client cares about either, forward `card:updated` to client
4. Subscribe to `card:${id}:status` for cards currently in subscribed columns — forward status updates
5. Subscribe to `project:${id}:updated` and `project:${id}:deleted` — forward project changes

**Card detail / session subscription (`session:load` message):**
1. Call `sessionService.getHistory(sessionId)` — send `session:history` message
2. Subscribe to `card:${id}:message` on the bus — forward live agent messages as `agent:message`
3. Subscribe to `card:${id}:updated` — forward card data changes
4. Subscribe to `card:${id}:status` — forward `agent:status` messages

**Cleanup:** On WebSocket disconnect, unsubscribe all bus topics for that client. The `subscriptions.ts` module tracks topic→handler mappings per WebSocket.

**System errors:** Subscribe all clients to `system:error` — forward as error notifications (e.g., OpenCode server crash with `cardId: -1`).

### Per-Client Subscription Management

```typescript
// src/server/ws/subscriptions.ts
class ClientSubscriptions {
  private subs = new Map<WebSocket, Map<string, Function>>()

  subscribe(ws: WebSocket, topic: string, handler: Function): void
  unsubscribe(ws: WebSocket, topic: string): void
  unsubscribeAll(ws: WebSocket): void  // called on disconnect
}

export const clientSubs = new ClientSubscriptions()
```

Wraps MessageBus subscribe/unsubscribe with per-client tracking. Guarantees cleanup on disconnect — no memory leaks.

### ConnectionManager

Stays as WebSocket bookkeeping (track open connections, send to specific ws). Remove `broadcast()` method and column-subscription tracking — that logic moves to the bus subscription layer.

### Files

- `src/server/ws/handlers.ts` — main message router (simplified, all cases are one-liners)
- `src/server/ws/handlers/agents.ts` — thin agent command handlers
- `src/server/ws/handlers/sessions.ts` — thin session load handler
- `src/server/ws/handlers/cards.ts` — thin card CRUD handlers
- `src/server/ws/handlers/projects.ts` — thin project CRUD handlers
- `src/server/ws/subscriptions.ts` — per-client bus subscription tracking
- `src/server/ws/connections.ts` — simplified ConnectionManager

## What Gets Deleted

| File/Code | Replacement |
|---|---|
| `DbMutator` class | Model `.save()` + entity subscribers + services |
| `subscribeToSession()` / `unsubscribeFromSession()` / `unsubscribeAllSessions()` | Session-level listeners in SessionService |
| `wsHandlers` Map in `begin-session.ts` | Per-client bus subscriptions in `subscriptions.ts` |
| `beginSession()` free function | `sessionService.startSession()` |
| `db/schema.ts` (Drizzle schema) | TypeORM entities |
| `db/index.ts` (Drizzle DB init) | `models/index.ts` (TypeORM DataSource) |
| `db/mutator.ts` | Gone — models + services |
| `ConnectionManager.broadcast()` | Bus subscriptions in transport layer |
| `ConnectionManager.subscribe()` / `subscribedColumns` | Bus subscriptions in transport layer |
| Drizzle dependencies (`drizzle-orm`, `drizzle-kit`) | TypeORM + `better-sqlite3` |

## What Stays Unchanged

| File/Code | Reason |
|---|---|
| `SessionManager` | Still owns AgentSession map. SessionService uses it internally |
| `OpenCodeSession` | Still emits `message` and `exit`. Doesn't know about layers above |
| `AgentSession` / `AgentMessage` types | Unchanged interface |
| `ConnectionManager` (simplified) | Still tracks open WebSockets, still has `send(ws, msg)` |
| Worktree utilities (`worktree.ts`) | Pure functions, no coupling |
| WS protocol types (`shared/ws-protocol.ts`) | Client message / server message shapes stay the same |
| OpenCode server management (`opencode/server.ts`) | Unchanged, but crash handler publishes to `system:error` bus topic |

## File Structure

```
src/
  server/
    bus.ts                      # MessageBus singleton
    models/
      Card.ts                   # Card entity + CardSubscriber
      Project.ts                # Project entity + ProjectSubscriber
      index.ts                  # TypeORM DataSource init
    services/
      session.ts                # SessionService singleton
      card.ts                   # CardService singleton
      project.ts                # ProjectService singleton
    agents/                     # Unchanged
      manager.ts                # SessionManager
      types.ts                  # AgentSession, AgentMessage
      factory.ts
      opencode/
        session.ts              # OpenCodeSession
        messages.ts
        models.ts
    ws/
      connections.ts            # ConnectionManager (simplified, no broadcast)
      subscriptions.ts          # Per-client bus subscription management
      handlers.ts               # Main message router (thin switch)
      handlers/
        agents.ts               # agent:send, agent:stop, agent:status
        sessions.ts             # session:load
        cards.ts                # card CRUD, generateTitle, suggestTitle
        projects.ts             # project CRUD, browse, mkdir
    api/
      rest.ts                   # Hono REST API (uses CardService)
    worktree.ts                 # Unchanged
    opencode/
      server.ts                 # Unchanged (crash → bus publish)
```
