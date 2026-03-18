# Task Queue Chaining Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize non-worktree cards in the same project so only one agent runs at a time, with automatic queue management and UI controls.

**Architecture:** New `queuePosition` column on cards. Queue assignment integrated into `registerAutoStart`. New `registerQueueManager` bus listener handles promotion/renumbering when cards leave `running`. New `queue:reorder` WS mutation. UI shows queue badge with popover for reorder.

**Tech Stack:** TypeScript, TypeORM, Zod, Vitest, React, shadcn/ui, dnd-kit

**Spec:** `docs/superpowers/specs/2026-03-18-task-queue-chaining-design.md`

---

## Chunk 1: Data Model + Server Logic

### Task 1: Add `queuePosition` column to Card entity and schema

**Files:**

- Modify: `src/server/models/Card.ts:74` (add column after `updatedAt`)
- Modify: `src/shared/ws-protocol.ts:28` (add to cardSchema)

- [ ] **Step 1: Add column to DB via sqlite3 CLI**

```bash
sqlite3 data/dispatcher.db "ALTER TABLE cards ADD COLUMN queue_position INTEGER DEFAULT NULL;"
```

- [ ] **Step 2: Add TypeORM column decorator to Card entity**

In `src/server/models/Card.ts`, add after line 74 (`updatedAt`):

```typescript
  @Column({ name: 'queue_position', type: 'integer', nullable: true, default: null })
  queuePosition!: number | null
```

- [ ] **Step 3: Add `queuePosition` to Zod cardSchema**

In `src/shared/ws-protocol.ts`, add after line 28 (`updatedAt`):

```typescript
  queuePosition: z.number().nullable(),
```

- [ ] **Step 4: Add `queue:reorder` to clientMessage union**

In `src/shared/ws-protocol.ts`, add a new entry to the `clientMessage` discriminated union (after the `card:suggestTitle` line, around line 165):

```typescript
  z.object({ type: z.literal('queue:reorder'), requestId: z.string(), cardId: z.number(), newPosition: z.number() }),
```

- [ ] **Step 5: Run existing tests to verify no breakage**

