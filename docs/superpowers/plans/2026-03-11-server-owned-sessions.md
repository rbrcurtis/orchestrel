# Server-Owned Sessions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move session lifecycle ownership to the server, rename `in_progress` → `running`, and add verbose logging.

**Architecture:** `card:move` and `claude:start` are removed. `card:update` absorbs column-transition side effects (worktree setup/teardown, session auto-start). `claude:send` becomes the single "talk to a card" action — the server moves the card to `running` and calls `beginSession(card, message)`. A new `beginSession` function is the single entry point for all session creation/resumption.

**Tech Stack:** TypeScript, SQLite/Drizzle ORM, WebSocket, MobX, React, claude-agent-sdk

**Spec:** `docs/superpowers/specs/2026-03-11-server-owned-sessions-design.md`

---

## File Map

**Create:**
- `src/server/claude/begin-session.ts` — `beginSession(card, message?, ws, connections, mutator)` function

**Modify:**
- `src/server/db/schema.ts` — column enum: `in_progress` → `running`
- `src/shared/ws-protocol.ts` — column enum, remove `card:move`/`claude:start` types
- `src/server/db/mutator.ts` — remove `moveCard`, enhance `updateCard` with column-transition broadcast
- `src/server/ws/handlers/cards.ts` — absorb worktree/session logic from `handleCardMove` into `handleCardUpdate`, delete `handleCardMove`
- `src/server/ws/handlers/claude.ts` — rewrite `handleClaudeSend` to use `beginSession`, rewrite `handleClaudeStop` to move card to review, delete `handleClaudeStart`
- `src/server/ws/handlers.ts` — remove `card:move`/`claude:start` cases
- `src/server/claude/manager.ts` — fix race guard, add logging
- `src/server/claude/protocol.ts` — add logging
- `src/server/claude/types.ts` — add `stopped` status
- `app/stores/card-store.ts` — remove `moveCard()`, board uses `updateCard`
- `app/stores/session-store.ts` — remove `startSession()`
- `app/components/SessionView.tsx` — remove auto-start effect, prompt input always sends
- `app/components/CardDetail.tsx` — remove `autoStartPrompt`, update `in_progress` refs
- `app/components/StatusRow.tsx` — rename column
- `app/routes/board.index.tsx` — use `updateCard` for DnD, remove session start logic, rename column
- `app/routes/board.tsx` — rename column in subscribe
- `CLAUDE.md` — update lifecycle docs

---

## Chunk 1: Server-Side Changes

### Task 1: Rename `in_progress` → `running` in DB schema and protocol types

**Files:**
- Modify: `src/server/db/schema.ts:29` — column enum
- Modify: `src/shared/ws-protocol.ts:15` — columnEnum
- Modify: `src/shared/ws-protocol.ts:33-34` — add `position` to `cardUpdateSchema`
- Modify: `src/shared/ws-protocol.ts:35-39` — delete `cardMoveSchema`
- Modify: `src/shared/ws-protocol.ts:70-73` — delete `claudeStartSchema`
- Modify: `src/shared/ws-protocol.ts:102-128` — remove `card:move` and `claude:start` from `clientMessage`

- [ ] **Step 1: Update DB schema column enum**

In `src/server/db/schema.ts` line 29, change:
```typescript
column: text('column', { enum: ['backlog', 'ready', 'in_progress', 'review', 'done', 'archive'] }).notNull().default('backlog'),
```
to:
```typescript
column: text('column', { enum: ['backlog', 'ready', 'running', 'review', 'done', 'archive'] }).notNull().default('backlog'),
```

- [ ] **Step 2: Update ws-protocol column enum**

In `src/shared/ws-protocol.ts` line 15, change:
```typescript
export const columnEnum = z.enum(['backlog', 'ready', 'in_progress', 'review', 'done', 'archive'])
```
to:
```typescript
export const columnEnum = z.enum(['backlog', 'ready', 'running', 'review', 'done', 'archive'])
```

- [ ] **Step 3: Add `position` to `cardUpdateSchema`**

In `src/shared/ws-protocol.ts` line 33, change:
```typescript
export const cardUpdateSchema = z.object({ id: z.number() }).merge(cardCreateSchema.partial())
```
to:
```typescript
export const cardUpdateSchema = z.object({ id: z.number(), position: z.number().optional() }).merge(cardCreateSchema.partial())
```

This is needed because DnD card reordering (previously via `card:move`) now goes through `card:update` and must include `position`.

- [ ] **Step 4: Remove `cardMoveSchema`, `claudeStartSchema`, and their message types**

