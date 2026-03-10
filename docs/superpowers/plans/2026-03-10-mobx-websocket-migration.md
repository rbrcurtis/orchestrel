# MobX + WebSocket Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tRPC + React Query with MobX stores + bidirectional WebSocket for real-time server-push, plus a REST API for external consumers.

**Architecture:** Single bidirectional WebSocket carries all internal app communication (reads, writes, subscriptions, streaming). MobX observable stores on the client react to server pushes. Shared Zod protocol (derived from Drizzle schema) provides end-to-end type safety. External consumers use REST endpoints validated with the same Zod schemas.

**Tech Stack:** MobX, mobx-react-lite, ws, drizzle-zod, jose, Hono + @hono/zod-openapi, @hono/node-server, Vitest

**Spec:** `docs/superpowers/specs/2026-03-10-mobx-websocket-architecture-design.md`

---

## File Structure

### New Files

```
src/shared/
  ws-protocol.ts          # Zod schemas for WS messages (client→server, server→client)

src/server/
  db/mutator.ts           # Centralized DB writes + WS broadcast
  ws/server.ts            # WS server setup, Vite plugin for dev, attach to HTTP server
  ws/connections.ts        # Connection state, subscription tracking, broadcast
  ws/auth.ts              # Cloudflare Access JWT validation on upgrade
  ws/handlers.ts          # Message router — dispatches to handler modules
  ws/handlers/cards.ts    # Card mutation + subscription handlers
  ws/handlers/projects.ts # Project mutation handlers
  ws/handlers/claude.ts   # Claude session start/send/stop/status handlers
  ws/handlers/sessions.ts # Session JSONL history loading
  api/rest.ts             # Hono REST routes for external API

app/
  stores/card-store.ts     # Observable card map + computed views
  stores/project-store.ts  # Observable project map
  stores/session-store.ts  # Claude session messages + status per card
  stores/root-store.ts     # Root store composition + WS message router
  stores/context.tsx       # React context provider for stores
  lib/ws-client.ts         # Typed WS client wrapper with reconnection
  lib/store-persist.ts     # MobX → IndexedDB persistence
```

### Files to Remove (after migration complete)

```
src/server/trpc.ts
src/server/routers/index.ts
src/server/routers/cards.ts
src/server/routers/projects.ts
src/server/routers/sessions.ts
src/server/routers/claude.ts
app/lib/trpc.ts
app/lib/query-persist.ts
app/routes/api.trpc.$.ts
```

### Files to Modify

```
package.json              # Add/remove dependencies
app/root.tsx              # Replace QueryClient/tRPC providers with MobX StoreProvider
app/routes/board.tsx      # Use store for card selection, search
app/routes/board.index.tsx    # Use store for columns, DnD
app/routes/board.backlog.tsx  # Use store
app/routes/board.done.tsx     # Use store
app/routes/board.archive.tsx  # Use store + pagination
app/components/CardDetail.tsx # Use store actions for mutations
app/components/SessionView.tsx # Use store + WS for streaming
vite.config.ts            # Add WS server Vite plugin
src/server/claude/manager.ts  # Integrate with mutator for broadcasts
```

### Files Kept As-Is

```
src/server/db/schema.ts
src/server/db/index.ts
src/server/claude/protocol.ts
src/server/claude/types.ts
app/lib/utils.ts
app/routes/api.upload.ts
app/components/StatusRow.tsx
app/components/ContextGauge.tsx
app/components/MessageBlock.tsx
app/components/ToolUseBlock.tsx
```

---

## Chunk 1: Foundation — Dependencies, Protocol, Test Setup

### Task 1.1: Create worktree and install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create git worktree**

```bash
cd /home/ryan/Code/dispatcher
git worktree add ../dispatcher-ws-migration main
cd ../dispatcher-ws-migration
```

- [ ] **Step 2: Install new dependencies**

```bash
pnpm add mobx mobx-react-lite ws drizzle-zod hono @hono/zod-openapi @hono/node-server jose idb-keyval
pnpm add -D @types/ws vitest
```

Note: `idb-keyval` may already be installed (check `package.json`). `vite-tsconfig-paths` should already be a devDependency — verify with `pnpm ls vite-tsconfig-paths`; if missing, add it with `pnpm add -D vite-tsconfig-paths`.

- [ ] **Step 3: Remove dependencies (do NOT remove yet — just note for Task 8)**

tRPC and React Query packages will be removed in the final cleanup task after all code is migrated.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add mobx, ws, hono, drizzle-zod, vitest dependencies"
```

### Task 1.2: Create shared WS protocol

**Files:**
- Create: `src/shared/ws-protocol.ts`
- Test: `src/shared/ws-protocol.test.ts`

- [ ] **Step 1: Write protocol test**

```typescript
// src/shared/ws-protocol.test.ts
import { describe, it, expect } from 'vitest'
import {
  clientMessage, serverMessage,
  cardSchema, projectSchema,
  type ClientMessage, type ServerMessage, type Card, type Project,
} from './ws-protocol'

