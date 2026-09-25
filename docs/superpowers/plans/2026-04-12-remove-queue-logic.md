# Remove Queue Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all queueing/serialization logic — non-worktree cards on the same project can now run simultaneously, no conflict groups, no queue positions.

**Architecture:** The queue system added a serialization layer (queue-gate) that prevented multiple non-worktree cards from running concurrently on the same git project. This plan removes that layer entirely: the Card model drops 3 columns, the queue-gate service and handler are deleted, auto-start logic starts all cards directly, and the UI removes QueueBadge and queue-based drag restrictions. The pin resolution algorithm simplifies from 3-tier ranking (review → active running → queued running) to 2-tier (review → running).

**Tech Stack:** TypeScript, TypeORM, Socket.IO, React, Zod, SQLite

---

### Task 1: Remove queue from shared protocol

**Files:**

- Modify: `src/shared/ws-protocol.ts:27` (remove queuePosition from cardSchema)
- Modify: `src/shared/ws-protocol.ts:202-203` (remove queue:reorder from ClientToServerEvents)

- [ ] **Step 1: Remove queuePosition from cardSchema**

In `src/shared/ws-protocol.ts`, remove line 27:

```typescript
  queuePosition: z.number().nullable(),
```

The schema becomes:

```typescript
export const cardSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  column: z.enum(['backlog', 'ready', 'running', 'review', 'done', 'archive']),
  position: z.number(),
  projectId: z.number().nullable(),
  prUrl: z.string().nullable(),
  sessionId: z.string().nullable(),
  worktreeBranch: z.string().nullable(),
  sourceBranch: z.enum(['main', 'dev']).nullable(),
  model: z.string(),
  provider: z.string(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
  contextTokens: z.number(),
  contextWindow: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

- [ ] **Step 2: Remove queue:reorder from ClientToServerEvents**

Remove lines 202-203:

```typescript
  // Queue
  'queue:reorder': (data: { cardId: number; newPosition: number }, ack: (res: AckResponse) => void) => void;
```

- [ ] **Step 3: Update ws-protocol tests**

In `src/shared/ws-protocol.test.ts`, remove `queuePosition: null` from all three test card fixtures (lines 26, 53, 80). The test fixtures should end with `updatedAt` as the last field.

- [ ] **Step 4: Run protocol tests**

Run: `cd /home/ryan/Code/orchestrel && npx vitest run src/shared/ws-protocol.test.ts`
Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ws-protocol.ts src/shared/ws-protocol.test.ts
git commit -m "chore: remove queuePosition from shared protocol and card schema"
```

---

### Task 2: Remove queue columns from Card model

**Files:**

- Modify: `src/server/models/Card.ts:78-85` (remove 3 column definitions)
- Modify: `src/server/models/Card.ts:94-131` (remove beforeUpdate queue logic)
- Modify: `src/server/models/Card.ts:148` (simplify afterUpdate condition)

- [ ] **Step 1: Remove column definitions**

In `src/server/models/Card.ts`, remove lines 78-85 (the three column definitions):

```typescript
  @Column({ name: 'queue_position', type: 'integer', nullable: true, default: null })
  queuePosition!: number | null;

  @Column({ name: 'pending_prompt', type: 'text', nullable: true, default: null })
  pendingPrompt!: string | null;

  @Column({ name: 'pending_files', type: 'text', nullable: true, default: null })
  pendingFiles!: string | null;
```

- [ ] **Step 2: Simplify beforeUpdate hook**

Replace the entire `beforeUpdate` method with just the sessionId change logging:

```typescript
  async beforeUpdate(event: UpdateEvent<Card>) {
    const card = event.entity as Card;
    const prev = event.databaseEntity as Card;
    if (prev?.sessionId && card.sessionId !== prev.sessionId) {
      console.log(`[card:${card.id}] sessionId changed: ${prev.sessionId} → ${card.sessionId}`);
    }
  }
```

This removes:

- The "conflict group" logic that assigned queuePosition when entering running (lines 101-124)
- The invariant that cleared queuePosition when leaving running (lines 126-131)

- [ ] **Step 3: Simplify afterUpdate condition**

Change line 148 from:

```typescript
    if (prev?.column !== card.column || prev?.queuePosition !== card.queuePosition) {
```

To:

```typescript
    if (prev?.column !== card.column) {
```