Delete `cardMoveSchema` (lines 35-39):
```typescript
export const cardMoveSchema = z.object({
  id: z.number(),
  column: columnEnum,
  position: z.number().optional(),
})
```

Delete `claudeStartSchema` (lines 70-73):
```typescript
export const claudeStartSchema = z.object({
  cardId: z.number(),
  prompt: z.string().min(1),
})
```

Remove from `clientMessage` discriminated union (lines 102-128):
```typescript
z.object({ type: z.literal('card:move'), requestId: z.string(), data: cardMoveSchema }),
```
and:
```typescript
z.object({ type: z.literal('claude:start'), requestId: z.string(), data: claudeStartSchema }),
```

- [ ] **Step 5: Update existing DB rows**

Run a SQL migration to rename existing `in_progress` values:
```bash
cd /home/ryan/Code/dispatcher && sqlite3 data/dispatcher.db "UPDATE cards SET column = 'running' WHERE column = 'in_progress';"
```

- [ ] **Step 6: Verify TypeScript compiles (expect errors in handlers — that's expected)**

```bash
cd /home/ryan/Code/dispatcher && npx tsc --noEmit 2>&1 | head -50
```

Expected: errors in handlers referencing removed types. These are fixed in subsequent tasks.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/schema.ts src/shared/ws-protocol.ts
git commit -m "refactor: rename in_progress → running, add position to cardUpdate, remove card:move and claude:start types"
```

---

### Task 2: Update `SessionStatus` type and `SessionManager` guard

**Files:**
- Modify: `src/server/claude/types.ts:1-2`
- Modify: `src/server/claude/manager.ts:9-26`

- [ ] **Step 1: Add `stopped` to SessionStatus**

In `src/server/claude/types.ts`, change:
```typescript
export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored';
```
to:
```typescript
export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped';
```

- [ ] **Step 2: Fix race guard and add logging in SessionManager**

In `src/server/claude/manager.ts`, replace the `create` method (lines 9-26):
```typescript
  create(
    cardId: number,
    cwd: string,
    resumeSessionId?: string,
    projectName?: string,
    model: 'sonnet' | 'opus' = 'sonnet',
    thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'high',
  ): ClaudeSession {
    const key = `card-${cardId}`;
    const existing = this.sessions.get(key);
    if (existing && existing.status === 'running') {
      throw new Error(`Session already running for card ${cardId}`);
    }
    const session = new ClaudeSession(cwd, resumeSessionId, projectName, model, thinkingLevel);
    this.sessions.set(key, session);
    this.emit('session', cardId, session);
    return session;
  }
```
with:
```typescript
  create(
    cardId: number,
    cwd: string,
    resumeSessionId?: string,
    projectName?: string,
    model: 'sonnet' | 'opus' = 'sonnet',
    thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'high',
  ): ClaudeSession {
    const key = `card-${cardId}`;
    const existing = this.sessions.get(key);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      console.log(`[session:${cardId}] blocked: session already ${existing.status}`);
      throw new Error(`Session already ${existing.status} for card ${cardId}`);
    }
    console.log(`[session:${cardId}] created, model=${model}, thinking=${thinkingLevel}, resume=${!!resumeSessionId}`);
    const session = new ClaudeSession(cwd, resumeSessionId, projectName, model, thinkingLevel);
    this.sessions.set(key, session);
    this.emit('session', cardId, session);
    return session;
  }
```

Also add logging to `kill`:
```typescript
  async kill(cardId: number): Promise<void> {
    const key = `card-${cardId}`;
    const session = this.sessions.get(key);
    if (session) {
      console.log(`[session:${cardId}] kill() called`);
      await session.kill();
      this.sessions.delete(key);
    }
  }
```

- [ ] **Step 3: Add logging to ClaudeSession in protocol.ts**

In `src/server/claude/protocol.ts`, add logging to:

`start` method (line 53):
```typescript
  async start(prompt: string): Promise<void> {
    console.log(`[session] start() called, cwd=${this.cwd}, prompt length=${prompt.length}`);
    const msg = { type: 'user', message: { role: 'user', content: prompt } };
    this.messages.push(msg);
    this.emit('message', msg);
    await this.runQuery(prompt, this.resumeSessionId);
  }
```

`handleMessage` method — after setting status to running (line 142):
```typescript
    if (msg.type === 'system' && typeof msg.session_id === 'string') {
      if (!this.sessionId && !this.resumeSessionId) {
        this.sessionId = msg.session_id;
      }
      this.status = 'running';
      console.log(`[session] status → running, sessionId=${this.sessionId ?? this.resumeSessionId}`);
    }