describe('ws-protocol', () => {
  describe('cardSchema', () => {
    it('validates a full card row', () => {
      const card = {
        id: 1, title: 'Test', description: '', column: 'backlog',
        position: 0, projectId: null, prUrl: null, sessionId: null,
        worktreePath: null, worktreeBranch: null, useWorktree: true,
        sourceBranch: null, model: 'sonnet', thinkingLevel: 'high',
        promptsSent: 0, turnsCompleted: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }
      expect(cardSchema.parse(card)).toEqual(card)
    })

    it('rejects invalid column', () => {
      expect(() => cardSchema.parse({ column: 'invalid' })).toThrow()
    })
  })

  describe('clientMessage', () => {
    it('parses subscribe message', () => {
      const msg = { type: 'subscribe', columns: ['backlog', 'ready'] }
      expect(clientMessage.parse(msg).type).toBe('subscribe')
    })

    it('parses card:move mutation', () => {
      const msg = {
        type: 'card:move', requestId: 'r1',
        data: { id: 1, column: 'review', position: 1.5 },
      }
      const parsed = clientMessage.parse(msg)
      expect(parsed.type).toBe('card:move')
    })

    it('rejects unknown message type', () => {
      expect(() => clientMessage.parse({ type: 'bogus' })).toThrow()
    })
  })

  describe('serverMessage', () => {
    it('parses sync message', () => {
      const msg = { type: 'sync', cards: [], projects: [] }
      expect(serverMessage.parse(msg).type).toBe('sync')
    })

    it('parses mutation:ok', () => {
      const msg = { type: 'mutation:ok', requestId: 'r1' }
      expect(serverMessage.parse(msg).type).toBe('mutation:ok')
    })

    it('parses card:updated', () => {
      const msg = {
        type: 'card:updated',
        data: {
          id: 1, title: 'T', description: '', column: 'ready',
          position: 0, projectId: null, prUrl: null, sessionId: null,
          worktreePath: null, worktreeBranch: null, useWorktree: true,
          sourceBranch: null, model: 'sonnet', thinkingLevel: 'high',
          promptsSent: 0, turnsCompleted: 0,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      }
      expect(serverMessage.parse(msg).type).toBe('card:updated')
    })
  })
})
```

- [ ] **Step 2: Create vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
  },
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/shared/ws-protocol.test.ts
```

Expected: FAIL — module `./ws-protocol` not found.

- [ ] **Step 4: Write the protocol module**

```typescript
// src/shared/ws-protocol.ts
import { z } from 'zod'
import { createSelectSchema, createInsertSchema } from 'drizzle-zod'
import { cards, projects } from '../server/db/schema'

// --- Entity schemas (read types, derived from Drizzle) ---

export const cardSchema = createSelectSchema(cards)
export const projectSchema = createSelectSchema(projects)

export type Card = z.infer<typeof cardSchema>
export type Project = z.infer<typeof projectSchema>

// --- Column enum ---

export const columnEnum = z.enum([
  'backlog', 'ready', 'in_progress', 'review', 'done', 'archive',
])
export type Column = z.infer<typeof columnEnum>

// --- Mutation input schemas (write types) ---

export const cardCreateSchema = createInsertSchema(cards).pick({
  title: true,
  description: true,
  column: true,
  projectId: true,
  model: true,
  thinkingLevel: true,
  useWorktree: true,
  sourceBranch: true,
})

export const cardUpdateSchema = z.object({ id: z.number() }).merge(
  cardCreateSchema.partial(),
)

export const cardMoveSchema = z.object({
  id: z.number(),
  column: columnEnum,
  position: z.number(),
})

export const projectCreateSchema = createInsertSchema(projects).pick({
  name: true,
  path: true,
  setupCommands: true,
  defaultBranch: true,
  defaultWorktree: true,
  defaultModel: true,
  defaultThinkingLevel: true,
  color: true,
})

export const projectUpdateSchema = z.object({ id: z.number() }).merge(
  projectCreateSchema.partial(),
)

// --- File refs (for Claude message attachments) ---

export const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number(),
})

// --- Claude schemas ---

export const claudeStartSchema = z.object({
  cardId: z.number(),
  prompt: z.string().min(1),
})

export const claudeSendSchema = z.object({
  cardId: z.number(),
  message: z.string().min(1),
  files: z.array(fileRefSchema).optional(),
})

export const claudeStatusSchema = z.object({
  cardId: z.number(),
  active: z.boolean(),
  // 'starting' matches existing SessionStatus type in src/server/claude/types.ts
  status: z.enum(['starting', 'running', 'completed', 'errored', 'stopped']),
  sessionId: z.string().nullable(),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
})

export const claudeMessageSchema = z.object({
  type: z.enum(['user', 'assistant', 'result', 'system']),
  message: z.record(z.unknown()),
  isSidechain: z.boolean().optional(),
  ts: z.string().optional(),
})

// --- Client → Server messages ---

export const clientMessage = z.discriminatedUnion('type', [
  // Subscription control
  z.object({ type: z.literal('subscribe'), columns: z.array(columnEnum) }),
  z.object({ type: z.literal('page'), column: columnEnum, cursor: z.number().optional(), limit: z.number() }),
  z.object({ type: z.literal('search'), query: z.string(), requestId: z.string() }),

  // Card mutations
  z.object({ type: z.literal('card:create'), requestId: z.string(), data: cardCreateSchema }),
  z.object({ type: z.literal('card:update'), requestId: z.string(), data: cardUpdateSchema }),
  z.object({ type: z.literal('card:move'), requestId: z.string(), data: cardMoveSchema }),
  z.object({ type: z.literal('card:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('card:generateTitle'), requestId: z.string(), data: z.object({ id: z.number() }) }),

  // Project mutations
  z.object({ type: z.literal('project:create'), requestId: z.string(), data: projectCreateSchema }),
  z.object({ type: z.literal('project:update'), requestId: z.string(), data: projectUpdateSchema }),
  z.object({ type: z.literal('project:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('project:browse'), requestId: z.string(), data: z.object({ path: z.string() }) }),

  // Claude session control
  z.object({ type: z.literal('claude:start'), requestId: z.string(), data: claudeStartSchema }),
  z.object({ type: z.literal('claude:send'), requestId: z.string(), data: claudeSendSchema }),
  z.object({ type: z.literal('claude:stop'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),
  z.object({ type: z.literal('claude:status'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),

  // Session history (cardId for routing the response back to the right session)
  z.object({ type: z.literal('session:load'), requestId: z.string(), data: z.object({ sessionId: z.string(), cardId: z.number() }) }),
])

export type ClientMessage = z.infer<typeof clientMessage>

// --- Server → Client messages ---

export const serverMessage = z.discriminatedUnion('type', [
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
  z.object({
    type: z.literal('page:result'), column: columnEnum,
    cards: z.array(cardSchema), nextCursor: z.number().optional(), total: z.number(),
  }),

  // Search
  z.object({ type: z.literal('search:result'), requestId: z.string(), cards: z.array(cardSchema), total: z.number() }),

  // Session history (cardId included so client can route to the right session store)
  z.object({ type: z.literal('session:history'), requestId: z.string(), cardId: z.number(), messages: z.array(claudeMessageSchema) }),

  // Claude session streaming
  z.object({ type: z.literal('claude:message'), cardId: z.number(), data: claudeMessageSchema }),
  z.object({ type: z.literal('claude:status'), data: claudeStatusSchema }),

  // Directory browsing result
  z.object({ type: z.literal('project:browse:result'), requestId: z.string(), data: z.unknown() }),
])

export type ServerMessage = z.infer<typeof serverMessage>
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/shared/ws-protocol.test.ts
```

Expected: PASS. If `drizzle-zod` `createSelectSchema` has issues with the Drizzle schema types, adjust the schema derivation (may need to use manual Zod schemas instead).

- [ ] **Step 6: Commit**

```bash
git add src/shared/ws-protocol.ts src/shared/ws-protocol.test.ts vitest.config.ts
git commit -m "feat: shared WS protocol with Zod schemas derived from Drizzle"
```

---

## Chunk 2: Server Infrastructure — Mutator, Connections, WS Server

### Task 2.1: Connection manager

**Files:**
- Create: `src/server/ws/connections.ts`
- Test: `src/server/ws/connections.test.ts`

- [ ] **Step 1: Write connection manager test**

```typescript
// src/server/ws/connections.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ConnectionManager } from './connections'
import type { ServerMessage } from '../../shared/ws-protocol'

function mockWs() {
  return { send: vi.fn(), readyState: 1 /* OPEN */ } as any
}

describe('ConnectionManager', () => {
  it('registers and removes connections', () => {
    const mgr = new ConnectionManager()
    const ws = mockWs()
    mgr.add(ws)
    expect(mgr.size).toBe(1)
    mgr.remove(ws)
    expect(mgr.size).toBe(0)
  })

  it('tracks subscribed columns', () => {
    const mgr = new ConnectionManager()
    const ws = mockWs()
    mgr.add(ws)
    mgr.subscribe(ws, ['backlog', 'ready'])
    expect(mgr.getSubscribedColumns(ws)).toEqual(new Set(['backlog', 'ready']))
  })

  it('broadcasts to subscribed connections only', () => {
    const mgr = new ConnectionManager()
    const ws1 = mockWs()
    const ws2 = mockWs()
    mgr.add(ws1)
    mgr.add(ws2)
    mgr.subscribe(ws1, ['backlog'])
    mgr.subscribe(ws2, ['ready'])

    const msg: ServerMessage = {
      type: 'card:updated',
      data: { id: 1, title: 'T', description: '', column: 'backlog', position: 0 } as any,
    }
    mgr.broadcast(msg, 'backlog')

    expect(ws1.send).toHaveBeenCalledOnce()
    expect(ws2.send).not.toHaveBeenCalled()
  })

  it('broadcasts to all when no column filter', () => {
    const mgr = new ConnectionManager()
    const ws1 = mockWs()
    const ws2 = mockWs()
    mgr.add(ws1)
    mgr.add(ws2)
    mgr.subscribe(ws1, ['backlog'])
    mgr.subscribe(ws2, ['ready'])

    const msg: ServerMessage = { type: 'project:updated', data: { id: 1 } as any }
    mgr.broadcast(msg)

    expect(ws1.send).toHaveBeenCalledOnce()
    expect(ws2.send).toHaveBeenCalledOnce()
  })

  it('broadcasts card:move to both old and new column subscribers', () => {
    const mgr = new ConnectionManager()
    const ws1 = mockWs()
    const ws2 = mockWs()
    const ws3 = mockWs()
    mgr.add(ws1); mgr.add(ws2); mgr.add(ws3)
    mgr.subscribe(ws1, ['backlog'])
    mgr.subscribe(ws2, ['ready'])
    mgr.subscribe(ws3, ['done'])

    const msg: ServerMessage = {
      type: 'card:updated',
      data: { id: 1, column: 'ready' } as any,
    }
    mgr.broadcast(msg, 'backlog', 'ready')

    expect(ws1.send).toHaveBeenCalledOnce()
    expect(ws2.send).toHaveBeenCalledOnce()
    expect(ws3.send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test — verify fail**

```bash
npx vitest run src/server/ws/connections.test.ts
```

- [ ] **Step 3: Implement ConnectionManager**

```typescript
// src/server/ws/connections.ts
import type { WebSocket } from 'ws'
import type { ServerMessage } from '../../shared/ws-protocol'

interface Connection {
  ws: WebSocket
  subscribedColumns: Set<string>
}

export class ConnectionManager {
  private connections = new Map<WebSocket, Connection>()

  get size() { return this.connections.size }

  add(ws: WebSocket) {
    this.connections.set(ws, { ws, subscribedColumns: new Set() })
  }

  remove(ws: WebSocket) {
    this.connections.delete(ws)
  }

  subscribe(ws: WebSocket, columns: string[]) {
    const conn = this.connections.get(ws)
    if (conn) conn.subscribedColumns = new Set(columns)
  }

  getSubscribedColumns(ws: WebSocket): Set<string> {
    return this.connections.get(ws)?.subscribedColumns ?? new Set()
  }

  broadcast(msg: ServerMessage, ...affectedColumns: string[]) {
    const raw = JSON.stringify(msg)
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState !== 1) continue // not OPEN
      if (affectedColumns.length === 0 ||
          affectedColumns.some(col => conn.subscribedColumns.has(col))) {
        conn.ws.send(raw)
      }
    }
  }

  /** Send to a specific connection */
  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
