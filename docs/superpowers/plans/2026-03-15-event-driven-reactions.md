# Event-Driven Architecture Refactor

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace monolithic session closures and cross-domain side effects with independent event handlers wired by a controller, so each concern is handled in isolation.

**Architecture:** The OC session is already an EventEmitter (`message`, `exit`). Currently, `sessionService.startSession` wires one big closure per event that mixes content forwarding, counter persistence, and card column transitions. Instead, an **OC controller** registers multiple independent handlers on each session — one per concern. Card and worktree side effects move from `cardService` to domain-bus listeners registered at startup. Services only update their own models.

**Tech Stack:** TypeORM (existing), MessageBus (existing), Vitest (existing), OpenCodeSession EventEmitter (existing)

---

## File Structure

```
src/server/
  controllers/
    oc.ts          — OC controller: wires independent handlers on session events,
                     registers board:changed listener for auto-start
  services/
    session.ts     — Slimmed: session CRUD + prompt sending, no card mutations or closures
    card.ts        — Slimmed: card CRUD only, no session/worktree side effects
```

No new event emitters. The OC session emits, the controller listens, services update models, model lifecycle hooks publish to the domain bus, the client subscribes to the domain bus.

---

## Chunk 1: OC Controller

### Task 1: Create OC controller with independent session handlers

The OC controller has one public function: `wireSession(cardId, session)`. It registers independent `session.on(...)` handlers — one per concern. Each handler checks if the event is relevant and returns if not. No `else` chains, no handler blocks another.

**Files:**
- Create: `src/server/controllers/oc.ts`
- Test: `src/server/controllers/oc.test.ts`

- [ ] **Step 1: Write the tests**

  Create `src/server/controllers/oc.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
  import { EventEmitter } from 'events'
  import { DataSource } from 'typeorm'
  import { Card, CardSubscriber } from '../models/Card'
  import { Project, ProjectSubscriber } from '../models/Project'
  import { MessageBus } from '../bus'
  import type { AgentMessage } from '../agents/types'

  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Card, Project],
      subscribers: [CardSubscriber, ProjectSubscriber],
      synchronize: true,
    })
    await ds.initialize()
  })

  afterAll(async () => {
    await ds.destroy()
  })

  // Minimal fake session that mimics AgentSession's EventEmitter interface
  function fakeSession() {
    const session = new EventEmitter() as EventEmitter & {
      promptsSent: number
      turnsCompleted: number
      sessionId: string | null
      status: string
    }
    session.promptsSent = 1
    session.turnsCompleted = 1
    session.sessionId = 'test-session-123'
    session.status = 'running'
    return session
  }

  describe('OC controller: wireSession', () => {
    it('publishes displayable messages to the domain bus', async () => {
      const bus = new MessageBus()
      const handler = vi.fn()
      const session = fakeSession()

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Test', description: 'Test', column: 'running',
        position: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)
      bus.subscribe(`card:${card.id}:message`, handler)

      session.emit('message', {
        type: 'text', role: 'assistant', content: 'hello', timestamp: Date.now(),
      } satisfies AgentMessage)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0]).toMatchObject({ type: 'text', content: 'hello' })
    })

    it('does NOT publish non-display message types to bus', async () => {
      const bus = new MessageBus()
      const handler = vi.fn()
      const session = fakeSession()

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Test2', description: 'Test', column: 'running',
        position: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)
      bus.subscribe(`card:${card.id}:message`, handler)

      session.emit('message', {
        type: 'internal' as never, role: 'system', content: '', timestamp: Date.now(),
      })

      expect(handler).not.toHaveBeenCalled()
    })

    it('moves card to review on turn_end', async () => {
      const bus = new MessageBus()
      const session = fakeSession()

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Turn test', description: 'Test', column: 'running',
        position: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)

      session.emit('message', {
        type: 'turn_end', role: 'system', content: '', timestamp: Date.now(),
      } satisfies AgentMessage)

      await new Promise(r => setTimeout(r, 50))
      await card.reload()
      expect(card.column).toBe('review')
    })

    it('persists counters on turn_end', async () => {
      const bus = new MessageBus()
      const session = fakeSession()
      session.promptsSent = 3
      session.turnsCompleted = 2

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Counter test', description: 'Test', column: 'running',
        position: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)

      session.emit('message', {
        type: 'turn_end', role: 'system', content: '', timestamp: Date.now(),
      } satisfies AgentMessage)

      await new Promise(r => setTimeout(r, 50))
      await card.reload()
      expect(card.promptsSent).toBe(3)
      expect(card.turnsCompleted).toBe(2)
    })

    it('moves card to review on exit with errored status', async () => {
      const bus = new MessageBus()
      const session = fakeSession()
      session.status = 'errored'

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Exit test', description: 'Test', column: 'running',
        position: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)
      session.emit('exit')

      await new Promise(r => setTimeout(r, 50))
      await card.reload()
      expect(card.column).toBe('review')
    })

    it('does NOT move card on exit with completed status', async () => {
      const bus = new MessageBus()
      const session = fakeSession()
      session.status = 'completed'

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Completed exit', description: 'Test', column: 'running',
        position: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)
      session.emit('exit')

      await new Promise(r => setTimeout(r, 50))
      await card.reload()
      expect(card.column).toBe('running')
    })

    it('publishes exit status to bus', async () => {
      const bus = new MessageBus()
      const handler = vi.fn()
      const session = fakeSession()
      session.status = 'stopped'

      const { wireSession } = await import('./oc')
      const card = Card.create({
        title: 'Exit bus test', description: 'Test', column: 'running',
        position: 6, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      wireSession(card.id, session as never, bus)
      bus.subscribe(`card:${card.id}:exit`, handler)
      session.emit('exit')

      await new Promise(r => setTimeout(r, 50))
      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0]).toMatchObject({ cardId: card.id, status: 'stopped' })
    })
  })
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest --run src/server/controllers/oc.test.ts`
  Expected: FAIL — module `./oc` does not exist