```

`consumeMessages` — at end of loop and in catch (lines 118-119, 126-127):
```typescript
      this.status = 'completed';
      console.log(`[session] completed normally, turns=${this.turnsCompleted}`);
      this.emit('exit', 0);
```
and:
```typescript
        console.error('[session] SDK query error:', err);
        this.status = 'errored';
```

`sendUserMessage` — at entry:
```typescript
  async sendUserMessage(content: string): Promise<void> {
    console.log(`[session] sendUserMessage, length=${content.length}, promptsSent=${this.promptsSent + 1}`);
    this.promptsSent++;
```

- [ ] **Step 4: Commit**

```bash
git add src/server/claude/types.ts src/server/claude/manager.ts src/server/claude/protocol.ts
git commit -m "fix: close session race guard, add verbose session logging"
```

---

### Task 3: Create `beginSession` function

**Files:**
- Create: `src/server/claude/begin-session.ts`

- [ ] **Step 1: Create the `beginSession` function**

Create `src/server/claude/begin-session.ts`:
```typescript
import type { WebSocket } from 'ws'
import { db } from '../db/index'
import { cards, projects } from '../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from './manager'
import type { ClaudeSession } from './protocol'
import type { ConnectionManager } from '../ws/connections'
import type { DbMutator } from '../db/mutator'
import type { SessionStatus } from './types'
import type { ClaudeMessage } from '../../shared/ws-protocol'
import {
  createWorktree,
  runSetupCommands,
  slugify,
  worktreeExists,
} from '../worktree'

function waitForInit(s: ClaudeSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000)
    const onMessage = () => {
      if (s.sessionId) {
        clearTimeout(timeout)
        s.off('message', onMessage)
        resolve()
      }
    }
    s.on('message', onMessage)
    s.on('exit', () => {
      clearTimeout(timeout)
      s.off('message', onMessage)
      reject(new Error('Session exited before init'))
    })
  })
}