npx vitest run src/server/ws/connections.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/server/ws/connections.ts src/server/ws/connections.test.ts
git commit -m "feat: WebSocket connection manager with subscription filtering"
```

### Task 2.2: DB Mutator

**Files:**
- Create: `src/server/db/mutator.ts`
- Test: `src/server/db/mutator.test.ts`

- [ ] **Step 1: Write mutator test**

```typescript
// src/server/db/mutator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the broadcast integration, not actual DB calls (those are integration tests).
// Mock drizzle DB and verify broadcast is called with correct args.

describe('DbMutator', () => {
  it('is defined in Task 2.2 — integration-tested after WS server wiring in Task 2.4')
})
```

Note: The mutator wraps synchronous `better-sqlite3` calls. Full integration tests require the DB. For now, build it and verify compilation. Integration testing happens in Task 2.4.

- [ ] **Step 2: Implement the mutator**

Reference the existing logic in these files (copy business logic, not tRPC wrappers):
- `src/server/routers/cards.ts` — card CRUD, worktree setup on move to in_progress, cleanup on archive
- `src/server/routers/projects.ts` — project CRUD, color assignment, git repo detection, directory browsing

**IMPORTANT: Drizzle with `better-sqlite3` is synchronous.** Use `.get()` for single-row queries, `.all()` for multi-row. Do NOT use array destructuring on a query builder — `const [row] = db.select()...` is WRONG; use `db.select()...get()` instead.

```typescript
// src/server/db/mutator.ts
import { eq, sql, asc, inArray } from 'drizzle-orm'
import { db } from './index'
import { cards, projects, NEON_COLORS } from './schema'
import type { ConnectionManager } from '../ws/connections'
import type { Card, Project, Column } from '../../shared/ws-protocol'

export class DbMutator {
  constructor(private connMgr: ConnectionManager) {}

  // --- Cards ---

  listCards(columns?: Column[]): Card[] {
    if (columns && columns.length > 0) {
      return db.select().from(cards).where(inArray(cards.column, columns)).orderBy(asc(cards.position)).all()
    }
    return db.select().from(cards).orderBy(asc(cards.position)).all()
  }