- [ ] **Step 3: Implement oc.ts**

  Create `src/server/controllers/oc.ts`:

  ```typescript
  import { Card } from '../models/Card'
  import { messageBus, type MessageBus } from '../bus'
  import type { AgentSession, AgentMessage } from '../agents/types'

  const DISPLAY_TYPES = new Set([
    'user', 'text', 'tool_call', 'tool_result', 'tool_progress',
    'thinking', 'system', 'turn_end', 'error',
  ])

  /**
   * Wire independent event handlers on an OC session.
   * Each handler is a separate session.on() call — no handler blocks another.
   * The bus parameter defaults to the singleton for production; tests inject a fresh instance.
   */
  export function wireSession(cardId: number, session: AgentSession, bus: MessageBus = messageBus): void {
    // Handler: forward displayable content to domain bus
    session.on('message', (msg: AgentMessage) => {
      if (!DISPLAY_TYPES.has(msg.type)) return
      bus.publish(`card:${cardId}:message`, msg)
    })

    // Handler: persist counters + move card to review on turn_end
    // These MUST be in one handler to avoid a lost-update race (both would
    // load the same row, mutate different fields, and the last save wins).
    session.on('message', async (msg: AgentMessage) => {
      if (msg.type !== 'turn_end') return
      try {
        const card = await Card.findOneBy({ id: cardId })
        if (!card) return
        card.promptsSent = session.promptsSent
        card.turnsCompleted = session.turnsCompleted
        if (card.column === 'running') card.column = 'review'
        card.updatedAt = new Date().toISOString()
        await card.save()
      } catch (err) {
        console.error(`[oc:${cardId}] failed to handle turn_end:`, err)
      }
    })

    // Handler: move card to review on exit (errored/stopped only)
    session.on('exit', async () => {
      if (session.status === 'errored' || session.status === 'stopped') {
        try {
          const card = await Card.findOneBy({ id: cardId })
          if (card && card.column === 'running') {
            card.column = 'review'
            card.promptsSent = session.promptsSent
            card.turnsCompleted = session.turnsCompleted
            card.updatedAt = new Date().toISOString()
            await card.save()
          }
        } catch (err) {
          console.error(`[oc:${cardId}] failed to move card to review on exit:`, err)
        }
      }
    })

    // Handler: publish exit status to domain bus
    session.on('exit', () => {
      bus.publish(`card:${cardId}:exit`, {
        cardId,
        active: false,
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      })
    })
  }
  ```

  Note: the counter-persist and column-move logic for `turn_end` are combined into one handler because they mutate the same DB row. Splitting them into separate handlers would cause a lost-update race — both would load the card, mutate different fields, and the last `save()` would overwrite the other's changes. The "one handler per concern" pattern works well for handlers on *different* events, but two handlers writing to the same entity on the same event must be combined.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest --run src/server/controllers/oc.test.ts`
  Expected: all 7 tests pass