Run: `npx vitest run`
Expected: All existing tests pass. The new `queuePosition` field is nullable with a default, so existing card creation in tests should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/server/models/Card.ts src/shared/ws-protocol.ts
git commit -m "feat: add queuePosition column and WS protocol for task chaining"
```

---

### Task 2: Integrate queue assignment into `registerAutoStart`

**Files:**

- Modify: `src/server/controllers/oc.ts:122-157` (registerAutoStart)
- Test: `src/server/controllers/oc.test.ts`

- [ ] **Step 1: Write test — card with useWorktree=false gets queued when another non-worktree card is active**

In `src/server/controllers/oc.test.ts`, add a new describe block after the existing `registerAutoStart` tests:

```typescript
describe('OC controller: registerAutoStart queue assignment', () => {
  it('queues non-worktree card when conflict group has active card', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const proj = Project.create({
      name: 'Queue proj',
      path: '/tmp/q',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    // Active card — already in running with no queuePosition
    const active = Card.create({
      title: 'Active',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    // New card entering running
    const queued = Card.create({
      title: 'Queued',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await queued.save();

    bus.publish('board:changed', { card: queued, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    await queued.reload();
    expect(queued.queuePosition).toBe(1);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('does not queue non-worktree card when no conflict exists', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const proj = Project.create({
      name: 'Solo proj',
      path: '/tmp/s',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const card = Card.create({
      title: 'Solo',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    await card.reload();
    expect(card.queuePosition).toBeNull();
    expect(startMock).toHaveBeenCalledWith(card.id, undefined);
  });

  it('does not queue worktree cards even when conflict group exists', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const proj = Project.create({
      name: 'WT proj',
      path: '/tmp/wt',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    // Active non-worktree card
    const active = Card.create({
      title: 'Active NW',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    // Worktree card entering running — should NOT be queued
    const wtCard = Card.create({
      title: 'WT card',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await wtCard.save();

    bus.publish('board:changed', { card: wtCard, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    expect(startMock).toHaveBeenCalledWith(wtCard.id, undefined);
  });

  it('skips already-queued cards (queuePosition not null)', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const card = Card.create({
      title: 'Pre-queued',
      description: 'Test',
      column: 'running',
      position: 0,
      queuePosition: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    expect(startMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/controllers/oc.test.ts`
Expected: New tests fail (queuePosition not handled, cards not queued)

- [ ] **Step 3: Implement queue assignment in registerAutoStart**

Replace `registerAutoStart` in `src/server/controllers/oc.ts` (lines 122-158) with:

```typescript
export function registerAutoStart(bus: MessageBus = messageBus, starter: SessionStarter): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (newColumn !== 'running') return;
    if (oldColumn === 'running') return;

    // Skip already-queued cards (e.g. during startup re-attach scan)
    if (card.queuePosition != null) return;

    // Non-worktree cards: check conflict group before starting
    if (!card.useWorktree && card.projectId) {
      const conflictGroup = await Card.find({
        where: {
          column: 'running',
          projectId: card.projectId,
          useWorktree: false as unknown as boolean,
        },
      });
      // Other cards in the group (exclude self)
      const others = conflictGroup.filter((c) => c.id !== card.id);
      if (others.length > 0) {
        // Queue this card — find max existing position
        const maxPos = others.reduce((max, c) => Math.max(max, c.queuePosition ?? 0), 0);
        const fresh = await Card.findOneBy({ id: card.id });
        if (fresh) {
          fresh.queuePosition = maxPos + 1;
          fresh.updatedAt = new Date().toISOString();
          await fresh.save();
        }
        console.log(`[oc:auto-start] queued card ${card.id} at position ${maxPos + 1}`);
        return;
      }
    }

    // Card with existing session — try to attach if OC session is still alive
    if (card.sessionId) {
      try {
        const attached = await starter.attachSession(card.id);
        if (attached) {
          console.log(`[oc:auto-start] attached to live session for card ${card.id}`);
          return;
        }
        // Session not alive — clear stale sessionId and fall through to startSession
        const c = await Card.findOneBy({ id: card.id });
        if (c) {
          c.sessionId = null;
          c.updatedAt = new Date().toISOString();
          await c.save();
          console.log(`[oc:auto-start] cleared stale session for card ${card.id}, starting fresh`);
        }
      } catch (err) {
        console.error(`[oc:auto-start] attach failed for card ${card.id}:`, err);
      }
    }

    starter.startSession(card.id, undefined).catch((err) => {
      console.error(`[oc:auto-start] failed for card ${card.id}:`, err);
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/controllers/oc.test.ts`
Expected: All tests pass including new queue assignment tests

- [ ] **Step 5: Commit**

```bash
git add src/server/controllers/oc.ts src/server/controllers/oc.test.ts
git commit -m "feat: integrate queue assignment into registerAutoStart"
```

---

### Task 3: Add `registerQueueManager` for promotion and renumbering

**Files:**

- Modify: `src/server/controllers/oc.ts` (add new exported function after `registerAutoStart`)
- Test: `src/server/controllers/oc.test.ts`

- [ ] **Step 1: Write test — active card leaving running promotes next in queue**

In `src/server/controllers/oc.test.ts`, add:

```typescript
describe('OC controller: registerQueueManager', () => {
  it('promotes next card and decrements queue when active card leaves running', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerQueueManager } = await import('./oc');
    registerQueueManager(bus, { startSession: startMock });

    const proj = Project.create({
      name: 'Promo proj',
      path: '/tmp/promo',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    // Card that just left running (was active — queuePosition null)
    const departed = Card.create({
      title: 'Departed',
      description: 'Test',
      column: 'review',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await departed.save();

    // Next in line
    const next = Card.create({
      title: 'Next',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await next.save();

    // Third in line
    const third = Card.create({
      title: 'Third',
      description: 'Test',
      column: 'running',
      position: 2,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await third.save();

    bus.publish('board:changed', {
      card: departed,
      oldColumn: 'running',
      newColumn: 'review',
    });
    await new Promise((r) => setTimeout(r, 100));

    await next.reload();
    await third.reload();
    expect(next.queuePosition).toBeNull();
    expect(third.queuePosition).toBe(1);
    expect(startMock).toHaveBeenCalledWith(next.id);
  });

  it('renumbers queue when a queued card leaves running', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerQueueManager } = await import('./oc');
    registerQueueManager(bus, { startSession: startMock });

    const proj = Project.create({
      name: 'Renum proj',
      path: '/tmp/renum',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    // Active card stays
    const active = Card.create({
      title: 'Active',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    // Card being removed from queue (was position 1)
    const removed = Card.create({
      title: 'Removed',
      description: 'Test',
      column: 'ready',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await removed.save();

    // Card at position 2 should become 1
    const remaining = Card.create({
      title: 'Remaining',
      description: 'Test',
      column: 'running',
      position: 2,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await remaining.save();

    bus.publish('board:changed', {
      card: removed,
      oldColumn: 'running',
      newColumn: 'ready',
    });
    await new Promise((r) => setTimeout(r, 100));

    await remaining.reload();
    expect(remaining.queuePosition).toBe(1);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('does nothing for worktree cards leaving running', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerQueueManager } = await import('./oc');
    registerQueueManager(bus, { startSession: startMock });

    const card = Card.create({
      title: 'WT leaving',
      description: 'Test',
      column: 'review',
      position: 0,
      useWorktree: true,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', {
      card,
      oldColumn: 'running',
      newColumn: 'review',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(startMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/controllers/oc.test.ts`
Expected: Fails — `registerQueueManager` not exported

- [ ] **Step 3: Implement `registerQueueManager`**

In `src/server/controllers/oc.ts`, add after `registerAutoStart` (before `registerWorktreeCleanup`). Update the `SessionStarter` interface to add a standalone `startSession(cardId)` overload if needed, or add a new interface:

```typescript
interface QueueStarter {
  startSession(cardId: number): Promise<void>;
}

export function registerQueueManager(bus: MessageBus = messageBus, starter: QueueStarter): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (oldColumn !== 'running') return;
    if (newColumn === 'running') return;

    // Only handle non-worktree cards in a conflict group
    if (card.useWorktree || !card.projectId) return;

    const wasActive = card.queuePosition == null;
    const wasPosition = card.queuePosition;

    // Clear queuePosition on the departing card (invariant: non-running cards have null queuePosition)
    if (card.queuePosition != null) {
      const departing = await Card.findOneBy({ id: card.id });
      if (departing) {
        departing.queuePosition = null;
        departing.updatedAt = new Date().toISOString();
        await departing.save();
      }
    }

    // Find remaining queued cards in the same conflict group
    const queued = await Card.find({
      where: {
        column: 'running',
        projectId: card.projectId,
        useWorktree: false as unknown as boolean,
      },
      order: { queuePosition: 'ASC' },
    });

    if (queued.length === 0) return;

    if (wasActive) {
      // Promote the first queued card (position 1) to active
      const nextUp = queued.find((c) => c.queuePosition === 1);
      if (nextUp) {
        nextUp.queuePosition = null;
        nextUp.updatedAt = new Date().toISOString();
        await nextUp.save();

        // Decrement all remaining
        for (const c of queued) {
          if (c.id === nextUp.id) continue;
          if (c.queuePosition != null && c.queuePosition > 1) {
            c.queuePosition = c.queuePosition - 1;
            c.updatedAt = new Date().toISOString();
            await c.save();
          }
        }

        // Start session on promoted card
        starter.startSession(nextUp.id).catch((err) => {
          console.error(`[oc:queue] failed to start promoted card ${nextUp.id}:`, err);
        });
        console.log(`[oc:queue] promoted card ${nextUp.id} to active`);
      }
    } else if (wasPosition != null) {
      // A queued card left — decrement cards with higher positions
      for (const c of queued) {
        if (c.queuePosition != null && c.queuePosition > wasPosition) {
          c.queuePosition = c.queuePosition - 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      }
      console.log(`[oc:queue] renumbered queue after card at position ${wasPosition} left`);
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/controllers/oc.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server/controllers/oc.ts src/server/controllers/oc.test.ts
git commit -m "feat: add registerQueueManager for queue promotion and renumbering"
```

---

### Task 4: Add `queue:reorder` WS handler

**Files:**

- Create: `src/server/ws/handlers/queue.ts`
- Modify: `src/server/ws/handlers.ts:13,130` (import + case)

- [ ] **Step 1: Create the queue reorder handler**

Create `src/server/ws/handlers/queue.ts`:

```typescript
import type { WebSocket } from 'ws';
import type { ClientMessage } from '../../../shared/ws-protocol';
import type { ConnectionManager } from '../connections';
import { Card } from '../../models/Card';

export async function handleQueueReorder(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'queue:reorder' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, cardId, newPosition } = msg;
  try {
    const card = await Card.findOneBy({ id: cardId });
    if (!card || card.queuePosition == null) {
      connections.send(ws, { type: 'mutation:error', requestId, error: 'Card is not queued' });
      return;
    }
    if (!card.projectId) {
      connections.send(ws, { type: 'mutation:error', requestId, error: 'Card has no project' });
      return;
    }

    const oldPosition = card.queuePosition;

    // Get all queued cards in the conflict group (exclude active card which has null position)
    const queued = await Card.find({
      where: {
        column: 'running',
        projectId: card.projectId,
        useWorktree: false as unknown as boolean,
      },
    });
    const queuedOnly = queued.filter((c) => c.queuePosition != null);

    if (newPosition < 1 || newPosition > queuedOnly.length) {
      connections.send(ws, {
        type: 'mutation:error',
        requestId,
        error: `Position must be between 1 and ${queuedOnly.length}`,
      });
      return;
    }

    if (newPosition === oldPosition) {
      connections.send(ws, { type: 'mutation:ok', requestId });
      return;
    }

    // Reorder: shift cards in the affected range
    for (const c of queuedOnly) {
      if (c.id === cardId) continue;
      if (c.queuePosition == null) continue;

      if (newPosition < oldPosition) {
        // Moving forward: cards in [newPosition, oldPosition-1] increment by 1
        if (c.queuePosition >= newPosition && c.queuePosition < oldPosition) {
          c.queuePosition += 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      } else {
        // Moving backward: cards in [oldPosition+1, newPosition] decrement by 1
        if (c.queuePosition > oldPosition && c.queuePosition <= newPosition) {
          c.queuePosition -= 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      }
    }

    // Set the target card's new position
    card.queuePosition = newPosition;
    card.updatedAt = new Date().toISOString();
    await card.save();

    connections.send(ws, { type: 'mutation:ok', requestId });
  } catch (err) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: String(err instanceof Error ? err.message : err),
    });
  }
}
```

- [ ] **Step 2: Wire handler into `handlers.ts`**

In `src/server/ws/handlers.ts`, add import at line 13 (after agents import):

```typescript
import { handleQueueReorder } from './handlers/queue';
```

Add case in the switch statement (after line 137 — `card:delete` case — or wherever logical):

```typescript
    case 'queue:reorder':
      void handleQueueReorder(ws, msg, connections)
      break
```

- [ ] **Step 3: Run all tests to verify no breakage**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/handlers/queue.ts src/server/ws/handlers.ts
git commit -m "feat: add queue:reorder WS handler"
```

---

### Task 5: Wire `registerQueueManager` at startup

**Files:**

- Modify: `src/server/ws/server.ts` (where `registerAutoStart` and `registerWorktreeCleanup` are called)

- [ ] **Step 1: Find and update the startup wiring**

Look in `src/server/ws/server.ts` for where `registerAutoStart` and `registerWorktreeCleanup` are called. These are imported dynamically (per CLAUDE.md Vite dev server restart survival rules — state in dynamically imported modules persists across re-bundles). Add `registerQueueManager` to the same dynamic import.

Find the existing dynamic import of `registerAutoStart` and `registerWorktreeCleanup` (e.g., `const { registerAutoStart, registerWorktreeCleanup } = await import(...)`) and add `registerQueueManager`:

```typescript
const { registerAutoStart, registerQueueManager, registerWorktreeCleanup } = await import('../controllers/oc');
```

Add call next to `registerAutoStart`:

```typescript
registerQueueManager(messageBus, sessionService);
```

Note: `sessionService` already satisfies the `QueueStarter` interface since it has `startSession(cardId: number)`.

- [ ] **Step 2: Verify the dev server starts without errors**

Run: `npx vite` (or check the running dev server logs)
Expected: No import errors, server starts normally

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/server.ts
git commit -m "feat: wire registerQueueManager at startup"
```

---

## Chunk 2: UI Changes

### Task 6: Add queue badge to Card component

**Files:**

- Modify: `app/components/Card.tsx:17-22,48-71` (props interface + rendering)

- [ ] **Step 1: Add `queuePosition` to Card component props**

In `app/components/Card.tsx`, update the `CardProps` interface (line 17-22):

```typescript
interface CardProps {
  id: number;
  title: string;
  color?: string | null;
  queuePosition?: number | null;
  onClick?: (id: number) => void;
}
```

Update the destructuring at line 24:

```typescript
export function Card({ id, title, color, queuePosition, onClick }: CardProps) {
```

- [ ] **Step 2: Render queue badge**

In `app/components/Card.tsx`, add imports at the top:

```typescript
import { Badge } from '~/components/ui/badge';
```

Inside the card's inner `<div className="flex items-stretch gap-1">` (line 58), add the badge between the title `<p>` and the X `<button>` (between lines 59 and 60):

```typescript
          {queuePosition != null && (
            <Badge
              variant="secondary"
              className="shrink-0 self-center text-xs tabular-nums px-1.5 py-0 h-5 min-w-5 flex items-center justify-center"
            >
              {queuePosition}
            </Badge>
          )}
```

- [ ] **Step 3: Add `queuePosition` to both `CardItem` interfaces and pass through StatusRow**

Three changes needed:

**a)** In `app/routes/board.index.tsx`, add to the `CardItem` interface (after line 52, `createdAt`):

```typescript
  queuePosition?: number | null;
```

The `enrichCard` function at line 73 already spreads `...card`, so `queuePosition` will flow through from the store.

**b)** In `app/components/StatusRow.tsx`, add to the `CardItem` interface (after line 25, `color`):

```typescript
  queuePosition?: number | null;
```

**c)** In `app/components/StatusRow.tsx`, update the `<Card>` rendering at line 60:

```typescript
            <Card key={card.id} id={card.id} title={card.title} color={card.color} queuePosition={card.queuePosition} onClick={onCardClick} />
```

- [ ] **Step 4: Verify visually**

Start the dev server and navigate to `http://localhost:6194`. Create two cards for the same project with `useWorktree=false`. Move both to running. The first should show no badge, the second should show "1".

- [ ] **Step 5: Commit**

```bash
git add app/components/Card.tsx app/components/StatusRow.tsx app/routes/board.index.tsx
git commit -m "feat: add queue position badge to card component"
```

---

### Task 7: Add reorder popover to queue badge

**Files:**

- Modify: `app/components/Card.tsx` (wrap badge in Popover)

- [ ] **Step 1: Add popover imports**

In `app/components/Card.tsx`, add:

```typescript
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Input } from '~/components/ui/input';
```

- [ ] **Step 2: Add `reorderQueue` method to CardStore**

In `app/stores/card-store.ts`, add a new method to the `CardStore` class (after `suggestTitle` or at the end):

```typescript
  async reorderQueue(cardId: number, newPosition: number) {
    const requestId = uuid();
    await ws().mutate({ type: 'queue:reorder', requestId, cardId, newPosition });
  }
```

- [ ] **Step 3: Replace static badge with popover-wrapped badge**

Replace the queue badge JSX from Task 6 with:

```typescript
          {queuePosition != null && (
            <QueueBadge id={id} queuePosition={queuePosition} />
          )}
```

Add a small component below the Card component (before `CardOverlay`):

```typescript
function QueueBadge({ id, queuePosition }: { id: number; queuePosition: number }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(queuePosition));
  const cards = useCardStore();

  function handleSubmit() {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num !== queuePosition && num >= 1) {
      cards.reorderQueue(id, num);
    }
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setValue(String(queuePosition)); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 self-center"
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        >
          <Badge
            variant="secondary"
            className="text-xs tabular-nums px-1.5 py-0 h-5 min-w-5 flex items-center justify-center cursor-pointer hover:bg-secondary/80"
          >
            {queuePosition}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-28 p-2" align="end">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          onBlur={handleSubmit}
          className="h-7 text-center"
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Verify popover works**

Navigate to `http://localhost:6194`. With queued cards visible, click a queue badge number. Popover should appear with a number input. Change the number and press Enter — cards should reorder.

- [ ] **Step 5: Commit**

```bash
git add app/components/Card.tsx app/stores/card-store.ts
git commit -m "feat: add reorder popover to queue badge"
```

---

### Task 8: Update drag-and-drop blocking for queued cards

**Files:**

- Modify: `app/routes/board.index.tsx:178,227-232`

- [ ] **Step 1: Update `handleDragOver` to allow dragging queued cards**

In `app/routes/board.index.tsx`, line 178 currently has:

```typescript
if (activeCol === 'running') return;
```

Replace with:

```typescript
if (activeCol === 'running') {
  // Allow dragging queued cards (they have a queuePosition), block active cards
  const activeCard = Object.values(columns)
    .flat()
    .find((c) => c.id === active.id);
  if (!activeCard || activeCard.queuePosition == null) return;
}
```

- [ ] **Step 2: Update `handleDragEnd` to allow queued cards**

In `app/routes/board.index.tsx`, lines 227-232 currently have:

```typescript
// Snap back running cards — session is running, moves not allowed
if (originalCol === 'running') {
  setDragOverride(null);
  setActiveId(null);
  snapshotRef.current = null;
  return;
}
```

Replace with:

```typescript
// Snap back active running cards — session is running, moves not allowed
// Queued cards (queuePosition != null) can be moved freely
if (originalCol === 'running') {
  const draggedCard = snapshotRef.current
    ? Object.values(snapshotRef.current)
        .flat()
        .find((c) => c.id === active.id)
    : Object.values(columns)
        .flat()
        .find((c) => c.id === active.id);
  if (!draggedCard || draggedCard.queuePosition == null) {
    setDragOverride(null);
    setActiveId(null);
    snapshotRef.current = null;
    return;
  }
}
```

- [ ] **Step 3: Verify `CardItem` interface includes `queuePosition`**

Check the `CardItem` interface at the top of `board.index.tsx` (around line 38-54). Ensure it includes `queuePosition`. If it maps from the store's card type, it should already pick it up. If it's manually defined, add:

```typescript
queuePosition?: number | null;
```

- [ ] **Step 4: Verify dragging behavior**

On `http://localhost:6194`:

- Active running card (no queue badge): cannot be dragged to another column ✓
- Queued running card (has queue badge): CAN be dragged to another column ✓
- Dragging queued card out triggers renumbering ✓

- [ ] **Step 5: Commit**

```bash
git add app/routes/board.index.tsx
git commit -m "feat: allow dragging queued cards out of running column"
```

---

### Task 9: Update CardDetail column dropdown blocking

**Files:**

- Modify: `app/components/CardDetail.tsx:190,205,209`

- [ ] **Step 1: Update blocking condition**

In `app/components/CardDetail.tsx`, the current blocking uses `sessionActive` (line 190):

```typescript
const sessionActive = sessionStore.getSession(cardId)?.active ?? false;
```

This already works correctly for queued cards — queued cards have no session, so `sessionActive` is `false`, and the dropdown is interactive. No change needed to this line.

**Verify** by reading lines 204-210: the `sessionActive` flag controls `cursor-not-allowed` and `pointer-events-none`. Since queued cards have no active session, the dropdown is already unblocked.

- [ ] **Step 2: Verify behavior**

On `http://localhost:6194`:

- Open an active running card's detail → column dropdown is disabled ✓
- Open a queued running card's detail → column dropdown works ✓
- Change queued card's column → it leaves running and queue renumbers ✓

- [ ] **Step 3: Commit (if any changes were needed)**

If no code changes were needed (just verification), skip this commit.

---

### Task 10: Final integration test

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Manual smoke test**

On `http://localhost:6194`:

1. Create a project with a repo path
2. Create 3 cards for that project, all with `useWorktree=false`
3. Move card A to running → it starts (no badge)
4. Move card B to running → badge shows "1"
5. Move card C to running → badge shows "2"
6. Click badge "2" on card C → popover appears, change to "1" → C becomes "1", B becomes "2"
7. Drag card B (badge "2") out of running to ready → C's badge changes from "1" to "1" (unchanged — it was already 1 after step 6... wait, if B was 2 and removed, C at 1 stays at 1 ✓)
8. Wait for card A to finish its turn → A moves to review, C (position 1) becomes active (badge disappears), no more queued cards
9. Create a card with `useWorktree=true` for the same project → move to running → starts immediately with no queueing

- [ ] **Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: integration fixes for task queue chaining"
```