  createCard(data: Record<string, unknown>): Card {
    const col = (data.column as string) || 'backlog'
    const maxPos = db.select({ max: sql<number>`max(position)` })
      .from(cards).where(eq(cards.column, col)).get()
    const position = (maxPos?.max ?? -1) + 1

    const created = db.insert(cards).values({
      ...data,
      position,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any).returning().get()

    this.connMgr.broadcast({ type: 'card:updated', data: created as Card }, col)
    return created as Card
  }

  updateCard(id: number, data: Record<string, unknown>): Card {
    const updated = db.update(cards)
      .set({ ...data, updatedAt: new Date().toISOString() } as any)
      .where(eq(cards.id, id))
      .returning().get()
    this.connMgr.broadcast({ type: 'card:updated', data: updated as Card }, (updated as Card).column)
    return updated as Card
  }

  moveCard(id: number, column: string, position: number): Card {
    const prev = db.select().from(cards).where(eq(cards.id, id)).get()
    const prevCol = prev?.column
    const updated = db.update(cards)
      .set({ column: column as any, position, updatedAt: new Date().toISOString() })
      .where(eq(cards.id, id))
      .returning().get()
    const cols = prevCol && prevCol !== column ? [prevCol, column] : [column]
    this.connMgr.broadcast({ type: 'card:updated', data: updated as Card }, ...cols)
    return updated as Card
  }

  deleteCard(id: number): void {
    const card = db.select().from(cards).where(eq(cards.id, id)).get()
    if (!card) return
    db.delete(cards).where(eq(cards.id, id)).run()
    this.connMgr.broadcast({ type: 'card:deleted', data: { id } }, card.column)
  }

  // --- Projects ---

  listProjects(): Project[] {
    return db.select().from(projects).all()
  }

  createProject(data: Record<string, unknown>): Project {
    if (!data.color) {
      const used = db.select({ color: projects.color }).from(projects).all()
        .map(p => p.color).filter(Boolean)
      data.color = NEON_COLORS.find(c => !used.includes(c)) ?? NEON_COLORS[0]
    }
    const created = db.insert(projects).values({
      ...data,
      createdAt: new Date().toISOString(),
    } as any).returning().get()
    this.connMgr.broadcast({ type: 'project:updated', data: created as Project })
    return created as Project
  }

  updateProject(id: number, data: Record<string, unknown>): Project {
    const updated = db.update(projects)
      .set(data as any)
      .where(eq(projects.id, id))
      .returning().get()
    this.connMgr.broadcast({ type: 'project:updated', data: updated as Project })
    return updated as Project
  }

  deleteProject(id: number): void {
    db.delete(projects).where(eq(projects.id, id)).run()
    this.connMgr.broadcast({ type: 'project:deleted', data: { id } })
  }
}
```

**Important:** The worktree setup/cleanup logic from `cards.ts` (lines ~70-130 in the current router) and git repo detection from `projects.ts` must be ported into the WS handlers (Task 3.1, 3.2), NOT into the mutator. The mutator only handles DB writes + broadcast. Side effects (worktree creation, git operations) belong in the handlers that call the mutator.

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit src/server/db/mutator.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/server/db/mutator.ts src/server/db/mutator.test.ts
git commit -m "feat: DB mutator with broadcast for cards and projects"
```

### Task 2.3: Cloudflare Access auth for WS upgrade

**Files:**
- Create: `src/server/ws/auth.ts`

- [ ] **Step 1: Implement auth module**

```typescript
// src/server/ws/auth.ts
import type { IncomingMessage } from 'http'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const CF_TEAM_DOMAIN = 'rbrcurtis' // <team>.cloudflareaccess.com
const CERTS_URL = `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`

// jose caches JWK set and handles rotation automatically
const jwks = createRemoteJWKSet(new URL(CERTS_URL))

/**
 * Validate Cloudflare Access JWT from the CF_Authorization cookie.
 * Uses jose for full cryptographic signature verification.
 * In dev mode, skip validation.
 */
export async function validateCfAccess(req: IncomingMessage): Promise<boolean> {
  if (process.env.NODE_ENV === 'development') return true

  const cookie = req.headers.cookie ?? ''
  const match = cookie.match(/CF_Authorization=([^;]+)/)
  if (!match) return false

  try {
    await jwtVerify(match[1], jwks, {
      issuer: `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com`,
      // audience is the Access Application's AUD tag — set via env or hardcode
      // audience: process.env.CF_ACCESS_AUD,
    })
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/auth.ts
git commit -m "feat: Cloudflare Access JWT validation for WS upgrade"
```

### Task 2.4: WebSocket server + Vite plugin

**Files:**
- Create: `src/server/ws/server.ts`
- Modify: `vite.config.ts`

- [ ] **Step 1: Create WS server module**

```typescript
// src/server/ws/server.ts
import { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Plugin } from 'vite'
import { ConnectionManager } from './connections'
import { DbMutator } from '../db/mutator'
import { validateCfAccess } from './auth'
import { handleMessage } from './handlers'

export const connections = new ConnectionManager()
export const mutator = new DbMutator(connections)

export function createWsServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    // Only handle /ws path
    if (req.url !== '/ws') return

    const valid = await validateCfAccess(req)
    if (!valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    connections.add(ws)

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        handleMessage(ws, data, connections, mutator)
      } catch (err) {
        console.error('WS message parse error:', err)
      }
    })

    ws.on('close', () => {
      connections.remove(ws)
    })
  })

  return wss
}

/**
 * Vite plugin to attach WS server to dev server's HTTP server.
 */
export function wsServerPlugin(): Plugin {
  return {
    name: 'dispatcher-ws',
    configureServer(server) {
      if (server.httpServer) {
        createWsServer(server.httpServer)
        console.log('[ws] WebSocket server attached to Vite dev server')
      }
    },
  }
}
```

- [ ] **Step 2: Add plugin to vite.config.ts**

Read the current vite.config.ts and add the wsServerPlugin import. Add the plugin to the plugins array.

In `vite.config.ts`, add:
```typescript
import { wsServerPlugin } from './src/server/ws/server'
```

And add `wsServerPlugin()` to the `plugins` array.

- [ ] **Step 3: Create stub handlers module** (real handlers in Chunk 3)

```typescript
// src/server/ws/handlers.ts
import type { WebSocket } from 'ws'
import type { ConnectionManager } from './connections'
import type { DbMutator } from '../db/mutator'
import { clientMessage } from '../../shared/ws-protocol'

export function handleMessage(
  ws: WebSocket,
  raw: unknown,
  connections: ConnectionManager,
  mutator: DbMutator,
) {
  const parsed = clientMessage.safeParse(raw)
  if (!parsed.success) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId: (raw as any)?.requestId ?? 'unknown',
      error: `Invalid message: ${parsed.error.message}`,
    })
    return
  }

  const msg = parsed.data
  switch (msg.type) {
    case 'subscribe': {
      connections.subscribe(ws, msg.columns)
      // Send sync with cards in subscribed columns + all projects
      const cards = mutator.listCards(msg.columns as any)
      const projects = mutator.listProjects()
      connections.send(ws, { type: 'sync', cards, projects })
      break
    }
    default:
      // TODO: implement remaining handlers in Chunk 3
      if ('requestId' in msg) {
        connections.send(ws, {
          type: 'mutation:error',
          requestId: msg.requestId,
          error: `Handler not implemented: ${msg.type}`,
        })
      }
  }
}
```

- [ ] **Step 4: Verify dev server starts with WS**

```bash
pnpm dev &
sleep 3
# Test WS connection
node -e "
const ws = new (require('ws'))('ws://192.168.4.200:6194/ws');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', columns: ['backlog','ready','in_progress','review','done'] }));
});
ws.on('message', (d) => { console.log('GOT:', d.toString().slice(0, 200)); ws.close(); process.exit(0); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
"
kill %1
```

Expected: `GOT: {"type":"sync","cards":[...],"projects":[...]}`

- [ ] **Step 5: Commit**

```bash
git add src/server/ws/server.ts src/server/ws/handlers.ts vite.config.ts
git commit -m "feat: WebSocket server with Vite plugin, subscribe/sync handler"
```

---

## Chunk 3: Server Message Handlers

### Task 3.1: Card handlers

**Files:**
- Create: `src/server/ws/handlers/cards.ts`
- Modify: `src/server/ws/handlers.ts`

- [ ] **Step 1: Implement card handlers**

Port business logic from `src/server/routers/cards.ts`. Key logic to preserve:
- `create`: validate project exists if projectId set, setup worktree if card starts in `in_progress`
- `move`: worktree setup when moving to `in_progress`, worktree cleanup when moving to `archive`
- `update`: partial updates for title, description, projectId, model, thinkingLevel
- `delete`: remove card
- `generateTitle`: call Ollama at `http://localhost:11434/api/generate`

```typescript
// src/server/ws/handlers/cards.ts
import type { WebSocket } from 'ws'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import type { ClientMessage } from '../../../shared/ws-protocol'

export function handleCardCreate(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'card:create' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    // Port validation logic from cards.ts router create mutation
    // If projectId is set, verify project exists
    // Call mutator.createCard(msg.data)
    // If column is in_progress and project has worktree, set up worktree
    const card = mutator.createCard(msg.data as any)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: card })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleCardUpdate(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'card:update' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    const { id, ...data } = msg.data
    const card = mutator.updateCard(id, data)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: card })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleCardMove(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'card:move' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    // Port worktree setup/cleanup logic from cards.ts move mutation
    const card = mutator.moveCard(msg.data.id, msg.data.column, msg.data.position)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: card })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleCardDelete(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'card:delete' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    mutator.deleteCard(msg.data.id)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export async function handleCardGenerateTitle(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'card:generateTitle' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    // Port Ollama call from cards.ts generateTitle mutation
    // 1. Fetch card description from DB
    // 2. Call Ollama API
    // 3. mutator.updateCard(id, { title: generated })
    // 4. Send mutation:ok
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}
```

**Note:** The implementing agent MUST read the full `src/server/routers/cards.ts` file and port all business logic — worktree setup (`execSync` git commands), Ollama integration, position calculation, project validation. The code above is the handler skeleton; the actual logic must be faithfully ported.

- [ ] **Step 2: Wire into main handler**

Update `src/server/ws/handlers.ts` to import and dispatch to card handlers:

```typescript
case 'card:create': handleCardCreate(ws, msg, connections, mutator); break
case 'card:update': handleCardUpdate(ws, msg, connections, mutator); break
case 'card:move': handleCardMove(ws, msg, connections, mutator); break
case 'card:delete': handleCardDelete(ws, msg, connections, mutator); break
case 'card:generateTitle': handleCardGenerateTitle(ws, msg, connections, mutator); break
```

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/handlers/cards.ts src/server/ws/handlers.ts
git commit -m "feat: WS card mutation handlers (create, update, move, delete, generateTitle)"
```

### Task 3.2: Project handlers

**Files:**
- Create: `src/server/ws/handlers/projects.ts`
- Modify: `src/server/ws/handlers.ts`

- [ ] **Step 1: Implement project handlers**

Port business logic from `src/server/routers/projects.ts`: CRUD, directory browsing, git repo detection, auto-color assignment.

```typescript
// src/server/ws/handlers/projects.ts
import type { WebSocket } from 'ws'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import type { ClientMessage } from '../../../shared/ws-protocol'

export function handleProjectCreate(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'project:create' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    // Port git repo detection from projects.ts
    const project = mutator.createProject(msg.data as any)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: project })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleProjectUpdate(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'project:update' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    const { id, ...data } = msg.data
    const project = mutator.updateProject(id, data)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: project })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleProjectDelete(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'project:delete' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    mutator.deleteProject(msg.data.id)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleProjectBrowse(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'project:browse' }>,
  connections: ConnectionManager,
) {
  try {
    // Port directory browsing logic from projects.ts browse query
    // Read directory, filter hidden, return entries
    connections.send(ws, {
      type: 'project:browse:result',
      requestId: msg.requestId,
      data: [], // implement
    })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}
```

**Note:** The implementing agent MUST read `src/server/routers/projects.ts` and port all logic.

- [ ] **Step 2: Wire into main handler**

Add project cases to `src/server/ws/handlers.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/handlers/projects.ts src/server/ws/handlers.ts
git commit -m "feat: WS project mutation handlers"
```

### Task 3.3: Session history + pagination + search handlers

**Files:**
- Create: `src/server/ws/handlers/sessions.ts`
- Modify: `src/server/ws/handlers.ts`

- [ ] **Step 1: Implement session history loader**

Port from `src/server/routers/sessions.ts` — reads JSONL files, parses messages.

```typescript
// src/server/ws/handlers/sessions.ts
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { WebSocket } from 'ws'
import type { ConnectionManager } from '../connections'
import type { ClientMessage } from '../../../shared/ws-protocol'

export function handleSessionLoad(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
) {
  try {
    const sessPath = join(process.cwd(), 'data', 'sessions', `${msg.data.sessionId}.jsonl`)
    const raw = readFileSync(sessPath, 'utf8')
    const mtime = statSync(sessPath).mtime.toISOString()
    const messages = raw.split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
      .filter((m: any) => ['assistant', 'user', 'result', 'system'].includes(m.type))
      .map((m: any) => ({ ...m, ts: m.ts ?? mtime }))

    connections.send(ws, {
      type: 'session:history',
      requestId: msg.requestId,
      cardId: msg.data.cardId,
      messages,
    })
    // Also send mutation:ok so the client's mutate() promise resolves
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}
```

- [ ] **Step 2: Implement pagination handler**

Add to handlers.ts `subscribe` handler or as a separate page handler:

```typescript
case 'page': {
  const cards = mutator.listCards([msg.column] as any)
  // Sort by position, apply cursor + limit
  const sorted = cards.sort((a, b) => a.position - b.position)
  const startIdx = msg.cursor != null
    ? sorted.findIndex(c => c.position > msg.cursor!)
    : 0
  const page = sorted.slice(startIdx, startIdx + msg.limit)
  const nextCursor = page.length === msg.limit ? page[page.length - 1].position : undefined
  connections.send(ws, {
    type: 'page:result',
    column: msg.column,
    cards: page,
    nextCursor,
    total: sorted.length,
  })
  break
}
```

- [ ] **Step 3: Implement search handler**

```typescript
case 'search': {
  // Simple LIKE search on title and description
  const results = db.select().from(cards)
    .where(sql`title LIKE ${'%' + msg.query + '%'} OR description LIKE ${'%' + msg.query + '%'}`)
    .orderBy(asc(cards.updatedAt))
    .limit(50)
    .all()
  connections.send(ws, {
    type: 'search:result',
    requestId: msg.requestId,
    cards: results,
    total: results.length,
  })
  break
}
```

- [ ] **Step 4: Wire into main handler and commit**

```bash
git add src/server/ws/handlers/sessions.ts src/server/ws/handlers.ts
git commit -m "feat: WS handlers for session history, pagination, and search"
```

---

## Chunk 4: Client Infrastructure — MobX Stores, WS Client, IDB Persistence

### Task 4.1: WS client wrapper

**Files:**
- Create: `app/lib/ws-client.ts`

- [ ] **Step 1: Implement typed WS client**

```typescript
// app/lib/ws-client.ts
import {
  clientMessage, serverMessage,
  type ClientMessage, type ServerMessage,
} from '../../src/shared/ws-protocol'

type EntityHandler = (msg: ServerMessage) => void

export class WsClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private onEntity: EntityHandler
  private subscribedColumns: string[] = []
  private reconnectAttempt = 0
  private maxReconnectDelay = 30_000
  private disposed = false

  constructor(onEntity: EntityHandler) {
    this.onEntity = onEntity
    this.connect()
  }

  private get wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/ws`
  }

  private connect() {
    if (this.disposed) return
    this.ws = new WebSocket(this.wsUrl)

    this.ws.onopen = () => {
      this.reconnectAttempt = 0
      if (this.subscribedColumns.length > 0) {
        this.send({ type: 'subscribe', columns: this.subscribedColumns as any })
      }
    }

    this.ws.onmessage = (evt) => {
      try {
        const raw = JSON.parse(evt.data)
        const msg = serverMessage.parse(raw)
        if (msg.type === 'mutation:ok' || msg.type === 'mutation:error') {
          const p = this.pending.get(msg.requestId)
          if (p) {
            clearTimeout(p.timeout)
            this.pending.delete(msg.requestId)
            if (msg.type === 'mutation:ok') p.resolve(msg.data)
            else p.reject(new Error(msg.error))
          }
        } else {
          this.onEntity(msg)
        }
      } catch (err) {
        console.error('[ws] message parse error:', err)
      }
    }

    this.ws.onclose = () => {
      if (!this.disposed) this.scheduleReconnect()
    }
    this.ws.onerror = () => this.ws?.close()
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay)
    this.reconnectAttempt++
    // Reject all pending — callers will rollback optimistic state
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout)
      p.reject(new Error('WebSocket disconnected'))
    }
    this.pending.clear()
    setTimeout(() => this.connect(), delay)
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  subscribe(columns: string[]) {
    this.subscribedColumns = columns
    this.send({ type: 'subscribe', columns: columns as any })
  }

  async mutate<T = unknown>(msg: ClientMessage & { requestId: string }): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.requestId)
        reject(new Error('Mutation timeout'))
      }, 15_000)
      this.pending.set(msg.requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
      })
      this.send(msg)
    })
  }

  dispose() {
    this.disposed = true
    this.ws?.close()
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout)
      p.reject(new Error('Client disposed'))
    }
    this.pending.clear()
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/lib/ws-client.ts
git commit -m "feat: typed WebSocket client with reconnection and mutation correlation"
```

### Task 4.2: MobX stores

**Files:**
- Create: `app/stores/card-store.ts`
- Create: `app/stores/project-store.ts`
- Create: `app/stores/session-store.ts`
- Create: `app/stores/root-store.ts`
- Create: `app/stores/context.tsx`

- [ ] **Step 1: Card store**

```typescript
// app/stores/card-store.ts
import { makeAutoObservable, toJS } from 'mobx'
import type { Card, Column } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'

let _ws: WsClient | null = null
export function setWsClient(ws: WsClient) { _ws = ws }

export class CardStore {
  cards = new Map<number, Card>()

  constructor() {
    makeAutoObservable(this)
  }

  // --- Computed ---

  cardsByColumn(col: string): Card[] {
    return [...this.cards.values()]
      .filter(c => c.column === col)
      .sort((a, b) => a.position - b.position)
  }

  getCard(id: number): Card | undefined {
    return this.cards.get(id)
  }

  // --- Hydration ---

  hydrate(cards: Card[]) {
    for (const c of cards) this.cards.set(c.id, c)
  }

  clear() {
    this.cards.clear()
  }

  // --- Server push handlers ---

  handleUpdated(card: Card) {
    this.cards.set(card.id, card)
  }

  handleDeleted(id: number) {
    this.cards.delete(id)
  }

  // --- Optimistic mutations ---

  async createCard(data: Record<string, unknown>): Promise<Card> {
    const requestId = crypto.randomUUID()
    const card = await _ws!.mutate<Card>({
      type: 'card:create', requestId, data: data as any,
    })
    return card
  }

  async updateCard(id: number, data: Record<string, unknown>): Promise<void> {
    const prev = toJS(this.cards.get(id))
    if (prev) this.cards.set(id, { ...prev, ...data } as Card)

    try {
      await _ws!.mutate({
        type: 'card:update',
        requestId: crypto.randomUUID(),
        data: { id, ...data } as any,
      })
    } catch {
      if (prev) this.cards.set(id, prev)
    }
  }

  async moveCard(id: number, column: Column, position: number): Promise<void> {
    const prev = toJS(this.cards.get(id))
    if (prev) this.cards.set(id, { ...prev, column, position })

    try {
      await _ws!.mutate({
        type: 'card:move',
        requestId: crypto.randomUUID(),
        data: { id, column, position },
      })
    } catch {
      if (prev) this.cards.set(id, prev)
    }
  }

  async deleteCard(id: number): Promise<void> {
    const prev = toJS(this.cards.get(id))
    this.cards.delete(id)

    try {
      await _ws!.mutate({
        type: 'card:delete',
        requestId: crypto.randomUUID(),
        data: { id },
      })
    } catch {
      if (prev) this.cards.set(id, prev)
    }
  }

  async generateTitle(id: number): Promise<void> {
    await _ws!.mutate({
      type: 'card:generateTitle',
      requestId: crypto.randomUUID(),
      data: { id },
    })
  }

  // --- Serialization for IDB ---

  serialize(): Card[] {
    return [...this.cards.values()]
  }
}
```

- [ ] **Step 2: Project store**

```typescript
// app/stores/project-store.ts
import { makeAutoObservable, toJS } from 'mobx'
import type { Project } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'

let _ws: WsClient | null = null
export function setProjectWs(ws: WsClient) { _ws = ws }

export class ProjectStore {
  projects = new Map<number, Project>()

  constructor() {
    makeAutoObservable(this)
  }

  get all(): Project[] {
    return [...this.projects.values()]
  }

  getProject(id: number): Project | undefined {
    return this.projects.get(id)
  }

  hydrate(projects: Project[]) {
    for (const p of projects) this.projects.set(p.id, p)
  }

  handleUpdated(project: Project) {
    this.projects.set(project.id, project)
  }

  handleDeleted(id: number) {
    this.projects.delete(id)
  }

  async createProject(data: Record<string, unknown>): Promise<Project> {
    return _ws!.mutate<Project>({
      type: 'project:create',
      requestId: crypto.randomUUID(),
      data: data as any,
    })
  }

  async updateProject(id: number, data: Record<string, unknown>): Promise<void> {
    const prev = toJS(this.projects.get(id))
    if (prev) this.projects.set(id, { ...prev, ...data } as Project)
    try {
      await _ws!.mutate({
        type: 'project:update',
        requestId: crypto.randomUUID(),
        data: { id, ...data } as any,
      })
    } catch {
      if (prev) this.projects.set(id, prev)
    }
  }

  async deleteProject(id: number): Promise<void> {
    const prev = toJS(this.projects.get(id))
    this.projects.delete(id)
    try {
      await _ws!.mutate({
        type: 'project:delete',
        requestId: crypto.randomUUID(),
        data: { id },
      })
    } catch {
      if (prev) this.projects.set(id, prev)
    }
  }

  serialize(): Project[] {
    return [...this.projects.values()]
  }
}
```

- [ ] **Step 3: Session store** (Claude streaming messages + status per card)

```typescript
// app/stores/session-store.ts
import { makeAutoObservable, observable } from 'mobx'
import type { WsClient } from '../lib/ws-client'
import type { ServerMessage } from '../../src/shared/ws-protocol'

interface SessionState {
  active: boolean
  status: string
  sessionId: string | null
  promptsSent: number
  turnsCompleted: number
  liveMessages: Array<Record<string, unknown>>
  history: Array<Record<string, unknown>>
  contextTokens: number
  contextWindow: number
}

let _ws: WsClient | null = null
export function setSessionWs(ws: WsClient) { _ws = ws }

export class SessionStore {
  sessions = observable.map<number, SessionState>()

  constructor() {
    makeAutoObservable(this)
  }

  getSession(cardId: number): SessionState | undefined {
    return this.sessions.get(cardId)
  }

  handleClaudeMessage(cardId: number, data: Record<string, unknown>) {
    let session = this.sessions.get(cardId)
    if (!session) {
      session = this.makeSession()
      this.sessions.set(cardId, session)
    }
    session.liveMessages.push(data)

    // Extract context tokens from assistant messages
    if (data.type === 'assistant' && data.message) {
      const msg = data.message as Record<string, unknown>
      if (msg.usage && typeof msg.usage === 'object') {
        const usage = msg.usage as Record<string, number>
        session.contextTokens = usage.input_tokens ?? session.contextTokens
      }
    }
    // Extract context window from result messages
    if (data.type === 'result' && data.message) {
      const msg = data.message as Record<string, unknown>
      if (msg.modelUsage && typeof msg.modelUsage === 'object') {
        const mu = msg.modelUsage as Record<string, number>
        session.contextWindow = mu.contextWindow ?? session.contextWindow
      }
    }
  }

  handleClaudeStatus(data: {
    cardId: number; active: boolean; status: string;
    sessionId: string | null; promptsSent: number; turnsCompleted: number;
  }) {
    let session = this.sessions.get(data.cardId)
    if (!session) {
      session = this.makeSession()
      this.sessions.set(data.cardId, session)
    }
    Object.assign(session, {
      active: data.active,
      status: data.status,
      sessionId: data.sessionId,
      promptsSent: data.promptsSent,
      turnsCompleted: data.turnsCompleted,
    })
  }

  setHistory(cardId: number, messages: Array<Record<string, unknown>>) {
    let session = this.sessions.get(cardId)
    if (!session) {
      session = this.makeSession()
      this.sessions.set(cardId, session)
    }
    session.history = messages
  }

  clearLiveMessages(cardId: number) {
    const session = this.sessions.get(cardId)
    if (session) session.liveMessages = []
  }

  // --- Actions ---

  async startSession(cardId: number, prompt: string): Promise<void> {
    await _ws!.mutate({
      type: 'claude:start',
      requestId: crypto.randomUUID(),
      data: { cardId, prompt },
    })
  }

  async sendMessage(cardId: number, message: string, files?: Array<Record<string, unknown>>): Promise<void> {
    await _ws!.mutate({
      type: 'claude:send',
      requestId: crypto.randomUUID(),
      data: { cardId, message, files } as any,
    })
  }

  async stopSession(cardId: number): Promise<void> {
    await _ws!.mutate({
      type: 'claude:stop',
      requestId: crypto.randomUUID(),
      data: { cardId },
    })
  }

  async requestStatus(cardId: number): Promise<void> {
    await _ws!.mutate({
      type: 'claude:status',
      requestId: crypto.randomUUID(),
      data: { cardId },
    })
  }

  async loadHistory(sessionId: string, cardId: number): Promise<void> {
    // Response comes as session:history → handleMessage in root store
    // cardId is included in both request and response for routing
    await _ws!.mutate({
      type: 'session:load',
      requestId: crypto.randomUUID(),
      data: { sessionId, cardId },
    })
  }

  private makeSession(): SessionState {
    return {
      active: false, status: 'completed', sessionId: null,
      promptsSent: 0, turnsCompleted: 0,
      liveMessages: [], history: [],
      contextTokens: 0, contextWindow: 0,
    }
  }
}
```

- [ ] **Step 4: Root store**

```typescript
// app/stores/root-store.ts
import { CardStore, setWsClient } from './card-store'
import { ProjectStore, setProjectWs } from './project-store'
import { SessionStore, setSessionWs } from './session-store'
import { WsClient } from '../lib/ws-client'
import type { ServerMessage } from '../../src/shared/ws-protocol'

export class RootStore {
  cards: CardStore
  projects: ProjectStore
  sessions: SessionStore
  ws: WsClient

  constructor() {
    this.cards = new CardStore()
    this.projects = new ProjectStore()
    this.sessions = new SessionStore()
    this.ws = new WsClient(this.handleMessage)
    setWsClient(this.ws)
    setProjectWs(this.ws)
    setSessionWs(this.ws)
  }

  handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case 'sync':
        this.cards.hydrate(msg.cards as any)
        this.projects.hydrate(msg.projects as any)
        break
      case 'card:updated':
        this.cards.handleUpdated(msg.data as any)
        break
      case 'card:deleted':
        this.cards.handleDeleted(msg.data.id)
        break
      case 'project:updated':
        this.projects.handleUpdated(msg.data as any)
        break
      case 'project:deleted':
        this.projects.handleDeleted(msg.data.id)
        break
      case 'claude:message':
        this.sessions.handleClaudeMessage(msg.cardId, msg.data as any)
        break
      case 'claude:status':
        this.sessions.handleClaudeStatus(msg.data as any)
        break
      case 'session:history':
        this.sessions.setHistory(msg.cardId, msg.messages as any)
        break
      case 'page:result':
        this.cards.hydrate(msg.cards as any)
        break
      case 'search:result':
        // Handle in a search-specific observable if needed
        break
    }
  }

  subscribe(columns: string[]) {
    this.ws.subscribe(columns)
  }

  dispose() {
    this.ws.dispose()
  }
}
```

- [ ] **Step 5: React context**

```typescript
// app/stores/context.tsx
import { createContext, useContext } from 'react'
import type { RootStore } from './root-store'

const StoreContext = createContext<RootStore | null>(null)

export function StoreProvider({ store, children }: { store: RootStore; children: React.ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): RootStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used within StoreProvider')
  return store
}

export function useCardStore() { return useStore().cards }
export function useProjectStore() { return useStore().projects }
export function useSessionStore() { return useStore().sessions }
```

- [ ] **Step 6: Commit**

```bash
git add app/stores/ app/lib/ws-client.ts
git commit -m "feat: MobX stores (card, project, session, root) + React context"
```

### Task 4.3: IndexedDB persistence

**Files:**
- Create: `app/lib/store-persist.ts`

- [ ] **Step 1: Implement persistence**

```typescript
// app/lib/store-persist.ts
import { autorun, toJS } from 'mobx'
import { get, set } from 'idb-keyval'

interface Persistable {
  serialize(): unknown[]
  hydrate(data: unknown[]): void
}

export function persistStore<T extends Persistable>(store: T, key: string) {
  // Load from IDB on init
  get(key).then((cached) => {
    if (Array.isArray(cached) && cached.length > 0) {
      store.hydrate(cached)
    }
  })

  // Save to IDB on change, debounced 1s
  autorun(
    () => {
      const data = toJS(store.serialize())
      set(key, data)
    },
    { delay: 1000 },
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/lib/store-persist.ts
git commit -m "feat: MobX → IndexedDB persistence via autorun"
```

---

## Chunk 5: Client Migration — Components

### Task 5.1: Root layout — swap providers

**Files:**
- Modify: `app/root.tsx`

- [ ] **Step 1: Read current root.tsx**

Read `app/root.tsx` thoroughly. Understand the provider hierarchy:
```
QueryClient → PersistQueryClientProvider → TRPCProvider → App
```

- [ ] **Step 2: Replace providers**

Replace the React Query + tRPC provider stack with MobX StoreProvider:

```typescript
import { RootStore } from './stores/root-store'
import { StoreProvider } from './stores/context'
import { persistStore } from './lib/store-persist'

// Module-level singleton (survives HMR)
let rootStore: RootStore
if (!(globalThis as any).__rootStore) {
  rootStore = new RootStore()
  persistStore(rootStore.cards, 'dispatcher:cards')
  persistStore(rootStore.projects, 'dispatcher:projects')
  ;(globalThis as any).__rootStore = rootStore
} else {
  rootStore = (globalThis as any).__rootStore
}
```

Replace the provider tree:
```tsx
// Before: <PersistQueryClientProvider><TRPCProvider>
// After:
<StoreProvider store={rootStore}>
  {children}
</StoreProvider>
```

Keep: service worker registration, Vite HMR handler, theme/layout.
Remove: QueryClient creation, persister, tRPC client creation.

- [ ] **Step 3: Verify app loads** (will have broken components, but root should render)

```bash
pnpm dev
# Visit http://192.168.4.200:6194 — should load without provider errors
```

- [ ] **Step 4: Commit**

```bash
git add app/root.tsx
git commit -m "feat: replace React Query + tRPC providers with MobX StoreProvider"
```

### Task 5.2: Board layout (board.tsx)

**Files:**
- Modify: `app/routes/board.tsx`

- [ ] **Step 1: Read and understand current board.tsx**

Read `app/routes/board.tsx`. It manages:
- Selected card state (URL search params)
- Panel resize
- New card modal
- Search
- Navigation

- [ ] **Step 2: Migrate to MobX**

Replace `useQuery(trpc.cards.list.queryOptions())` and `useQuery(trpc.projects.list.queryOptions())` with store access:

```typescript
import { observer } from 'mobx-react-lite'
import { useCardStore, useProjectStore, useStore } from '../stores/context'

// Wrap component with observer()
export default observer(function BoardLayout() {
  const cardStore = useCardStore()
  const projectStore = useProjectStore()
  const store = useStore()

  // Subscribe to active columns on mount
  useEffect(() => {
    store.subscribe(['backlog', 'ready', 'in_progress', 'review', 'done'])
  }, [])

  // Replace: const { data: allCards } = useQuery(...)
  // With: observe cardStore directly
  const selectedCard = cardStore.getCard(selectedCardId)

  // ... rest of component
})
```

Replace all `useMutation` calls with store action calls.

- [ ] **Step 3: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: migrate board.tsx layout to MobX observers"
```

### Task 5.3: Board index (main board with DnD)

**Files:**
- Modify: `app/routes/board.index.tsx`

- [ ] **Step 1: Read and understand current board.index.tsx**

This is the most complex component — 378 lines with:
- Column grouping from server data
- Drag-and-drop with dnd-kit
- Optimistic card movement
- Color enrichment from projects
- Local column state synced from server via useEffect

- [ ] **Step 2: Migrate to MobX**

Key changes:
- Replace `useQuery(trpc.cards.list.queryOptions())` with `useCardStore()`
- Replace the `columns` local state + useEffect sync with MobX computed `cardsByColumn`
- Replace `moveMutation` with `cardStore.moveCard()`
- Keep dnd-kit logic, but use MobX for state
- Wrap with `observer()`

The `columns` local state pattern can be simplified:
```typescript
// Before: local state + useEffect sync from server
// After: computed directly from store
const backlog = cardStore.cardsByColumn('backlog')
const ready = cardStore.cardsByColumn('ready')
// ... etc

// For DnD optimistic reorder during drag, use a local override:
const [dragOverride, setDragOverride] = useState<Record<string, Card[]> | null>(null)
const displayColumns = dragOverride ?? {
  backlog, ready, in_progress, review, done,
}
```

- [ ] **Step 3: Verify DnD still works**

Test drag-and-drop between columns. Cards should move optimistically and persist.

- [ ] **Step 4: Commit**

```bash
git add app/routes/board.index.tsx
git commit -m "feat: migrate board index to MobX with DnD support"
```

### Task 5.4: Remaining board routes

**Files:**
- Modify: `app/routes/board.backlog.tsx`
- Modify: `app/routes/board.done.tsx`
- Modify: `app/routes/board.archive.tsx`

- [ ] **Step 1: Migrate board.backlog.tsx**

Same pattern as board.index.tsx but single-column. Replace query with store. Wrap with `observer()`.

- [ ] **Step 2: Migrate board.done.tsx**

Same pattern.

- [ ] **Step 3: Migrate board.archive.tsx**

This one needs pagination support:
```typescript
const cardStore = useCardStore()
const store = useStore()
const [loading, setLoading] = useState(false)

// Initial page load
useEffect(() => {
  store.ws.send({ type: 'page', column: 'archive', limit: 50 })
}, [])

// Infinite scroll handler
function loadMore() {
  const archiveCards = cardStore.cardsByColumn('archive')
  const lastPos = archiveCards[archiveCards.length - 1]?.position
  store.ws.send({ type: 'page', column: 'archive', cursor: lastPos, limit: 50 })
}
```

- [ ] **Step 4: Commit**

```bash
git add app/routes/board.backlog.tsx app/routes/board.done.tsx app/routes/board.archive.tsx
git commit -m "feat: migrate backlog, done, archive routes to MobX"
```

### Task 5.5: CardDetail component

**Files:**
- Modify: `app/components/CardDetail.tsx`

- [ ] **Step 1: Read CardDetail.tsx (664 lines)**

This is a large component. Key integrations:
- `useQuery(trpc.cards.list)` for card data
- `useQuery(trpc.projects.list)` for project dropdown
- `useMutation(trpc.cards.update)` for saving changes
- `useMutation(trpc.cards.delete)` for deletion
- `useMutation(trpc.cards.move)` for column changes
- `useMutation(trpc.cards.generateTitle)` for AI title
- Status display from `useQuery(trpc.claude.status)`
- Conditional render of SessionView

- [ ] **Step 2: Migrate to MobX**

Replace all query/mutation hooks:
```typescript
const cardStore = useCardStore()
const projectStore = useProjectStore()
const sessionStore = useSessionStore()

// Card data — reactive via observer()
const card = cardStore.getCard(cardId)
const projects = projectStore.all

// Mutations → store actions
const handleSave = () => cardStore.updateCard(cardId, draft)
const handleDelete = () => cardStore.deleteCard(cardId)
const handleMove = (col: string) => cardStore.moveCard(cardId, col, 0)
const handleGenerateTitle = () => cardStore.generateTitle(cardId)

// Session status — from session store
const session = sessionStore.getSession(cardId)
```

Also migrate `NewCardDetail` (card creation form).

- [ ] **Step 3: Commit**

```bash
git add app/components/CardDetail.tsx
git commit -m "feat: migrate CardDetail to MobX store actions"
```

---

## Chunk 6: Claude Session Streaming

### Task 6.1: Server-side Claude WS handlers

**Files:**
- Create: `src/server/ws/handlers/claude.ts`
- Modify: `src/server/ws/handlers.ts`
- Modify: `src/server/claude/manager.ts`

- [ ] **Step 1: Read existing claude.ts router and manager.ts**

Understand the full flow:
- `claude.ts` start mutation: creates session, registers 'message' and 'exit' handlers, waits for init
- `claude.ts` sendMessage: recreates session if needed (after server restart), sends message
- `claude.ts` onMessage subscription: yields tracked messages from buffer + live
- `manager.ts`: EventEmitter managing sessions by cardId

- [ ] **Step 2: Create Claude WS handlers**

```typescript
// src/server/ws/handlers/claude.ts
import type { WebSocket } from 'ws'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import type { ClientMessage } from '../../../shared/ws-protocol'
import { sessionManager } from '../../claude/manager'
import { db } from '../../db'
import { cards, projects } from '../../db/schema'
import { eq } from 'drizzle-orm'

export async function handleClaudeStart(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'claude:start' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    const { cardId, prompt } = msg.data
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!card) throw new Error(`Card ${cardId} not found`)
    if (!card.worktreePath) throw new Error(`Card ${cardId} has no working directory`)

    let projectName: string | undefined
    if (card.projectId) {
      const proj = db.select({ name: projects.name }).from(projects).where(eq(projects.id, card.projectId)).get()
      if (proj) projectName = proj.name.toLowerCase()
    }

    const isResume = !!card.sessionId
    const session = sessionManager.create(
      cardId, card.worktreePath, card.sessionId ?? undefined,
      projectName, card.model, card.thinkingLevel,
    )

    // Register event handlers — use mutator for DB writes (triggers broadcasts)
    session.on('message', (m: Record<string, unknown>) => {
      // Push message to WS client
      connections.send(ws, {
        type: 'claude:message', cardId,
        data: m as any,
      })
      // On result, persist counters via mutator
      if (m.type === 'result') {
        mutator.updateCard(cardId, {
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      }
    })

    session.on('exit', () => {
      if (session.status === 'completed' || session.status === 'errored') {
        mutator.moveCard(cardId, 'review', card.position)
        mutator.updateCard(cardId, {
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      }
      connections.send(ws, {
        type: 'claude:status',
        data: {
          cardId, active: false, status: session.status,
          sessionId: session.sessionId, promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        },
      })
    })

    session.promptsSent++
    await session.start(prompt)

    // Wait for session init (sessionId assigned)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out')), 30_000)
      const check = () => {
        if (session.sessionId) { clearTimeout(timeout); session.off('message', check); resolve() }
      }
      session.on('message', check)
      session.on('exit', () => { clearTimeout(timeout); session.off('message', check); reject(new Error('Session exited')) })
    })

    // For fresh sessions, store sessionId and reset counters.
    // This runs AFTER waitForInit, so the 'result' handler from the first turn
    // may or may not have fired yet. Since we set promptsSent=1 and turnsCompleted=0
    // here, any subsequent 'result' handler will overwrite with session's actual
    // counters (which are always >= these values). No data loss possible.
    if (!isResume) {
      mutator.updateCard(cardId, {
        sessionId: session.sessionId,
        promptsSent: 1,
        turnsCompleted: 0,
      })
    }

    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId, active: true, status: 'running',
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: { status: 'started' } })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

// CRITICAL: Before implementing handleClaudeSend, you MUST read src/server/routers/claude.ts
// lines 114-194 in full. The sendMessage logic is complex:
// 1. If no in-memory session, recreate from DB (session recreation after server restart)
// 2. Re-register 'message' and 'exit' event handlers on recreated session
// 3. Refresh model/thinkingLevel from DB
// 4. Validate file paths are within /tmp/dispatcher-uploads/
// 5. Build augmented prompt with file list
// 6. Call session.sendUserMessage()
// 7. Persist promptsSent via mutator
// Port ALL of this logic faithfully.
export async function handleClaudeSend(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'claude:send' }>,
  connections: ConnectionManager, mutator: DbMutator,
) {
  try {
    // Port FULL sendMessage logic from claude.ts (lines 114-194)
    // See the CRITICAL note above — do not skip the session recreation path
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: { status: 'sent' } })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export async function handleClaudeStop(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'claude:stop' }>,
  connections: ConnectionManager,
) {
  try {
    await sessionManager.kill(msg.data.cardId)
    connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: { status: 'stopped' } })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId: msg.requestId, error: String(err) })
  }
}