function registerHandlers(
  session: ClaudeSession,
  cardId: number,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
) {
  session.on('message', async (msg: Record<string, unknown>) => {
    const knownTypes = new Set(['user', 'assistant', 'result', 'system'])
    if (!knownTypes.has(msg.type as string)) return

    const innerMsg = (msg.message && typeof msg.message === 'object')
      ? msg.message as Record<string, unknown>
      : msg
    const wrapped: ClaudeMessage = {
      type: msg.type as ClaudeMessage['type'],
      message: innerMsg,
      ...(msg.isSidechain !== undefined && { isSidechain: msg.isSidechain as boolean }),
      ...(msg.ts !== undefined && { ts: msg.ts as string }),
    }
    connections.send(ws, {
      type: 'claude:message',
      cardId,
      data: wrapped,
    })

    if (msg.type === 'result') {
      try {
        mutator.updateCard(cardId, {
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      } catch (err) {
        console.error(`[session:${cardId}] failed to persist counters:`, err)
      }
    }
  })

  session.on('exit', async () => {
    console.log(`[session:${cardId}] exit, status=${session.status}`)
    if (session.status !== 'completed' && session.status !== 'errored') return
    try {
      mutator.updateCard(cardId, {
        column: 'review',
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      })
    } catch (err) {
      console.error(`[session:${cardId}] failed to auto-move to review:`, err)
    }
    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId,
        active: false,
        status: session.status as SessionStatus,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  })
}

function ensureWorktree(card: {
  id: number
  projectId: number | null
  useWorktree: boolean
  worktreePath: string | null
  worktreeBranch: string | null
  sourceBranch: string | null
  title: string
}, mutator: DbMutator): string {
  if (card.worktreePath) return card.worktreePath

  if (!card.projectId) throw new Error(`Card ${card.id} has no project`)
  const proj = db.select().from(projects).where(eq(projects.id, card.projectId)).get()
  if (!proj) throw new Error(`Project ${card.projectId} not found`)

  if (!card.useWorktree) {
    mutator.updateCard(card.id, { worktreePath: proj.path })
    return proj.path
  }

  const slug = card.worktreeBranch || slugify(card.title)
  const wtPath = `${proj.path}/.worktrees/${slug}`
  const branch = slug
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined

  if (!worktreeExists(wtPath)) {
    console.log(`[session:${card.id}] worktree setup at ${wtPath}`)
    createWorktree(proj.path, wtPath, branch, source ?? undefined)
    if (proj.setupCommands) {
      runSetupCommands(wtPath, proj.setupCommands)
    }
  }

  mutator.updateCard(card.id, { worktreePath: wtPath, worktreeBranch: branch })
  return wtPath
}

export async function beginSession(
  cardId: number,
  message: string | undefined,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const card = db.select().from(cards).where(eq(cards.id, cardId)).get()
  if (!card) throw new Error(`Card ${cardId} not found`)
  if (!card.description) throw new Error(`Card ${cardId} has no description`)

  const existingSession = sessionManager.get(cardId)
  console.log(`[session:${cardId}] beginSession called, existingSession=${!!existingSession}, message=${!!message}`)

  if (existingSession) {
    // Existing session — send follow-up
    if (!message) throw new Error(`No message to send to existing session for card ${cardId}`)
    console.log(`[session:${cardId}] existing session, sending follow-up`)

    // Re-register handlers to current WS connection
    existingSession.removeAllListeners('message')
    existingSession.removeAllListeners('exit')
    registerHandlers(existingSession, cardId, ws, connections, mutator)

    // Refresh model/thinkingLevel from DB
    existingSession.model = card.model
    existingSession.thinkingLevel = card.thinkingLevel

    await existingSession.sendUserMessage(message)

    mutator.updateCard(cardId, { promptsSent: existingSession.promptsSent })

    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: card.sessionId,
        promptsSent: existingSession.promptsSent,
        turnsCompleted: existingSession.turnsCompleted,
      },
    })
  } else {
    // New session
    const prompt = message ? card.description + '\n' + message : card.description
    console.log(`[session:${cardId}] no session, creating. prompt length=${prompt.length}`)

    const cwd = ensureWorktree(card, mutator)

    let projectName: string | undefined
    if (card.projectId) {
      const proj = db.select({ name: projects.name }).from(projects).where(eq(projects.id, card.projectId)).get()
      if (proj) projectName = proj.name.toLowerCase()
    }

    const isResume = !!card.sessionId
    const session = sessionManager.create(
      cardId,
      cwd,
      card.sessionId ?? undefined,
      projectName,
      card.model,
      card.thinkingLevel,
    )

    // Restore counters from DB for resumed sessions (e.g. after server restart)
    if (isResume) {
      session.promptsSent = card.promptsSent ?? 0
      session.turnsCompleted = card.turnsCompleted ?? 0
    }

    registerHandlers(session, cardId, ws, connections, mutator)

    session.promptsSent++
    await session.start(prompt)
    await waitForInit(session)

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
        cardId,
        active: true,
        status: 'running',
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/claude/begin-session.ts
git commit -m "feat: add beginSession function — single entry point for session lifecycle"
```

---

### Task 4: Rewrite server handlers

**Files:**
- Modify: `src/server/ws/handlers/cards.ts` — absorb `handleCardMove` into `handleCardUpdate`, delete `handleCardMove`
- Modify: `src/server/ws/handlers/claude.ts` — delete `handleClaudeStart`, rewrite `handleClaudeSend` and `handleClaudeStop`
- Modify: `src/server/ws/handlers.ts` — remove `card:move` and `claude:start` cases, update imports
- Modify: `src/server/db/mutator.ts` — remove `moveCard`, enhance `updateCard`

- [ ] **Step 1: Enhance `updateCard` in mutator to handle column transitions**

In `src/server/db/mutator.ts`, replace the `updateCard` method (lines 36-46):
```typescript
  updateCard(id: number, data: Record<string, unknown>): Card {
    const updated = db.update(cards)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ ...data, updatedAt: new Date().toISOString() } as any)
      .where(eq(cards.id, id))
      .returning().get()
    this.connMgr.broadcast(
      { type: 'card:updated', data: updated as Card },
      (updated as Card).column,
    )
    return updated as Card
  }
```
with:
```typescript
  updateCard(id: number, data: Record<string, unknown>): Card {
    // If column is changing, fetch previous column for dual broadcast
    let prevCol: string | undefined
    if (data.column !== undefined) {
      const prev = db.select({ column: cards.column }).from(cards).where(eq(cards.id, id)).get()
      prevCol = prev?.column
      if (prevCol) {
        console.log(`[card:${id}] column ${prevCol} → ${data.column}`)
      }
    }

    const updated = db.update(cards)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ ...data, updatedAt: new Date().toISOString() } as any)
      .where(eq(cards.id, id))
      .returning().get()

    const newCol = (updated as Card).column
    const cols = prevCol && prevCol !== newCol ? [prevCol, newCol] : [newCol]
    this.connMgr.broadcast({ type: 'card:updated', data: updated as Card }, ...cols)
    return updated as Card
  }