- [ ] **Step 5: Run all tests**

  Run: `npx vitest --run`
  Expected: all tests pass (new + existing)

- [ ] **Step 6: Commit**

  ```bash
  git add src/server/controllers/
  git commit -m "feat: add OC controller with independent session event handlers"
  ```

---

### Task 2: Wire OC controller into session creation and remove closures

Replace the monolithic closures in `sessionService.startSession` with a call to `wireSession`.

**Files:**
- Modify: `src/server/services/session.ts`

- [ ] **Step 1: Import wireSession**

  Add to the top of `session.ts`:

  ```typescript
  import { wireSession } from '../controllers/oc'
  ```

- [ ] **Step 2: Replace the closures with wireSession**

  In `startSession`, replace lines 154-198 (the two `session.on(...)` blocks) with:

  ```typescript
  wireSession(cardId, session)
  ```

  Also remove the `DISPLAY_TYPES` constant from `session.ts` (it's now in the controller).

- [ ] **Step 3: Remove stale card reference usage**

  The closures used to capture `card` from line 94. After removing them, verify that `card` is only used for:
  - Validation (lines 95-96)
  - Column mutation safety net (lines 98-103)
  - Prompt building (lines 106-119)
  - Worktree (line 123)
  - Session creation (lines 140-147)
  - Session ID persistence (lines 206-213)

  All of these happen before the session starts emitting events, so the `card` reference is fine for the setup phase. The controller does its own fresh `Card.findOneBy()` for each event.

- [ ] **Step 4: Run all tests**

  Run: `npx vitest --run`
  Expected: all tests pass

- [ ] **Step 5: Smoke test**

  1. Create a card in Running with a project and description
  2. Verify session starts and streams output
  3. Wait for turn_end — card should move to Review
  4. Send a follow-up — card should move back to Running
  5. Stop the session — card should move to Review

- [ ] **Step 6: Commit**

  ```bash
  git add src/server/services/session.ts
  git commit -m "refactor: replace session closures with wireSession controller"
  ```

---

## Chunk 2: Auto-Start + Card Service Cleanup

### Task 3: Move session auto-start to board:changed listener

Register a domain bus listener at startup that starts sessions when cards enter running. This replaces the inline auto-start in `cardService.createCard` and `cardService.updateCard`.

**Files:**
- Modify: `src/server/controllers/oc.ts` (add `registerAutoStart`)
- Modify: `src/server/ws/server.ts` (call `registerAutoStart` at startup)
- Test: `src/server/controllers/oc.test.ts` (add auto-start tests)

- [ ] **Step 1: Write the tests**

  Add to `src/server/controllers/oc.test.ts`:

  ```typescript
  describe('OC controller: registerAutoStart', () => {
    it('calls startSession when card enters running', async () => {
      const bus = new MessageBus()
      const startMock = vi.fn().mockResolvedValue(undefined)
      const { registerAutoStart } = await import('./oc')
      registerAutoStart(bus, { startSession: startMock })

      const card = Card.create({
        title: 'Auto test', description: 'Test', column: 'running',
        position: 20, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' })

      await new Promise(r => setTimeout(r, 50))
      expect(startMock).toHaveBeenCalledWith(card.id, undefined)
    })

    it('does NOT call startSession for other column transitions', async () => {
      const bus = new MessageBus()
      const startMock = vi.fn().mockResolvedValue(undefined)
      const { registerAutoStart } = await import('./oc')
      registerAutoStart(bus, { startSession: startMock })

      const card = Card.create({
        title: 'No start', description: 'Test', column: 'review',
        position: 21, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      bus.publish('board:changed', { card, oldColumn: 'running', newColumn: 'review' })

      await new Promise(r => setTimeout(r, 50))
      expect(startMock).not.toHaveBeenCalled()
    })

    it('does NOT call startSession when staying in running', async () => {
      const bus = new MessageBus()
      const startMock = vi.fn().mockResolvedValue(undefined)
      const { registerAutoStart } = await import('./oc')
      registerAutoStart(bus, { startSession: startMock })

      const card = Card.create({
        title: 'Same col', description: 'Test', column: 'running',
        position: 22, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      // This fires when a non-column field changes while in running
      bus.publish('board:changed', { card, oldColumn: 'running', newColumn: 'running' })

      await new Promise(r => setTimeout(r, 50))
      expect(startMock).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest --run src/server/controllers/oc.test.ts`
  Expected: FAIL — `registerAutoStart` not found

- [ ] **Step 3: Implement registerAutoStart**

  Add to `src/server/controllers/oc.ts`:

  ```typescript
  interface SessionStarter {
    startSession(cardId: number, message?: string): Promise<void>
  }

  export function registerAutoStart(bus: MessageBus = messageBus, starter: SessionStarter): void {
    bus.subscribe('board:changed', (payload) => {
      const { card, oldColumn, newColumn } = payload as {
        card: Card | null; oldColumn: string | null; newColumn: string | null
      }
      if (!card) return
      if (newColumn !== 'running') return
      if (oldColumn === 'running') return

      starter.startSession(card.id, undefined).catch(err => {
        console.error(`[oc:auto-start] failed for card ${card.id}:`, err)
      })
    })
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest --run src/server/controllers/oc.test.ts`
  Expected: all tests pass

- [ ] **Step 5: Wire registerAutoStart at server startup**

  In `src/server/ws/server.ts`, inside the `wsServerPlugin` `.then()` callback, after `await initDatabase()`:

  ```typescript
  const { registerAutoStart } = await import('../controllers/oc')
  const { sessionService } = await import('../services/session')
  registerAutoStart(undefined, sessionService)
  ```

- [ ] **Step 6: Run all tests**

  Run: `npx vitest --run`
  Expected: all tests pass

- [ ] **Step 7: Commit**

  ```bash
  git add src/server/controllers/oc.ts src/server/controllers/oc.test.ts src/server/ws/server.ts
  git commit -m "feat: add auto-start session on board:changed via OC controller"
  ```

---

### Task 4: Move worktree cleanup to board:changed listener

**Files:**
- Modify: `src/server/controllers/oc.ts` (add `registerWorktreeCleanup`)
- Test: `src/server/controllers/oc.test.ts`

- [ ] **Step 1: Write the test**

  Add to `src/server/controllers/oc.test.ts`:

  ```typescript
  describe('OC controller: registerWorktreeCleanup', () => {
    it('removes worktree when card with worktree moves to archive', async () => {
      const bus = new MessageBus()
      const removeMock = vi.fn()
      const existsMock = vi.fn().mockReturnValue(true)
      const { registerWorktreeCleanup } = await import('./oc')
      registerWorktreeCleanup(bus, { removeWorktree: removeMock, worktreeExists: existsMock })

      const proj = Project.create({
        name: 'WT Project', path: '/tmp/wt-proj',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await proj.save()

      const card = Card.create({
        title: 'WT card', description: 'Test', column: 'archive',
        position: 30, projectId: proj.id, useWorktree: true,
        worktreePath: '/tmp/wt-proj/.worktrees/slug',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      bus.publish('board:changed', { card, oldColumn: 'done', newColumn: 'archive' })

      await new Promise(r => setTimeout(r, 50))
      expect(removeMock).toHaveBeenCalledWith('/tmp/wt-proj', '/tmp/wt-proj/.worktrees/slug')
    })

    it('does NOT remove worktree when useWorktree is false', async () => {
      const bus = new MessageBus()
      const removeMock = vi.fn()
      const existsMock = vi.fn().mockReturnValue(true)
      const { registerWorktreeCleanup } = await import('./oc')
      registerWorktreeCleanup(bus, { removeWorktree: removeMock, worktreeExists: existsMock })

      const card = Card.create({
        title: 'No WT', description: 'Test', column: 'archive',
        position: 31, useWorktree: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      await card.save()

      bus.publish('board:changed', { card, oldColumn: 'done', newColumn: 'archive' })

      await new Promise(r => setTimeout(r, 50))
      expect(removeMock).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Implement registerWorktreeCleanup**

  Add to `src/server/controllers/oc.ts`:

  ```typescript
  import { Project } from '../models/Project'

  interface WorktreeOps {
    removeWorktree(repoPath: string, worktreePath: string): void
    worktreeExists(worktreePath: string): boolean
  }

  export function registerWorktreeCleanup(bus: MessageBus = messageBus, ops: WorktreeOps): void {
    bus.subscribe('board:changed', async (payload) => {
      const { card, oldColumn, newColumn } = payload as {
        card: Card | null; oldColumn: string | null; newColumn: string | null
      }
      if (!card) return
      if (newColumn !== 'archive' || oldColumn === 'archive') return

      const c = card as Card
      if (!c.useWorktree || !c.worktreePath || !c.projectId) return

      try {
        const proj = await Project.findOneBy({ id: c.projectId })
        if (!proj || !ops.worktreeExists(c.worktreePath)) return
        ops.removeWorktree(proj.path, c.worktreePath)
        console.log(`[oc:worktree] removed ${c.worktreePath}`)
      } catch (err) {
        console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err)
      }
    })
  }
  ```

- [ ] **Step 3: Wire at startup**

  In `src/server/ws/server.ts`, alongside `registerAutoStart`:

  ```typescript
  const { registerAutoStart, registerWorktreeCleanup } = await import('../controllers/oc')
  const { removeWorktree, worktreeExists } = await import('../worktree')
  registerWorktreeCleanup(undefined, { removeWorktree, worktreeExists })
  ```

- [ ] **Step 4: Run all tests**

  Run: `npx vitest --run`
  Expected: all tests pass

- [ ] **Step 5: Commit**

  ```bash
  git add src/server/controllers/ src/server/ws/server.ts
  git commit -m "feat: add worktree cleanup on archive via OC controller"
  ```

---

### Task 5: Clean up cardService

Remove all cross-domain side effects from `cardService`. After this, `card.ts` is pure card CRUD.

**Files:**
- Modify: `src/server/services/card.ts`

- [ ] **Step 1: Remove auto-start from createCard**

  Delete lines 67-72 (the `if (col === 'running') { import('./session')... }` block).

- [ ] **Step 2: Remove auto-start from updateCard**

  Delete lines 107-111 (the `if (movingToRunning) { import('./session')... }` block).

- [ ] **Step 3: Remove worktree cleanup from updateCard**

  Delete lines 90-100 (the `if (movingToArchive && card.useWorktree...) { ... removeWorktree... }` block).

- [ ] **Step 4: Remove running-column validation from updateCard**

  Delete lines 83-88 (the `if (data.column === 'running') { ... }` validation block). This validation belongs in the session domain — `startSession` already validates title/description.

- [ ] **Step 5: Clean up unused variables and imports**

  Remove: `movingToRunning`, `movingToArchive` variables. Remove imports of `removeWorktree`, `worktreeExists` from `../worktree` and `Project` from `../models/Project` — if no longer used by remaining code.

- [ ] **Step 6: Run all tests**

  Run: `npx vitest --run`
  Expected: all tests pass. Update `card.test.ts` if any tests assert on removed behavior (session auto-start, running validation).

- [ ] **Step 7: Smoke test**

  1. Create card directly in Running — verify session auto-starts (now via controller)
  2. Move a card from Ready to Running — verify session auto-starts
  3. Archive a card with a worktree — verify worktree is removed
  4. Turn completion → card moves to Review
  5. Stop session → card moves to Review

- [ ] **Step 8: Commit**

  ```bash
  git add src/server/services/card.ts src/server/services/card.test.ts
  git commit -m "refactor: remove cross-domain side effects from cardService"
  ```

---

## Chunk 3: Session Service Cleanup

### Task 6: Split follow-up from startSession

**Files:**
- Modify: `src/server/services/session.ts`
- Modify: `src/server/ws/handlers/agents.ts`

- [ ] **Step 1: Extract sendFollowUp method**

  Add to `SessionService`:

  ```typescript
  async sendFollowUp(cardId: number, message: string): Promise<void> {
    const session = sessionManager.get(cardId)
    if (!session) throw new Error(`No active session for card ${cardId}`)
    if (session.status !== 'running' && session.status !== 'completed') {
      throw new Error(`Session for card ${cardId} is ${session.status}, cannot send follow-up`)
    }

    if (session instanceof OpenCodeSession) {
      const card = await Card.findOneByOrFail({ id: cardId })
      session.updateModel(card.model, card.thinkingLevel)
    }

    await session.sendMessage(message)

    // Move back to running so the board reflects active work
    const card = await Card.findOneByOrFail({ id: cardId })
    card.promptsSent = session.promptsSent
    if (card.column !== 'running') card.column = 'running'
    card.updatedAt = new Date().toISOString()
    await card.save()
  }
  ```

- [ ] **Step 2: Simplify startSession**

  Remove the existing-session follow-up branch (lines 72-91). Replace with an idempotent guard:

  ```typescript
  async startSession(cardId: number, message?: string, files?: FileRef[]): Promise<void> {
    const existing = sessionManager.get(cardId)
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      console.log(`[session:${cardId}] session already active, skipping startSession`)
      return
    }

    const card = await Card.findOneByOrFail({ id: cardId })
    // ... rest unchanged
  ```

- [ ] **Step 3: Update handleAgentSend to route**

  Modify `src/server/ws/handlers/agents.ts`:

  ```typescript
  export async function handleAgentSend(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'agent:send' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data: { cardId, message, files } } = msg
    console.log(`[session:${cardId}] agent:send, len=${message.length}, files=${files?.length ?? 0}`)

    try {
      connections.send(ws, { type: 'mutation:ok', requestId })

      const { sessionManager } = await import('../../agents/manager')
      const existing = sessionManager.get(cardId)

      if (existing && (existing.status === 'running' || existing.status === 'completed')) {
        sessionService.sendFollowUp(cardId, message).catch(err => {
          console.error(`[session:${cardId}] sendFollowUp error:`, err)
        })
      } else {
        sessionService.startSession(cardId, message, files).catch(err => {
          const error = err instanceof Error ? err.message : String(err)
          console.error(`[session:${cardId}] startSession error:`, error)
          connections.send(ws, {
            type: 'agent:status',
            data: { cardId, active: false, status: 'errored', sessionId: null, promptsSent: 0, turnsCompleted: 0 },
          })
        })
      }
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }
  ```

- [ ] **Step 4: Run all tests**

  Run: `npx vitest --run`
  Expected: all tests pass

- [ ] **Step 5: Smoke test follow-up flow**

  1. Create card in Running, wait for turn completion
  2. Send a follow-up message
  3. Verify session resumes, card moves to Running, then back to Review on turn_end

- [ ] **Step 6: Commit**

  ```bash
  git add src/server/services/session.ts src/server/ws/handlers/agents.ts
  git commit -m "refactor: split sendFollowUp from startSession"
  ```

---

### Task 7: Final cleanup

**Files:**
- Modify: `src/server/services/session.ts` — add clarifying comment to column safety net
- Verify: all cross-domain mutations removed except safety nets

- [ ] **Step 1: Add clarifying comment to startSession column mutation**

  At lines 98-103 in `startSession`:

  ```typescript
  // Safety net: ensure card is in running. No-op when called via auto-start
  // (card is already running). Required when called from handleAgentSend for
  // cards in review — triggers board:changed so controller handlers subscribe.
  if (card.column !== 'running') {
    card.column = 'running'
    card.updatedAt = new Date().toISOString()
    await card.save()
  }
  ```

- [ ] **Step 2: Audit for remaining cross-domain concerns**

  Verify:
  - `card.ts` has NO imports of `./session`, `../worktree`, or `../models/Project` (unless needed for position computation)
  - `session.ts` has no `session.on('message')` or `session.on('exit')` closures — only `wireSession()` call
  - The `DISPLAY_TYPES` constant exists only in `controllers/oc.ts`, not duplicated in `session.ts`
  - The OC controller is wired at startup in `server.ts`

- [ ] **Step 3: Run full test suite**

  Run: `npx vitest --run`
  Expected: all tests pass

- [ ] **Step 4: Full smoke test**

  Run the full 14-step smoke test from reference_test_plan.md.

- [ ] **Step 5: Commit**

  ```bash
  git add -A
  git commit -m "chore: final cleanup of event-driven architecture refactor"
  ```

---

## Summary

| Before | After |
|--------|-------|
| One big `session.on('message')` closure with mixed concerns | Independent handlers: content forwarding, counter persistence, column transition |
| One big `session.on('exit')` closure | Independent handlers: column transition, bus publish |
| `cardService.createCard/updateCard` auto-starts sessions | `registerAutoStart` on `board:changed` in OC controller |
| `cardService.updateCard` removes worktrees on archive | `registerWorktreeCleanup` on `board:changed` in OC controller |
| `startSession` handles new + follow-up | Split into `startSession` + `sendFollowUp` |
| Session closures capture stale `card` reference | Controller handlers do fresh `Card.findOneBy()` each time |

## Out of Scope (Future Work)

- **Client-side optimistic session state** — `SessionStore.sendMessage` sets `active`/`status` optimistically
- **Client-side `hasSession`** derivation from column position
- **DnD running-column lock** — Client-side guard, acceptable
- **`handleSessionLoad` subscribe-after-history race** — Theoretical, low probability