export function handleClaudeStatus(
  ws: WebSocket, msg: Extract<ClientMessage, { type: 'claude:status' }>,
  connections: ConnectionManager,
) {
  const session = sessionManager.get(msg.data.cardId)
  if (session) {
    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId: msg.data.cardId, active: session.status === 'running',
        status: session.status, sessionId: session.sessionId,
        promptsSent: session.promptsSent, turnsCompleted: session.turnsCompleted,
      },
    })
  } else {
    const [card] = db.select().from(cards).where(eq(cards.id, msg.data.cardId))
    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId: msg.data.cardId, active: false, status: 'completed',
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
      },
    })
  }
  connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId })
}
```

**Important:** The implementing agent MUST read `src/server/routers/claude.ts` in full and port ALL logic — especially the `sendMessage` session recreation path and file ref handling.

- [ ] **Step 3: Wire into main handler**

Add claude cases to `src/server/ws/handlers.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/handlers/claude.ts src/server/ws/handlers.ts
git commit -m "feat: Claude session WS handlers (start, send, stop, status)"
```

### Task 6.2: Migrate SessionView component

**Files:**
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Read SessionView.tsx (661 lines)**

Key things to understand:
- `useSubscription(trpc.claude.onMessage)` for live streaming
- `useQuery(trpc.sessions.loadSession)` for history
- `useQuery(trpc.claude.status)` with 3s polling
- `useMutation(trpc.claude.start)` and `useMutation(trpc.claude.sendMessage)`
- Message dedup via `seenIds` Set
- `useMemo` merging history + pendingPrompt + liveMessages
- File upload UI (POST /api/upload)
- Context gauge + status badge

- [ ] **Step 2: Migrate to MobX**

Replace the data layer while keeping the UI intact:

```typescript
import { observer } from 'mobx-react-lite'
import { useSessionStore, useCardStore, useStore } from '../stores/context'