```

Delete the `moveCard` method (lines 48-59) entirely.

- [ ] **Step 2: Rewrite `handleCardUpdate` to absorb move logic**

In `src/server/ws/handlers/cards.ts`, replace `handleCardUpdate` (lines 76-91) with:
```typescript
export async function handleCardUpdate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:update' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const { id, ...data } = msg.data
    const existing = db.select().from(cards).where(eq(cards.id, id)).get()
    if (!existing) throw new Error(`Card ${id} not found`)

    const movingToRunning = data.column === 'running' && existing.column !== 'running'

    // Validate: running requires non-empty title and description
    if (data.column === 'running') {
      const title = data.title ?? existing.title
      const desc = data.description !== undefined ? data.description : existing.description
      if (!title?.trim()) throw new Error('Title is required for running')
      if (!desc?.trim()) throw new Error('Description is required for running')
    }

    // Worktree setup when moving to running
    const updates: Record<string, unknown> = { ...data }
    if (movingToRunning && existing.projectId) {
      try {
        const proj = db.select().from(projects).where(eq(projects.id, existing.projectId)).get()
        if (proj) {
          if (!existing.useWorktree) {
            updates.worktreePath = proj.path
          } else {
            const slug = existing.worktreeBranch || slugify(existing.title)
            const wtPath = existing.worktreePath || `${proj.path}/.worktrees/${slug}`
            const branch = slug
            const source = existing.sourceBranch ?? proj.defaultBranch ?? undefined

            if (!worktreeExists(wtPath)) {
              createWorktree(proj.path, wtPath, branch, source ?? undefined)
              if (proj.setupCommands) {
                runSetupCommands(wtPath, proj.setupCommands)
              }
            }

            updates.worktreePath = wtPath
            updates.worktreeBranch = branch
          }
        }
      } catch (err) {
        console.error(`[card:${id}] failed to set up worktree:`, err)
      }
    }

    // Worktree removal when moving to archive
    if (
      data.column === 'archive' &&
      existing.column !== 'archive' &&
      existing.useWorktree &&
      existing.worktreePath &&
      existing.projectId
    ) {
      try {
        const proj = db.select().from(projects).where(eq(projects.id, existing.projectId)).get()
        if (proj && worktreeExists(existing.worktreePath)) {
          try {
            removeWorktree(proj.path, existing.worktreePath)
          } catch (err) {
            console.error(`[card:${id}] failed to remove worktree:`, err)
          }
        }
      } catch (err) {
        console.error(`[card:${id}] failed to clean up worktree:`, err)
      }
    }

    const card = mutator.updateCard(id, updates)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })

    // Auto-start session when moving to running
    if (movingToRunning) {
      beginSession(card.id, undefined, ws, connections, mutator).catch((err) => {
        console.error(`[session:${id}] auto-start failed:`, err)
        connections.send(ws, {
          type: 'claude:status',
          data: { cardId: id, active: false, status: 'errored', sessionId: null, promptsSent: 0, turnsCompleted: 0 },
        })
      })
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
```

Add imports at the top of `cards.ts`:
```typescript
import { beginSession } from '../../claude/begin-session'
```

Delete `handleCardMove` function entirely (lines 93-170).

- [ ] **Step 3: Also update `handleCardCreate` for running validation**

In `handleCardCreate` (lines 16-74), add validation after computing `col`:
```typescript
    const col = input.column ?? 'backlog'

    // Validate: running requires non-empty title and description
    if (col === 'running') {
      if (!input.title?.trim()) throw new Error('Title is required for running')
      if (!input.description?.trim()) throw new Error('Description is required for running')
    }
```

And change the existing `in_progress` check on line 38 to `running`:
```typescript
if (col === 'running') {
```

Also fire `beginSession` async at the end, after the card is created:
```typescript
    const card = mutator.createCard({ ...input, ...extra, column: col })
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })

    // Auto-start session when creating directly into running
    if (col === 'running') {
      beginSession(card.id, undefined, ws, connections, mutator).catch((err) => {
        console.error(`[session:${card.id}] auto-start on create failed:`, err)
      })
    }
