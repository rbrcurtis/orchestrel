# Global Orcd Router Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-card `registerCardSession` handlers with a single global orcd message router, eliminating the restart-loses-handlers bug.

**Architecture:** One global `onMessage` handler on OrcdClient, registered once at init. A `Map<sessionId, cardId>` routes messages to the right card. The map is populated on session create and survives restarts because the router is re-initialized at startup. Callers use `trackSession(cardId, sessionId)` to add entries; `session_exit` handling removes them.

**Tech Stack:** TypeScript, OrcdClient, MessageBus, TypeORM

**Spec context:** This replaces the `registerCardSession` approach in `src/server/controllers/card-sessions.ts`. The current pattern registers a fresh `onMessage` closure per card+session pair. After a server restart, these in-memory handlers are lost, and follow-up messages to still-active orcd sessions skip re-registration — so result, context_usage, and session_exit events go unhandled.

---

## File Structure

| File | Change | Responsibility |
|------|--------|---------------|
| `src/server/controllers/card-sessions.ts` | Major refactor | Replace `registerCardSession` with `initOrcdRouter`, `trackSession`, `untrackSession`. Same message handling logic, but via single global handler + map lookup. |
| `src/server/ws/handlers/agents.ts` | Minor update | Replace `registerCardSession` calls with `trackSession` |
| `src/server/init.ts` | Minor update | Call `initOrcdRouter(client)` at startup |

---

### Task 1: Refactor card-sessions.ts — global router with session map

**Files:**
- Modify: `src/server/controllers/card-sessions.ts`

This is the core refactor. We replace the per-card handler registration pattern with:
- A module-level `Map<string, number>` (sessionId → cardId)
- `trackSession(cardId, sessionId)` — adds an entry
- `untrackSession(sessionId)` — removes an entry
- `initOrcdRouter(client)` — registers one global `onMessage` handler that looks up cardId from the map and routes messages

The message handling logic (what happens for each msg.type) stays identical.

- [ ] **Step 1: Write tests for the router**

Create `src/server/controllers/card-sessions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../bus';

// Mock DB so handler doesn't throw on Card operations
vi.mock('../models/index', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOneBy: vi.fn().mockResolvedValue({ id: 42, sessionId: 'sess-abc', contextTokens: 0, contextWindow: 200000, turnsCompleted: 0, updatedAt: '', save: vi.fn() }),
      save: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));
vi.mock('../models/Card', () => ({
  Card: { findOneBy: vi.fn().mockResolvedValue(null), find: vi.fn().mockResolvedValue([]) },
}));

// We test the routing concept: orcd messages for a tracked session
// should be published to the correct card's bus topics.

describe('orcd message router', () => {
  let bus: MessageBus;
  let handler: ((msg: unknown) => void) | null;

  // Minimal mock OrcdClient — captures the onMessage handler
  const mockClient = {
    onMessage: vi.fn((h: (msg: unknown) => void) => { handler = h; }),
    offMessage: vi.fn(),
  };

  beforeEach(() => {
    bus = new MessageBus();
    handler = null;
    mockClient.onMessage.mockClear();
    mockClient.offMessage.mockClear();
  });

  it('routes stream_event to card:N:sdk bus topic', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'assistant', message: 'hello' },
    });

    // Give async handler time to run
    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).toHaveBeenCalledWith({ type: 'assistant', message: 'hello' });
  });

  it('ignores messages for untracked sessions', async () => {
    const { initOrcdRouter } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    // Don't track any session

    const sdkSpy = vi.fn();
    bus.on('card:99:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'unknown-sess',
      eventIndex: 0,
      event: { type: 'assistant', message: 'hello' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).not.toHaveBeenCalled();
  });

  it('routes context_usage to card:N:context bus topic', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const ctxSpy = vi.fn();
    bus.on('card:42:context', ctxSpy);

    handler!({
      type: 'context_usage',
      sessionId: 'sess-abc',
      contextTokens: 50000,
      contextWindow: 200000,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(ctxSpy).toHaveBeenCalledWith({
      contextTokens: 50000,
      contextWindow: 200000,
    });
  });

  it('untrackSession stops routing', async () => {
    const { initOrcdRouter, trackSession, untrackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');
    untrackSession('sess-abc');

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'assistant', message: 'hello' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/controllers/card-sessions.test.ts 2>&1 | tail -20`
Expected: FAIL — `initOrcdRouter` and `trackSession` don't exist yet.

- [ ] **Step 3: Rewrite card-sessions.ts**

Replace the entire file with:

```ts
import { Card } from '../models/Card';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import type { OrcdMessage } from '../../shared/orcd-protocol';
import type { OrcdClient } from '../orcd-client';

// ── Session → Card routing map ───────────────────────────────────────────────

const sessionCardMap = new Map<string, number>();

/** Register a sessionId → cardId mapping so the global router can route messages. */
export function trackSession(cardId: number, sessionId: string): void {
  sessionCardMap.set(sessionId, cardId);
  console.log(`[orcd-router] tracking session ${sessionId.slice(0, 8)} → card ${cardId}`);
}

/** Remove a session from the routing map. */
export function untrackSession(sessionId: string): void {
  sessionCardMap.delete(sessionId);
}

// ── Global orcd message router ───────────────────────────────────────────────

/**
 * Register a single global onMessage handler on the OrcdClient.
 * Routes messages by looking up sessionId → cardId in the map.
 * Call once at startup — survives for the process lifetime.
 */
export function initOrcdRouter(
  client: OrcdClient,
  bus: MessageBus = messageBus,
): void {
  const repo = () => AppDataSource.getRepository(Card);

  client.onMessage(async (msg: OrcdMessage) => {
    if (!('sessionId' in msg)) return;
    const cardId = sessionCardMap.get(msg.sessionId);
    if (cardId == null) return;

    if (msg.type === 'stream_event') {
      const sdkEvent = msg.event as Record<string, unknown>;
      bus.publish(`card:${cardId}:sdk`, sdkEvent);

      if (sdkEvent.type === 'system') {
        const sys = sdkEvent as { subtype?: string; session_id?: string };

        if (sys.subtype === 'init' && sys.session_id) {
          const card = await repo().findOneBy({ id: cardId });
          if (card && (!card.sessionId || card.sessionId.startsWith('msg_'))) {
            card.sessionId = sys.session_id;
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] init: persisted sessionId=${sys.session_id}`);
          }
        }

        if (sys.subtype === 'compact_boundary') {
          const card = await repo().findOneBy({ id: cardId });
          if (card) {
            card.contextTokens = 0;
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] compact_boundary: reset contextTokens to 0`);
          }
        }
      }
    }

    if (msg.type === 'result') {
      const result = msg.result as Record<string, unknown>;
      bus.publish(`card:${cardId}:sdk`, result);

      const card = await repo().findOneBy({ id: cardId });
      if (card) {
        card.turnsCompleted = (card.turnsCompleted ?? 0) + 1;
        card.updatedAt = new Date().toISOString();
        await repo().save(card);
      }
    }

    if (msg.type === 'context_usage') {
      const card = await repo().findOneBy({ id: cardId });
      if (card) {
        card.contextTokens = msg.contextTokens;
        card.contextWindow = msg.contextWindow;
        card.updatedAt = new Date().toISOString();
        await repo().save(card);
      }
      bus.publish(`card:${cardId}:context`, {
        contextTokens: msg.contextTokens,
        contextWindow: msg.contextWindow,
      });
    }

    if (msg.type === 'error') {
      bus.publish(`card:${cardId}:sdk`, {
        type: 'error',
        message: msg.error,
        timestamp: Date.now(),
      });
    }

    if (msg.type === 'session_exit') {
      await handleSessionExit(cardId, bus);
      untrackSession(msg.sessionId);
    }
  });

  console.log('[orcd-router] global handler registered');
}

// ── Session exit ─────────────────────────────────────────────────────────────

async function handleSessionExit(
  cardId: number,
  bus: MessageBus = messageBus,
): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });

  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  bus.publish(`card:${cardId}:exit`, {
    sessionId: card?.sessionId,
    status: 'completed',
  });
}

// ── Board event listeners ────────────────────────────────────────────────────

export function registerAutoStart(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;

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
      const prompt = fullCard.sessionId ? '' : fullCard.description ?? '';

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

      trackSession(fullCard.id, sessionId);
    }

    // Card left running: cancel session
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (card.sessionId) {
        client?.cancel(card.sessionId);
      }
    }
  });
}

export function registerWorktreeCleanup(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (newColumn !== 'archive' || oldColumn === 'archive') return;

    const c = card as Card;
    if (!c.worktreeBranch || !c.projectId) return;

    try {
      const { Project } = await import('../models/Project');
      const proj = await Project.findOneBy({ id: c.projectId });
      if (!proj) return;

      const { resolveWorkDir } = await import('../../shared/worktree');
      const wtPath = resolveWorkDir(c.worktreeBranch, proj.path);
      const { removeWorktree, worktreeExists } = await import('../worktree');
      if (worktreeExists(wtPath)) {
        removeWorktree(proj.path, wtPath);
        console.log(`[oc:worktree] removed ${wtPath}`);
      }
    } catch (err) {
      console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err);
    }
  });
}

function repo() {
  return AppDataSource.getRepository(Card);
}
```

Key differences from the old code:
- No `registerCardSession` — replaced by `initOrcdRouter` (one global handler) + `trackSession` (map entry)
- No `registeredSessions` Set — the `sessionCardMap` serves this purpose
- No per-card closures — one handler does a map lookup
- `handleSessionExit` calls `untrackSession` to clean up the map
- `registerAutoStart` calls `trackSession` instead of `registerCardSession`

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/server/controllers/card-sessions.test.ts 2>&1 | tail -20`
Expected: Tests pass (bus routing tests work without DB — they only test the map lookup + bus publish path).

Note: The DB-touching handlers (result → turnsCompleted, context_usage → contextTokens) won't fire in the test because `AppDataSource` isn't initialized. The tests verify routing only — that the right bus topics get the right payloads. DB persistence is verified by the existing integration flow.

- [ ] **Step 5: Commit**

```bash
git add src/server/controllers/card-sessions.ts src/server/controllers/card-sessions.test.ts
git commit -m "refactor: replace per-card handlers with global orcd message router

Single global onMessage handler + sessionId→cardId map. Eliminates the
restart-loses-handlers bug — the router is registered once at init and
the map is populated by trackSession calls."
```

---

### Task 2: Update agents.ts to use trackSession

**Files:**
- Modify: `src/server/ws/handlers/agents.ts:4,29,46`

- [ ] **Step 1: Replace imports and calls**

In `src/server/ws/handlers/agents.ts`, change line 4 from:

```ts
import { registerCardSession } from '../../controllers/card-sessions';
```

To:

```ts
import { trackSession } from '../../controllers/card-sessions';
```

Change lines 28-29 (follow-up path) from:

```ts
      // Follow-up to active session — ensure handler registered (may be lost after server restart)
      registerCardSession(cardId, card.sessionId);
```

To:

```ts
      // Follow-up to active session — ensure tracked in router map
      trackSession(cardId, card.sessionId);
```

Change line 46 (new session path) from:

```ts
      registerCardSession(cardId, sessionId);
```

To:

```ts
      trackSession(cardId, sessionId);
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/handlers/agents.ts
git commit -m "refactor: use trackSession instead of registerCardSession in agent handlers"
```

---

### Task 3: Wire up global router at startup

**Files:**
- Modify: `src/server/init.ts:101-115`

- [ ] **Step 1: Add initOrcdRouter call**

In `src/server/init.ts`, change lines 101-115 from:

```ts
  // --- OC controllers + OrcdClient ---
  const { registerAutoStart, registerWorktreeCleanup } = await import('./controllers/card-sessions');
  const initState = await import('./init-state');

  let client = initState.getOrcdClient();
  if (!client) {
    const { OrcdClient } = await import('./orcd-client');
    client = new OrcdClient();
    await client.connect();
    initState.setOrcdClient(client);
  }

  registerAutoStart();
  registerWorktreeCleanup();
  console.log('[orcd] OrcdClient connected, controller listeners registered');
```

To:

```ts
  // --- OC controllers + OrcdClient ---
  const { initOrcdRouter, trackSession, registerAutoStart, registerWorktreeCleanup } =
    await import('./controllers/card-sessions');
  const initState = await import('./init-state');

  let client = initState.getOrcdClient();
  if (!client) {
    const { OrcdClient } = await import('./orcd-client');
    client = new OrcdClient();
    await client.connect();
    initState.setOrcdClient(client);
  }

  // Register the single global orcd message router
  initOrcdRouter(client);

  // Populate session map from running cards so messages route after restart
  try {
    const { Card: CardModel } = await import('./models/Card');
    const runningCards = await CardModel.find({ where: { column: 'running' } });
    for (const card of runningCards) {
      if (card.sessionId) {
        trackSession(card.id, card.sessionId);
      }
    }
  } catch (err) {
    console.error('[startup] session map population failed:', err);
  }

  registerAutoStart();
  registerWorktreeCleanup();
  console.log('[orcd] OrcdClient connected, router + listeners registered');
```

- [ ] **Step 2: Check for duplicate init in ws/server.ts**

The Vite dev server has a parallel init path in `src/server/ws/server.ts`. Check if it also calls `registerAutoStart` / `registerWorktreeCleanup` and needs the same `initOrcdRouter` treatment.

Run: `grep -n 'registerAutoStart\|registerWorktreeCleanup\|initOrcdRouter' src/server/ws/server.ts`

If `ws/server.ts` has its own init path (it does — lines 146-156), apply the same changes there: import `initOrcdRouter` and `trackSession`, call `initOrcdRouter(client)` before `registerAutoStart()`, populate the session map from running cards.

Read `src/server/ws/server.ts` lines 130-170 to see the exact context, then make the equivalent changes.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run 2>&1 | tail -20`
Expected: All tests pass (including the new card-sessions.test.ts).

- [ ] **Step 5: Commit**

```bash
git add src/server/init.ts src/server/ws/server.ts
git commit -m "feat: wire up global orcd router at startup with session map population"
```

---

### Task 4: Verify end-to-end

- [ ] **Step 1: Build check**

Run: `pnpm build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 2: Restart orchestrel (with permission)**

Ask before restarting. Run: `sudo systemctl restart orchestrel`

- [ ] **Step 3: Verify context wheel on new turn**

Send a message to a running card. After the turn completes, check:

```bash
sqlite3 data/orchestrel.db "SELECT id, context_tokens, context_window FROM cards WHERE column='running' AND context_tokens > 0;"
```

Expected: Non-zero `context_tokens` for cards with completed turns.

- [ ] **Step 4: Verify persistence after orchestrel restart**

Restart orchestrel again. Open a card that had context values. The context wheel should show the last known percentage immediately (loaded from DB via `handleAgentStatus`).