export default observer(function SessionView({ cardId }: { cardId: number }) {
  const sessionStore = useSessionStore()
  const cardStore = useCardStore()
  const store = useStore()
  const card = cardStore.getCard(cardId)
  const session = sessionStore.getSession(cardId)

  // Load history when card has sessionId
  useEffect(() => {
    if (card?.sessionId) {
      sessionStore.loadHistory(card.sessionId, cardId)
    }
  }, [card?.sessionId])

  // Request status on mount
  useEffect(() => {
    sessionStore.requestStatus(cardId)
  }, [cardId])

  // Merged messages: history + live
  const messages = useMemo(() => [
    ...(session?.history ?? []),
    ...(session?.liveMessages ?? []),
  ], [session?.history, session?.liveMessages])

  // Start session
  const handleStart = async (prompt: string) => {
    await sessionStore.startSession(cardId, prompt)
  }

  // Send message
  const handleSend = async (message: string, files?: unknown[]) => {
    await sessionStore.sendMessage(cardId, message, files as any)
  }

  // Stop session
  const handleStop = () => sessionStore.stopSession(cardId)

  // Keep: file upload (POST /api/upload), UI components, auto-scroll, context gauge
  // ...
})
```

- [ ] **Step 3: Verify streaming works**

Start a Claude session on a card, verify messages stream in real-time through WS.

- [ ] **Step 4: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: migrate SessionView to MobX + WS streaming"
```