```

Note: the `connections.send(ws, { type: 'mutation:ok' ...})` must come before `beginSession` since the response should not wait for session init.

- [ ] **Step 4: Rewrite claude handlers**

In `src/server/ws/handlers/claude.ts`:

Delete `handleClaudeStart` function entirely (lines 105-166).

Delete `waitForInit` and `registerHandlers` helper functions (lines 15-101) — these are now in `begin-session.ts`.

Rewrite `handleClaudeSend` (lines 170-250):
```typescript
import { db } from '../../db/index'
import { cards } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { beginSession } from '../../claude/begin-session'
import { resolve } from 'path'
import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { sessionManager } from '../../claude/manager'

export async function handleClaudeSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'claude:send' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId, message, files } } = msg
  console.log(`[session:${cardId}] claude:send received, message length=${message.length}, files=${files?.length ?? 0}`)

  try {
    // Move card to running (validates title/description, sets up worktree)
    const existing = db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!existing) throw new Error(`Card ${cardId} not found`)

    if (existing.column !== 'running') {
      // Validate
      if (!existing.title?.trim()) throw new Error('Title is required for running')
      if (!existing.description?.trim()) throw new Error('Description is required for running')

      mutator.updateCard(cardId, { column: 'running' })
    }

    // Handle file refs: validate paths, build augmented prompt
    let prompt = message
    if (files?.length) {
      for (const f of files) {
        if (!resolve(f.path).startsWith('/tmp/dispatcher-uploads/')) {
          throw new Error(`Invalid file path: ${f.path}`)
        }
      }
      const fileList = files
        .map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`)
        .join('\n')
      prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`
    }

    await beginSession(cardId, prompt, ws, connections, mutator)

    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[session:${cardId}] claude:send error:`, error)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
```

Rewrite `handleClaudeStop`:
```typescript
export async function handleClaudeStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'claude:stop' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId } } = msg
  console.log(`[session:${cardId}] claude:stop received`)

  try {
    await sessionManager.kill(cardId)
    mutator.updateCard(cardId, { column: 'review' })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[session:${cardId}] claude:stop error:`, error)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
```

Keep `handleClaudeStatus` as-is (it's read-only).

- [ ] **Step 5: Update handlers.ts router**

In `src/server/ws/handlers.ts`, update imports (lines 8-15 and 22-28):

Remove `handleCardMove` from the cards import:
```typescript
import {
  handleCardCreate,
  handleCardUpdate,
  handleCardDelete,
  handleCardGenerateTitle,
  handleCardSuggestTitle,
} from './handlers/cards'
```

Remove `handleClaudeStart` from the claude import:
```typescript
import {
  handleClaudeSend,
  handleClaudeStop,
  handleClaudeStatus,
} from './handlers/claude'
```

Remove the `card:move` case (line 112):
```typescript
    case 'card:move':
      void handleCardMove(ws, msg, connections, mutator)
      break
```

Remove the `claude:start` case (lines 148-150):
```typescript
    case 'claude:start':
      void handleClaudeStart(ws, msg, connections, mutator)
      break