- [ ] **Step 4: Commit**

```bash
git add src/server/models/Card.ts
git commit -m "chore: remove queue columns and conflict-group logic from Card model"
```

---

### Task 3: Delete queue-gate service and queue WS handler

**Files:**

- Delete: `src/server/services/queue-gate.ts`
- Delete: `src/server/ws/handlers/queue.ts`

- [ ] **Step 1: Delete queue-gate.ts**

```bash
rm src/server/services/queue-gate.ts
```

- [ ] **Step 2: Delete queue handler**

```bash
rm src/server/ws/handlers/queue.ts
```

- [ ] **Step 3: Commit**

```bash
git add -u src/server/services/queue-gate.ts src/server/ws/handlers/queue.ts
git commit -m "chore: delete queue-gate service and queue reorder handler"
```

---

### Task 4: Simplify card-sessions controller

**Files:**

- Modify: `src/server/controllers/card-sessions.ts`

This is the biggest change. The controller currently routes non-worktree cards through `processQueue`. After this task, all cards start directly.

- [ ] **Step 1: Remove processQueue and Project imports**

Remove line 2 and line 5:

```typescript
import { Project } from '../models/Project';
```

```typescript
import { processQueue } from '../services/queue-gate';
```

`Project` was only used in the queue delegation paths (checking `proj?.isGitRepo` to decide whether to queue). `registerWorktreeCleanup` dynamically imports Project on its own, so this static import is now unused.

- [ ] **Step 2: Simplify handleSessionExit**

Replace lines 115-137 with:

```typescript
async function handleSessionExit(cardId: number): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });

  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  messageBus.publish(`card:${cardId}:exit`, {
    sessionId: card?.sessionId,
    status: 'completed',
  });
}
```

This removes the `processQueue` call that was promoting the next queued card after a session finished.

- [ ] **Step 3: Simplify registerAutoStart — card entered running**

Replace the `if (newColumn === 'running' && oldColumn !== 'running')` block (lines 149-201) with:

```typescript
// Card entered running
if (newColumn === 'running' && oldColumn !== 'running') {
  const initState = await import('../init-state');
  const client = initState.getOrcdClient();
  if (!client) return;

  const fullCard = await repo().findOneBy({ id: card.id });
  if (!fullCard) return;

  // Check if already active in orcd
  if (fullCard.sessionId && client.isActive(fullCard.sessionId)) return;

  console.log(
    `[oc:auto-start] card #${card.id} entered running ` +
      `(worktree=${!!card.worktreeBranch}, project=${card.projectId})`,
  );
  const { ensureWorktree } = await import('../sessions/worktree');
  const cwd = await ensureWorktree(fullCard);
  const prompt = fullCard.sessionId ? '' : (fullCard.description ?? '');
  fullCard.updatedAt = new Date().toISOString();
  await repo().save(fullCard);

  const sessionId = await client.create({
    prompt,
    cwd,
    provider: fullCard.provider,
    model: fullCard.model,
    sessionId: fullCard.sessionId ?? undefined,
    contextWindow: fullCard.contextWindow,
  });

  fullCard.sessionId = sessionId;
  fullCard.updatedAt = new Date().toISOString();
  await repo().save(fullCard);

  registerCardSession(fullCard.id, sessionId);
}
```

Key changes:

- Removed the `processQueue` delegation path for non-worktree + git-repo cards
- Removed `pendingPrompt`/`pendingFiles` references (use `description` directly for new sessions)
- All cards now start directly regardless of worktree status

- [ ] **Step 4: Simplify registerAutoStart — card left running**

Replace the `if (oldColumn === 'running' && newColumn !== 'running')` block (lines 203-223) with:

```typescript
// Card left running: cancel session
if (oldColumn === 'running' && newColumn !== 'running') {
  const initState = await import('../init-state');
  const client = initState.getOrcdClient();
  if (card.sessionId) {
    client?.cancel(card.sessionId);
  }
}
```

This removes the `processQueue` call that used to promote the next queued card after a card left running.

- [ ] **Step 5: Commit**

```bash
git add src/server/controllers/card-sessions.ts
git commit -m "chore: remove queue delegation from card-sessions, all cards start directly"
```

---

### Task 5: Clean up agents handler and WS registration

**Files:**

- Modify: `src/server/ws/handlers/agents.ts:106`
- Modify: `src/server/ws/handlers.ts:22,147`

- [ ] **Step 1: Simplify handleAgentStatus queue guard**

In `src/server/ws/handlers/agents.ts`, change line 106 from:

```typescript
    if (!active && card && card.column === 'running' && card.queuePosition == null) {
```

To:

```typescript
    if (!active && card && card.column === 'running') {
```

- [ ] **Step 2: Remove queue handler from WS registration**

In `src/server/ws/handlers.ts`:

Remove the import on line 22:

```typescript
import { handleQueueReorder } from './handlers/queue';
```

Remove the queue section (lines 146-147):

```typescript
// ── Queue ────────────────────────────────────────────────────────────────
socket.on('queue:reorder', (data, cb) => void handleQueueReorder(data, cb));
```

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/handlers/agents.ts src/server/ws/handlers.ts
git commit -m "chore: remove queue guard from agent status and queue WS handler registration"
```

---

### Task 6: Simplify frontend Card component

**Files:**

- Modify: `app/components/Card.tsx`

- [ ] **Step 1: Remove QueueBadge and queue-related code**

Remove unused imports. The final imports should be:

```typescript
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { useCardStore } from '~/stores/context';
```

Remove `Badge`, `Popover`, `PopoverContent`, `PopoverTrigger`, `Input` imports.

- [ ] **Step 2: Remove queuePosition from CardProps and Card function**

Change the interface and function signature:

```typescript
interface CardProps {
  id: number;
  title: string;
  color?: string | null;
  onClick?: (id: number) => void;
}

export function Card({ id, title, color, onClick }: CardProps) {
```

- [ ] **Step 3: Remove QueueBadge rendering from Card body**

Remove line 57:

```typescript
          {queuePosition != null && <QueueBadge id={id} queuePosition={queuePosition} />}
```

- [ ] **Step 4: Delete entire QueueBadge component**

Delete the `QueueBadge` function (lines 126-180).

- [ ] **Step 5: Commit**

```bash
git add app/components/Card.tsx
git commit -m "chore: remove QueueBadge component and queuePosition prop from Card"
```

---

### Task 7: Simplify remaining frontend files

**Files:**

- Modify: `app/components/SessionView.tsx:294,394,402`
- Modify: `app/components/StatusRow.tsx:42,83`
- Modify: `app/routes/board.index.tsx:58,198-209,267-284`
- Modify: `app/stores/card-store.ts:154-156`

- [ ] **Step 1: Simplify StatusBadge in SessionView.tsx**

In `app/components/SessionView.tsx`, change line 294 from:

```typescript
          <StatusBadge
            status={isStarting && sessionStatus !== 'running' ? 'starting' : sessionStatus}
            queuePosition={cardStore.getCard(cardId)?.queuePosition}
          />
```

To:

```typescript
          <StatusBadge
            status={isStarting && sessionStatus !== 'running' ? 'starting' : sessionStatus}
          />
```

Change the StatusBadge function signature (line 394) from:

```typescript
function StatusBadge({ status, queuePosition }: { status: string; queuePosition?: number | null }) {
```

To:

```typescript
function StatusBadge({ status }: { status: string }) {
```

Change line 402 from:

```typescript
label = queuePosition != null ? `Waiting...#${queuePosition}` : status === 'starting' ? 'Starting...' : 'Running';
```

To:

```typescript
label = status === 'starting' ? 'Starting...' : 'Running';
```

- [ ] **Step 2: Remove queuePosition from StatusRow.tsx**

In `app/components/StatusRow.tsx`, remove `queuePosition` from the CardItem interface (line 42):

```typescript
interface CardItem {
  id: number;
  title: string;
  position: number;
  color?: string | null;
}
```

Remove the `queuePosition` prop from the Card component (line 83):

```typescript
          <Card
            key={card.id}
            id={card.id}
            title={card.title}
            color={card.color}
            onClick={onCardClick}
          />
```

- [ ] **Step 3: Simplify board.index.tsx**

In `app/routes/board.index.tsx`, remove `queuePosition` from CardItem interface (line 58):

```typescript
interface CardItem {
  id: number;
  title: string;
  column: ColumnId;
  position: number;
  projectId: number | null;
  prUrl: string | null;
  sessionId: string | null;
  worktreeBranch: string | null;
  promptsSent: number;
  turnsCompleted: number;
  createdAt: string;
  updatedAt: string;
  color?: string | null;
}
```

Simplify `handleDragOver` (lines 198-209). Replace the queue-aware block:

```typescript
if (activeCol === 'running') {
  // Queued cards (queuePosition != null) can move anywhere
  const activeCard = Object.values(columns)
    .flat()
    .find((c) => c.id === active.id);
  if (activeCard?.queuePosition != null) {
    // allow — queued cards are freely movable
  } else if (overCol !== 'done' && overCol !== 'archive') {
    // Active running cards can only move to done/archive
    return;
  }
}
```

With:

```typescript
if (activeCol === 'running' && overCol !== 'done' && overCol !== 'archive') {
  return;
}
```

Simplify `handleDragEnd` (lines 266-284). Replace the queue-aware block:

```typescript
// Running cards: queued cards can move freely, active cards only to done/archive
if (originalCol === 'running') {
  const draggedCard = snapshotRef.current
    ? Object.values(snapshotRef.current)
        .flat()
        .find((c) => c.id === active.id)
    : Object.values(columns)
        .flat()
        .find((c) => c.id === active.id);
  if (draggedCard?.queuePosition != null) {
    // Queued cards — allow move to any column
  } else if (currentCol !== 'done' && currentCol !== 'archive') {
    // Active running cards — snap back unless moved to done/archive
    setDragOverride(null);
    setActiveId(null);
    snapshotRef.current = null;
    return;
  }
}
```

With:

```typescript
// Running cards can only move to done/archive
if (originalCol === 'running' && currentCol !== 'done' && currentCol !== 'archive') {
  setDragOverride(null);
  setActiveId(null);
  snapshotRef.current = null;
  return;
}
```

- [ ] **Step 4: Remove reorderQueue from card-store.ts**

In `app/stores/card-store.ts`, delete lines 154-156:

```typescript
  async reorderQueue(cardId: number, newPosition: number) {
    await this.ws().emit('queue:reorder', { cardId, newPosition });
  }
```

- [ ] **Step 5: Commit**

```bash
git add app/components/SessionView.tsx app/components/StatusRow.tsx app/routes/board.index.tsx app/stores/card-store.ts
git commit -m "chore: remove queuePosition from all frontend components"
```

---

### Task 8: Simplify resolve-pin ranking

**Files:**

- Modify: `app/lib/resolve-pin.ts:10-28`

- [ ] **Step 1: Simplify rankCards function**

Replace the entire `rankCards` function (lines 11-28) with:

```typescript
/** Rank eligible cards: review (oldest first) → running (newest first). */
function rankCards(eligible: Card[]): Card[] {
  const review = eligible.filter((c) => c.column === 'review').sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const running = eligible.filter((c) => c.column === 'running').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return [...review, ...running];
}
```

- [ ] **Step 2: Update JSDoc comment**

Replace the priority comment in the `resolvePinnedCards` JSDoc (lines 43-45):

```typescript
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Active running (queuePosition == null) — newest updatedAt first
 *   3. Queued running — queuePosition ascending, newest updatedAt as tiebreak
```

With:

```typescript
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Running cards — newest updatedAt first
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/resolve-pin.ts
git commit -m "chore: simplify pin ranking to review > running (no queue tiers)"
```

---

### Task 9: Update tests

**Files:**

- Modify: `app/lib/resolve-pin.test.ts`
- Modify: `app/lib/use-slots.test.ts:35`
- Modify: `app/lib/use-slots.hook.test.ts:29`

- [ ] **Step 1: Remove queuePosition from resolve-pin.test.ts makeCard helper**

In `app/lib/resolve-pin.test.ts`, remove line 26 from the `makeCard` helper:

```typescript
    queuePosition: null,
```

- [ ] **Step 2: Remove queuePosition from test card overrides**

In all `makeCard` calls throughout the file that pass `queuePosition`, remove that property. Specifically:

- Lines 59-60: Remove `queuePosition: null` from both cards in "resolves active running card" test
- Line 70: Remove `queuePosition: null` from card in "prefers review over running" test
- Lines 307, 320: Remove `queuePosition: null` from cards in sticky behavior tests
- Lines 432, 464: Remove `queuePosition: null` from cards in "all" slot tests

- [ ] **Step 3: Delete queue-specific test cases**

Delete these 3 test cases entirely:

1. `'ranks active running (queuePosition null) above queued running'` (lines 75-82)
2. `'ranks queued running cards by queuePosition ascending'` (lines 84-97)
3. `'distributes three queued running cards by queuePosition across three pinned slots'` (lines 192-208)

- [ ] **Step 4: Simplify "all" priority ranking test**

Replace the test `'uses same priority ranking in "all" slots: review > active running > queued'` (lines 423-439) with:

```typescript
it('uses same priority ranking in "all" slots: review > running', () => {
  const slots: SlotState[] = [
    { type: 'empty' },
    { type: 'pinned', projectId: 'all' },
    { type: 'pinned', projectId: 'all' },
  ];
  const cards = [
    makeCard({ id: 2, projectId: 20, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    makeCard({ id: 3, projectId: 30, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
  ];
  const result = resolvePinnedCards(slots, cards);
  expect(result.get(1)).toBe(3); // review first
  expect(result.get(2)).toBe(2); // running second
});
```

- [ ] **Step 5: Remove queuePosition from other test helpers**

In `app/lib/use-slots.test.ts`, remove `queuePosition: null` from the `makeCard` helper (line 35).

In `app/lib/use-slots.hook.test.ts`, remove `queuePosition: null` from the `makeCard` helper (line 29).

- [ ] **Step 6: Run all tests**

Run: `cd /home/ryan/Code/orchestrel && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/lib/resolve-pin.test.ts app/lib/use-slots.test.ts app/lib/use-slots.hook.test.ts
git commit -m "chore: update tests to remove queue-related fixtures and test cases"
```

---

### Task 10: Database migration

**Files:**

- Run: SQLite CLI against `data/orchestrel.db`

SQLite doesn't support `ALTER TABLE DROP COLUMN` in older versions, but since 3.35.0+ it does. The dev machine should have a recent enough version. These columns are safe to drop per CLAUDE.md (schema additions via sqlite3 CLI are safe).

- [ ] **Step 1: Verify SQLite version supports DROP COLUMN**

```bash
sqlite3 --version
```

Expected: 3.35.0 or higher.

- [ ] **Step 2: Drop the three columns**

```bash
sqlite3 data/orchestrel.db "ALTER TABLE cards DROP COLUMN queue_position;"
sqlite3 data/orchestrel.db "ALTER TABLE cards DROP COLUMN pending_prompt;"
sqlite3 data/orchestrel.db "ALTER TABLE cards DROP COLUMN pending_files;"
```

- [ ] **Step 3: Verify columns are gone**

```bash
sqlite3 data/orchestrel.db ".schema cards"
```

Expected: The `cards` table schema should no longer contain `queue_position`, `pending_prompt`, or `pending_files`.

- [ ] **Step 4: Commit** (no code changes — DB is not committed, but note in commit)

No git commit needed — the DB file is not tracked.

---

### Task 11: Delete obsolete docs and build verification

**Files:**

- Delete: `docs/superpowers/plans/2026-03-18-task-queue-chaining.md`
- Delete: `docs/superpowers/specs/2026-03-18-task-queue-chaining-design.md`

- [ ] **Step 1: Delete queue docs**

```bash
rm docs/superpowers/plans/2026-03-18-task-queue-chaining.md
rm docs/superpowers/specs/2026-03-18-task-queue-chaining-design.md
```

- [ ] **Step 2: Run full build**

```bash
cd /home/ryan/Code/orchestrel && pnpm build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/ryan/Code/orchestrel && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Restart service**

```bash
sudo systemctl restart orchestrel
```

- [ ] **Step 5: Commit**

```bash
git add -u docs/superpowers/plans/2026-03-18-task-queue-chaining.md docs/superpowers/specs/2026-03-18-task-queue-chaining-design.md
git commit -m "chore: delete obsolete queue docs"
```

---

### Task 12: Update CLAUDE.md DB schema

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove queue columns from DB schema in CLAUDE.md**

In the `cards` table schema in CLAUDE.md, remove these three lines:

```sql
  queue_position INTEGER DEFAULT NULL,
  pending_prompt TEXT DEFAULT NULL,
  pending_files TEXT DEFAULT NULL,
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: remove queue columns from DB schema in CLAUDE.md"
```