---

## Chunk 7: REST API

### Task 7.1: External REST API with Hono

**Files:**
- Create: `src/server/api/rest.ts`
- Modify: `vite.config.ts` (or `src/server/ws/server.ts` to mount)

- [ ] **Step 1: Create REST routes**

```typescript
// src/server/api/rest.ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { cardCreateSchema, cardUpdateSchema, cardMoveSchema } from '../../shared/ws-protocol'
import type { DbMutator } from '../db/mutator'

export function createRestApi(mutator: DbMutator) {
  const app = new Hono()

  app.post('/api/cards', zValidator('json', cardCreateSchema), (c) => {
    const data = c.req.valid('json')
    const card = mutator.createCard(data)
    return c.json(card, 201)
  })

  app.patch('/api/cards/:id', zValidator('json', cardUpdateSchema.omit({ id: true })), (c) => {
    const id = Number(c.req.param('id'))
    const data = c.req.valid('json')
    const card = mutator.updateCard(id, data)
    return c.json(card)
  })

  app.post('/api/cards/:id/move', zValidator('json', cardMoveSchema.omit({ id: true })), (c) => {
    const id = Number(c.req.param('id'))
    const data = c.req.valid('json')
    const card = mutator.moveCard(id, data.column, data.position)
    return c.json(card)
  })

  app.delete('/api/cards/:id', (c) => {
    const id = Number(c.req.param('id'))
    mutator.deleteCard(id)
    return c.json({ ok: true })
  })

  return app
}
```