```

- [ ] **Step 6: Verify TypeScript compiles (server side should pass now)**

```bash
cd /home/ryan/Code/dispatcher && npx tsc --noEmit 2>&1 | grep -v "app/" | head -30
```

Expected: no server-side errors. Client errors expected (fixed in Chunk 2).

- [ ] **Step 7: Commit**

```bash
git add src/server/ws/handlers/cards.ts src/server/ws/handlers/claude.ts src/server/ws/handlers.ts src/server/db/mutator.ts src/server/claude/begin-session.ts
git commit -m "feat: server-owned session lifecycle — beginSession, unified card:update, remove card:move and claude:start"
```

---

## Chunk 2: Client-Side Changes

### Task 5: Update client stores

**Files:**
- Modify: `app/stores/card-store.ts:119-136` — remove `moveCard`, DnD uses `updateCard`
- Modify: `app/stores/session-store.ts:214-231` — remove `startSession`

- [ ] **Step 1: Remove `moveCard` from CardStore**

In `app/stores/card-store.ts`, delete the entire `moveCard` method (lines 119-136).

- [ ] **Step 2: Remove `startSession` from SessionStore**

In `app/stores/session-store.ts`, delete the entire `startSession` method (lines 214-231).

- [ ] **Step 3: Commit**

```bash
git add app/stores/card-store.ts app/stores/session-store.ts
git commit -m "refactor: remove moveCard and startSession from client stores"
```

---

### Task 6: Update SessionView — remove auto-start, simplify prompt

**Files:**
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Remove `autoStartPrompt` prop and auto-start effect**

Remove `autoStartPrompt` from the Props type (line 16):
```typescript
type Props = {
  cardId: number;
  sessionId?: string | null;
  accentColor?: string | null;
  model: 'sonnet' | 'opus';
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
};
```

Remove `autoStartPrompt` from the destructured props (line 31):
```typescript
export const SessionView = observer(function SessionView({
  cardId,
  sessionId,
  accentColor,
  model,
  thinkingLevel,
}: Props) {
```

Delete the auto-start effect entirely (lines 136-146):
```typescript
  // Auto-start session when mounted with autoStartPrompt
  useEffect(() => {
    if (autoStartPrompt) {
      setIsStarting(true);
      setStartError(null);
      cardStore.moveCard({ id: cardId, column: 'in_progress', position: 0 });
      sessionStore.startSession(cardId, autoStartPrompt).catch((err) => {
        setStartError(err instanceof Error ? err.message : String(err));
        setIsStarting(false);
      });
    }
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps
```

Remove `cardStore` usage since no longer needed:
```typescript
  const sessionStore = useSessionStore();
```

(Delete the `const cardStore = useCardStore();` line and remove the import if unused.)

- [ ] **Step 2: Simplify `handleStart` and `handleSend` — both just send a message**

Replace `handleStart` (lines 170-180) with:
```typescript
  async function handleSend(message: string, files?: FileRef[]) {
    try {
      await sessionStore.sendMessage(cardId, message, files);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }
```

Delete the old `handleSend` (lines 182-185) — it's merged into the new one.

- [ ] **Step 3: Remove `handleStop` moveCard call**

Replace `handleStop` (lines 187-190) with:
```typescript
  async function handleStop() {
    await sessionStore.stopSession(cardId);
    setIsStarting(false);
  }
```

(This is the same — no change needed since it already doesn't call moveCard. Keep as-is.)

- [ ] **Step 4: Update PromptInput usage**

The `PromptInput` component no longer needs `onStart` — everything goes through `onSend`. Update the props passed to `PromptInput` (lines 283-293):
```typescript
      <PromptInput
        cardId={cardId}
        isRunning={isStreaming}
        hasSession={!!sessionId || sessionActive}
        isPending={isStarting}
        onSend={handleSend}
        sendPending={false}
        contextPercent={contextPercent}
        compacted={compacted}
      />
```

Update the `PromptInput` component to remove `onStart` prop and always call `onSend` on submit. In the `handleSubmit` function (lines 418-441), simplify:
```typescript
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;

    setUploadError(null);
    if (files.length > 0) {
      try {
        const refs = await uploadFiles(files);
        onSend(trimmed || 'Please review the attached files.', refs);
      } catch {
        setUploadError('Failed to upload files');
        return;
      }
    } else {
      onSend(trimmed);
    }
    updateText('');
    setFiles([]);
  }
```

Remove `onStart` from `PromptInput` props type and function signature.

- [ ] **Step 5: Remove `useCardStore` import if fully unused**

Check if `useCardStore` is still imported/used. If not, remove it.

- [ ] **Step 6: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "refactor: remove auto-start effect and startSession from SessionView"
```

---

### Task 7: Update CardDetail — remove autoStartPrompt, rename column refs

**Files:**
- Modify: `app/components/CardDetail.tsx`

- [ ] **Step 1: Remove `autoStartPrompt` computation and prop**

Delete lines 138-140:
```typescript
  const autoStartPrompt = col === 'in_progress' && !card.sessionId && card.projectId && card.description?.trim()
    ? card.description.trim()
    : undefined;
```

Update `hasSession` (line 136):
```typescript
  const hasSession = !!card.sessionId || col === 'running';
```

Update `SessionView` rendering — remove `autoStartPrompt` prop:
```typescript
  <SessionView
    cardId={card.id}
    sessionId={card.sessionId}
    accentColor={cardProject?.color}
    model={card.model ?? 'sonnet'}
    thinkingLevel={card.thinkingLevel ?? 'high'}
  />
```

- [ ] **Step 2: Rename all `in_progress` references to `running`**

Replace all `in_progress` string literals and references:
- Line 22: STATUSES array
- Line 26: displayNames — change key to `running`, value to `Running`
- Line 73: `card.column !== 'running'`
- Line 136: `col === 'running'`
- Line 152-153: `col === 'running'` (cursor-not-allowed for status select)
- Line 428: `selectedColumn === 'running'`

- [ ] **Step 3: Replace `moveCard` calls with `updateCard`**

`handleStatusChange` (around line 116) calls `cardStore.moveCard(...)`. Replace with `updateCard`:
```typescript
  async function handleStatusChange(newColumn: string) {
    await cardStore.updateCard({ id: card.id, column: newColumn as Column });
  }
```

Search for any other `moveCard` references in the file and replace with `updateCard`. The `position` field is not needed here — the server assigns position on column change.

- [ ] **Step 4: Commit**

```bash
git add app/components/CardDetail.tsx
git commit -m "refactor: remove autoStartPrompt, rename in_progress → running in CardDetail"
```

---

### Task 8: Update board routes and StatusRow

**Files:**
- Modify: `app/components/StatusRow.tsx:8-19`
- Modify: `app/routes/board.index.tsx`
- Modify: `app/routes/board.tsx:45`

- [ ] **Step 1: Update StatusRow**

In `app/components/StatusRow.tsx`, replace all `in_progress` with `running`:
```typescript
export type ColumnId = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'archive';

export const ALL_COLUMNS: ColumnId[] = ['backlog', 'ready', 'running', 'review', 'done', 'archive'];

const displayNames: Record<ColumnId, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  done: 'Done',
  archive: 'Archive',
};
```

- [ ] **Step 2: Update board.tsx subscription**

In `app/routes/board.tsx` line 45, change:
```typescript
    store.subscribe(['backlog', 'ready', 'in_progress', 'review', 'done']);
```
to:
```typescript
    store.subscribe(['backlog', 'ready', 'running', 'review', 'done']);
```

- [ ] **Step 3: Update board.index.tsx — rename columns, remove session start, use updateCard for DnD**

Replace all `in_progress` with `running` (lines 36, 96, 179, 228, 263).

In `handleDragEnd`, replace ALL `cardStore.moveCard(...)` calls with `cardStore.updateCard(...)`. There are two call sites:

1. Same-column reorder (around line 249):
```typescript
      cardStore.moveCard({ id: active.id as number, column: originalCol, position: newPosition });
```
2. Cross-column move (around line 256):
```typescript
      const movePromise = cardStore.moveCard({
        id: active.id as number,
        column: currentCol,
        position: newPosition,
      });
```

Both become `cardStore.updateCard(...)`:
```typescript
      // Same-column reorder
      cardStore.updateCard({ id: active.id as number, column: originalCol, position: newPosition });

      // Cross-column move
      const movePromise = cardStore.updateCard({
        id: active.id as number,
        column: currentCol,
        position: newPosition,
      });
```

Delete the auto-start block (lines 262-269):
```typescript
      // Auto-start Claude when dragging to in_progress
      if (currentCol === 'in_progress') {
        const card = columns[currentCol].find((c) => c.id === active.id);
        if (card && card.projectId && card.description?.trim() && !card.sessionId) {
          const { cardId, prompt } = { cardId: card.id, prompt: card.description.trim() };
          movePromise.then(() => sessionStore.startSession(cardId, prompt)).catch(() => {});
        }
      }
```

Remove `useSessionStore` import and usage if no longer needed.

Update the drag constraint — cards in `running` can't be moved (line 179):
```typescript
    if (activeCol === 'running') return;
```

And the snap-back guard (line 228):
```typescript
    if (originalCol === 'running') {
```

- [ ] **Step 4: Verify full TypeScript compilation passes**

```bash
cd /home/ryan/Code/dispatcher && npx tsc --noEmit
```

Expected: clean pass, no errors.

- [ ] **Step 5: Commit**

```bash
git add app/components/StatusRow.tsx app/routes/board.tsx app/routes/board.index.tsx
git commit -m "refactor: rename in_progress → running in client, remove client-side session start logic"
```

---

### Task 9: Update CLAUDE.md and clean up

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md lifecycle documentation**

In `CLAUDE.md`, update the "Key Architecture Decisions" section. Change:
```
- Card lifecycle: backlog → ready → in_progress (worktree created, Claude starts) → review (auto on session exit) → done
```
to:
```
- Card lifecycle: backlog → ready → running (worktree created, Claude starts via server-side beginSession) → review (auto on session exit/stop) → done
- Session lifecycle is server-owned: card:update to running or claude:send triggers beginSession(). Client never starts sessions directly.
```

- [ ] **Step 2: Verify the app runs**

```bash
cd /home/ryan/Code/dispatcher && sudo systemctl restart dispatcher && sleep 3 && journalctl -u dispatcher.service --since "1 minute ago" --no-pager | tail -20
```

Expected: app starts without errors.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with server-owned session lifecycle"
```