- [ ] **Step 2: Mount in Vite plugin**

Use `@hono/node-server`'s `getRequestListener` to convert Hono's fetch-based handler to a Node.js middleware. Add to the `wsServerPlugin` in `src/server/ws/server.ts`:

```typescript
import { getRequestListener } from '@hono/node-server'
import { createRestApi } from '../api/rest'

// In configureServer:
const restApp = createRestApi(mutator)
const restHandler = getRequestListener(restApp.fetch)

server.middlewares.use((req, res, next) => {
  if (req.url?.startsWith('/api/cards') || req.url?.startsWith('/api/docs')) {
    restHandler(req, res)
  } else {
    next()
  }
})
```

**Note:** This project runs `pnpm dev` in production (systemd service runs Vite dev server). The WS server and REST API are both mounted via the Vite plugin, which IS the production entry point. If the project ever moves to a production build (`pnpm build` + express), the `createWsServer()` and REST middleware must be wired into the express server entry point as well.

- [ ] **Step 3: Test REST endpoint**

```bash
curl -X POST http://192.168.4.200:6194/api/cards \
  -H 'Content-Type: application/json' \
  -d '{"title":"Test from API","column":"backlog"}'
```

Verify: card appears in the board (WS broadcast triggers UI update).

- [ ] **Step 4: Commit**

```bash
git add src/server/api/rest.ts src/server/ws/server.ts
git commit -m "feat: REST API for external card management"
```

---

## Chunk 8: Cleanup and Final Verification

### Task 8.1: Remove tRPC + React Query

**Files:**
- Delete: `src/server/trpc.ts`
- Delete: `src/server/routers/index.ts`
- Delete: `src/server/routers/cards.ts`
- Delete: `src/server/routers/projects.ts`
- Delete: `src/server/routers/sessions.ts`
- Delete: `src/server/routers/claude.ts`
- Delete: `app/lib/trpc.ts`
- Delete: `app/lib/query-persist.ts`
- Delete: `app/routes/api.trpc.$.ts`
- Modify: `package.json`

- [ ] **Step 1: Delete old files**

```bash
rm src/server/trpc.ts
rm -r src/server/routers/
rm app/lib/trpc.ts
rm app/lib/query-persist.ts
rm app/routes/api.trpc.$.ts
```

- [ ] **Step 2: Remove unused dependencies**

```bash
pnpm remove @trpc/client @trpc/server @trpc/react-query @tanstack/react-query @tanstack/react-query-persist-client
```

- [ ] **Step 3: Verify no remaining imports**

```bash
grep -r "from.*trpc" app/ src/ --include="*.ts" --include="*.tsx" || echo "Clean"
grep -r "from.*@tanstack/react-query" app/ src/ --include="*.ts" --include="*.tsx" || echo "Clean"
```

- [ ] **Step 4: TypeScript compilation check**

```bash
npx tsc --noEmit
```

Fix any remaining type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove tRPC and React Query"
```

### Task 8.2: Full integration test

- [ ] **Step 1: Start dev server and verify all flows**

```bash
pnpm dev
```

Test checklist:
1. Board loads with cards from WS sync
2. Create a new card — appears instantly
3. Drag card between columns — optimistic + persists
4. Edit card details — saves via WS
5. Delete a card — disappears
6. Start Claude session — messages stream via WS
7. Send follow-up message — session continues
8. Stop session — card moves to review
9. Open archive — paginated load
10. Search — results appear from server
11. REST API: `curl -X POST /api/cards` — card appears in board instantly
12. Close and reopen browser — IDB cache loads, then WS sync corrects
13. Disconnect WiFi briefly — reconnects and re-syncs

- [ ] **Step 2: Fix any issues found**

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete MobX + WebSocket migration"
```

### Task 8.3: Merge worktree

- [ ] **Step 1: Verify all tests pass**

```bash
npx vitest run
```

- [ ] **Step 2: Merge into main**

Present options to user: merge directly, create PR, or squash merge. Follow user's preference.
