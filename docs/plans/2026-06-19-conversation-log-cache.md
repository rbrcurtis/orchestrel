# Conversation Log Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache Claude session transcripts in the browser so cards paint instantly on open and stay viewable across reloads and backend/orcd outages.

**Architecture:** Persist the `MessageAccumulator.conversation` snapshot per card to IndexedDB (size-based LRU, 100MB). On open, hydrate the accumulator from cache for an instant paint; the normal `session:load` socket download still runs and `ingestHistory()` wholesale-replaces the cache copy. Separately, flip the service worker from network-first to stale-while-revalidate so the app shell boots from cache. No backend changes.

**Tech Stack:** TypeScript (strict), MobX, `idb-keyval`, Vitest, service worker.

**Spec:** `docs/specs/2026-06-19-conversation-log-cache-design.md`

---

## File Structure

- **Modify** `app/lib/message-accumulator.ts` — add `serialize()` / `hydrate()` to `MessageAccumulator`.
- **Modify** `app/lib/message-accumulator.test.ts` — add the serialize→hydrate round-trip test.
- **Create** `app/lib/conversation-cache.ts` — per-card IndexedDB read/write + size-based LRU eviction.
- **Create** `app/lib/conversation-cache.test.ts` — LRU eviction unit tests.
- **Modify** `app/stores/session-store.ts` — add `cacheHydrated` flag, `hydrateFromCache()`, `startPersisting()`.
- **Modify** `app/stores/session-store.test.ts` — test the hydrate race guard.
- **Modify** `app/components/SessionView.tsx` — call `hydrateFromCache()` + `startPersisting()` on mount.
- **Modify** `public/sw.js` — network-first → stale-while-revalidate, bump cache to `v6`.

---

## Task 1: Accumulator serialize / hydrate

**Files:**
- Modify: `app/lib/message-accumulator.ts` (add two methods to `MessageAccumulator`, after `clear()` near line 498)
- Test: `app/lib/message-accumulator.test.ts`

The accumulator's `conversation` holds `ContentBlock` **class instances** inside `kind:'blocks'` entries. `serialize()` must emit plain JSON-safe objects (so the cache layer never touches MobX proxies), and `hydrate()` must rebuild `ContentBlock` instances so rendering and observability work. Transient state (`currentBlocks`, `subagents`, private trackers) is intentionally excluded.

- [ ] **Step 1: Write the failing test**

Add to the bottom of `app/lib/message-accumulator.test.ts`:

```typescript
describe('MessageAccumulator serialize/hydrate', () => {
  it('round-trips conversation, rebuilding ContentBlock instances', () => {
    const acc = new MessageAccumulator();
    acc.handleHistoryMessage({
      type: 'assistant',
      timestamp: Date.UTC(2026, 5, 19, 12, 0, 0),
      message: {
        model: 'claude-sonnet-4',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file: 'a.ts' } },
        ],
      },
    });
    acc.flushHistory();

    const snapshot = acc.serialize();
    // snapshot must survive a JSON round-trip (this is what IndexedDB stores)
    const wireSafe = JSON.parse(JSON.stringify(snapshot)) as unknown[];

    const restored = new MessageAccumulator();
    restored.hydrate(wireSafe);

    expect(restored.conversation.length).toBe(acc.conversation.length);
    const blocksEntry = restored.conversation.find((e) => e.kind === 'blocks');
    expect(blocksEntry).toBeDefined();
    if (blocksEntry?.kind !== 'blocks') throw new Error('expected blocks entry');
    const toolBlock = blocksEntry.blocks.find((b) => b.type === 'tool_use');
    expect(toolBlock).toBeInstanceOf(ContentBlock);
    expect(toolBlock?.id).toBe('tool_1');
    expect(toolBlock?.input).toBe(JSON.stringify({ file: 'a.ts' }));
    expect(toolBlock?.complete).toBe(true);
  });

  it('hydrate replaces existing conversation', () => {
    const acc = new MessageAccumulator();
    acc.addUserMessage('first');
    acc.hydrate([{ kind: 'user', content: 'second' }]);
    expect(acc.conversation.length).toBe(1);
    expect(acc.conversation[0]).toMatchObject({ kind: 'user', content: 'second' });
  });
});
```

Add `ContentBlock` to the existing import at the top of the test file:

```typescript
import { MessageAccumulator, ContentBlock } from './message-accumulator';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- message-accumulator`
Expected: FAIL — `acc.serialize is not a function`.

- [ ] **Step 3: Implement serialize/hydrate**

In `app/lib/message-accumulator.ts`, add these two methods immediately after the `clear()` method (currently ends at line 498), before the closing `}` of the class:

```typescript
  serialize(): unknown[] {
    return this.conversation.map((entry) => {
      if (entry.kind !== 'blocks') return { ...entry };
      return {
        ...entry,
        blocks: entry.blocks.map((b) => ({
          type: b.type,
          content: b.content,
          id: b.id,
          name: b.name,
          input: b.input,
          output: b.output,
          complete: b.complete,
        })),
      };
    });
  }

  hydrate(data: unknown[]): void {
    const entries: ConversationEntry[] = [];
    for (const raw of data) {
      const entry = raw as ConversationEntry;
      if (entry.kind === 'blocks') {
        const blocks = (entry.blocks as unknown as Array<{
          type: 'text' | 'thinking' | 'tool_use';
          content: string;
          id?: string;
          name?: string;
          input?: string;
          output?: string;
          complete: boolean;
        }>).map((b) => new ContentBlock({
          type: b.type,
          content: b.content,
          id: b.id,
          name: b.name,
          input: b.input,
          output: b.output,
          complete: b.complete,
        }));
        entries.push({ ...entry, blocks });
      } else {
        entries.push(entry);
      }
    }
    this.conversation = entries;
    this.currentBlocks = [];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- message-accumulator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/message-accumulator.ts app/lib/message-accumulator.test.ts
git commit -m "feat: serialize/hydrate for MessageAccumulator"
```

---

## Task 2: Conversation cache module (IndexedDB + LRU)

**Files:**
- Create: `app/lib/conversation-cache.ts`
- Test: `app/lib/conversation-cache.test.ts`

Per-card persistence keyed `conv:v1:<cardId>`, with an LRU index `conv:v1:index` (`{cardId, ts, bytes}[]`). On write, evict oldest-by-`ts` until under a 100MB budget, never evicting the card just written.

- [ ] **Step 1: Write the failing test**

Create `app/lib/conversation-cache.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConversation, writeConversation, __setBudgetForTest } from './conversation-cache';

const store = new Map<string, unknown>();
const get = vi.fn((k: string) => Promise.resolve(store.get(k)));
const set = vi.fn((k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); });
const del = vi.fn((k: string) => { store.delete(k); return Promise.resolve(); });

vi.mock('idb-keyval', () => ({
  get: (...a: unknown[]) => get(a[0] as string),
  set: (...a: unknown[]) => set(a[0] as string, a[1]),
  del: (...a: unknown[]) => del(a[0] as string),
}));

describe('conversation-cache', () => {
  beforeEach(() => {
    store.clear();
    get.mockClear();
    set.mockClear();
    del.mockClear();
    __setBudgetForTest(1000); // 1000-byte budget for testing
  });

  it('round-trips a conversation by cardId', async () => {
    await writeConversation(1, [{ kind: 'user', content: 'hi' }]);
    const out = await readConversation(1);
    expect(out).toEqual([{ kind: 'user', content: 'hi' }]);
  });

  it('returns null for a missing card', async () => {
    expect(await readConversation(99)).toBeNull();
  });

  it('evicts the oldest card when over budget, keeping the active card', async () => {
    const big = (n: number) => [{ kind: 'user', content: 'x'.repeat(n) }];
    await writeConversation(1, big(600)); // card 1 oldest
    await writeConversation(2, big(600)); // total now > 1000 → card 1 evicted
    expect(await readConversation(1)).toBeNull();
    expect(await readConversation(2)).not.toBeNull();
  });

  it('keeps the active card even if it alone exceeds budget', async () => {
    await writeConversation(1, [{ kind: 'user', content: 'x'.repeat(5000) }]);
    expect(await readConversation(1)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- conversation-cache`
Expected: FAIL — cannot resolve `./conversation-cache`.

- [ ] **Step 3: Implement the module**

Create `app/lib/conversation-cache.ts`:

```typescript
import { get, set, del } from 'idb-keyval';

const VERSION = 'v1';
const INDEX_KEY = `conv:${VERSION}:index`;
const cardKey = (cardId: number) => `conv:${VERSION}:${cardId}`;

let budgetBytes = 100 * 1024 * 1024; // 100MB

// Test-only hook to shrink the budget so eviction is exercisable.
export function __setBudgetForTest(bytes: number): void {
  budgetBytes = bytes;
}

interface IndexRow {
  cardId: number;
  ts: number;
  bytes: number;
}

export async function readConversation(cardId: number): Promise<unknown[] | null> {
  const data = await get(cardKey(cardId));
  return Array.isArray(data) ? data : null;
}

export async function writeConversation(cardId: number, entries: unknown[]): Promise<void> {
  const json = JSON.stringify(entries);
  await set(cardKey(cardId), JSON.parse(json));
  await updateIndex(cardId, json.length);
}

async function updateIndex(cardId: number, bytes: number): Promise<void> {
  const index = ((await get(INDEX_KEY)) as IndexRow[] | undefined) ?? [];
  const rows = index.filter((r) => r.cardId !== cardId);
  rows.push({ cardId, ts: Date.now(), bytes });
  rows.sort((a, b) => a.ts - b.ts); // oldest first

  let total = rows.reduce((sum, r) => sum + r.bytes, 0);
  const kept: IndexRow[] = [];
  for (const row of rows) {
    // Never evict the card just written, even if it alone exceeds the budget.
    if (total > budgetBytes && row.cardId !== cardId) {
      await del(cardKey(row.cardId));
      total -= row.bytes;
      continue;
    }
    kept.push(row);
  }
  await set(INDEX_KEY, kept);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- conversation-cache`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/conversation-cache.ts app/lib/conversation-cache.test.ts
git commit -m "feat: per-card conversation cache with LRU eviction"
```

---

## Task 3: Session store integration

**Files:**
- Modify: `app/stores/session-store.ts`
- Test: `app/stores/session-store.test.ts`

Add a `cacheHydrated` flag, a `hydrateFromCache()` that paints from cache without clobbering already-loaded history, and `startPersisting()` that registers a debounced `autorun` writing the accumulator snapshot.

- [ ] **Step 1: Write the failing test**

Add to `app/stores/session-store.test.ts` (match the file's existing import/mock style — it mocks `idb-keyval` or the cache; if no idb mock exists yet, add the mock block shown below at the top of the file):

```typescript
// add near the other vi.mock calls at the top of the file:
vi.mock('../lib/conversation-cache', () => ({
  readConversation: vi.fn(),
  writeConversation: vi.fn(() => Promise.resolve()),
}));

import { readConversation } from '../lib/conversation-cache';

describe('SessionStore hydrateFromCache', () => {
  it('paints cached conversation when history not yet loaded', async () => {
    vi.mocked(readConversation).mockResolvedValue([{ kind: 'user', content: 'cached' }]);
    const store = new SessionStore();

    await store.hydrateFromCache(1);

    const s = store.getSession(1);
    expect(s?.cacheHydrated).toBe(true);
    expect(s?.accumulator.conversation).toEqual([
      expect.objectContaining({ kind: 'user', content: 'cached' }),
    ]);
  });

  it('does not clobber already-loaded history', async () => {
    vi.mocked(readConversation).mockResolvedValue([{ kind: 'user', content: 'cached' }]);
    const store = new SessionStore();
    store.ingestHistory(1, []); // sets historyLoaded = true
    store.getSession(1)!.accumulator.addUserMessage('live');

    await store.hydrateFromCache(1);

    expect(store.getSession(1)?.accumulator.conversation).toEqual([
      expect.objectContaining({ kind: 'user', content: 'live' }),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- session-store`
Expected: FAIL — `store.hydrateFromCache is not a function`.

- [ ] **Step 3: Implement the integration**

In `app/stores/session-store.ts`:

a) Update the imports at the top:

```typescript
import { makeAutoObservable, observable, runInAction, autorun, type IReactionDisposer } from 'mobx';
```

and add:

```typescript
import { readConversation, writeConversation } from '../lib/conversation-cache';
```

b) Add `cacheHydrated` to the `SessionState` interface (after `historyLoaded: boolean;`):

```typescript
  cacheHydrated: boolean;
```

c) Add it to `defaultSession()` (after `historyLoaded: false,`):

```typescript
    cacheHydrated: false,
```

d) Add a disposer map field and register it as non-observable. Change the field block (lines 39-41) to:

```typescript
  private stopIntervals = new Map<number, NodeJS.Timeout>();
  private loadingCards = new Set<number>();
  private persistDisposers = new Map<number, IReactionDisposer>();
  private _ws: WsClient | null = null;
```

and update the `makeAutoObservable` annotation (lines 44-48) to:

```typescript
    makeAutoObservable<this, 'stopIntervals' | 'loadingCards' | 'persistDisposers' | '_ws'>(this, {
      stopIntervals: false,
      loadingCards: false,
      persistDisposers: false,
      _ws: false,
    });
```

e) Add the two methods after `getSession()` (after line 66):

```typescript
  async hydrateFromCache(cardId: number): Promise<void> {
    const s = this.getOrCreate(cardId);
    if (s.historyLoaded || s.cacheHydrated) return;
    const entries = await readConversation(cardId);
    if (!entries || entries.length === 0) return;
    runInAction(() => {
      // loadHistory may have won the race while we awaited the cache read
      if (s.historyLoaded) return;
      s.accumulator.hydrate(entries);
      s.cacheHydrated = true;
    });
  }

  startPersisting(cardId: number): void {
    if (this.persistDisposers.has(cardId)) return;
    const s = this.getOrCreate(cardId);
    const dispose = autorun(
      () => {
        const entries = s.accumulator.serialize();
        if (entries.length === 0) return;
        writeConversation(cardId, entries).catch(() => {});
      },
      { delay: 1000 },
    );
    this.persistDisposers.set(cardId, dispose);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- session-store`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/stores/session-store.ts app/stores/session-store.test.ts
git commit -m "feat: hydrate session from cache and persist on change"
```

---

## Task 4: Wire SessionView to hydrate + persist

**Files:**
- Modify: `app/components/SessionView.tsx` (the history-load `useEffect`, lines 74-78)

Trigger an instant cache paint and start persistence the moment the view mounts for a card, alongside the existing socket load.

- [ ] **Step 1: Update the effect**

Replace the `useEffect` at lines 74-78 with:

```typescript
  useEffect(() => {
    sessionStore.hydrateFromCache(cardId).catch(() => {});
    sessionStore.startPersisting(cardId);
    const sid = sessionStoreId ?? sessionId;
    if (sid && session?.historyLoaded) return; // history already loaded — nothing to do
    sessionStore.loadHistory(cardId, sid ?? undefined);
  }, [cardId, sessionStoreId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors, 0 warnings.

- [ ] **Step 3: Manual verification**

1. `sudo systemctl restart orchestrel`, open `http://localhost:6194`.
2. Open a card with a long transcript (cold). Confirm it loads.
3. Switch away and back — transcript should paint **instantly** (cache) before the socket round-trip refreshes it.
4. Reload the page mid-active-session — streamed turns should still be present.
5. In DevTools → Application → IndexedDB, confirm `conv:v1:<cardId>` and `conv:v1:index` keys exist.

- [ ] **Step 4: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: paint transcripts from cache on card open"
```

---

## Task 5: Service worker → stale-while-revalidate

**Files:**
- Modify: `public/sw.js`

Serve cached assets immediately, refresh in the background. Keep all existing skip rules; bump the cache name so the old network-first cache is purged by the existing activate handler.

- [ ] **Step 1: Rewrite the cache constant and fetch handler**

In `public/sw.js`, change line 4 to:

```javascript
const CACHE = 'orchestrel-v6';
```

Replace the entire `fetch` listener (lines 17-50) with:

```javascript
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Only cache same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip tRPC/API calls (handled by React Query + IndexedDB)
  if (url.pathname.startsWith('/api/')) return;

  // Skip Vite HMR internals
  if (url.pathname.startsWith('/@') || url.pathname.startsWith('/__vite')) return;

  // Skip manifest (doesn't need caching, causes CORS errors behind CF Access)
  if (url.pathname === '/manifest.json') return;

  // Stale-while-revalidate: serve cache immediately, refresh in the background.
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res.ok && !res.redirected) cache.put(request, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached || Response.error());
        return cached || network;
      }),
    ),
  );
});
```

- [ ] **Step 2: Manual verification**

1. `sudo systemctl restart orchestrel`, hard-reload the app once so the new SW (`v6`) installs and activates.
2. DevTools → Application → Service Workers: confirm the active worker is current and Cache Storage shows `orchestrel-v6` (old `orchestrel-v5` gone).
3. Reload again — app shell should appear instantly from cache.
4. DevTools → Network → set offline, reload — app shell still renders (transcripts served from the conversation cache via Task 4).

- [ ] **Step 3: Commit**

```bash
git add public/sw.js
git commit -m "feat: stale-while-revalidate service worker"
```

---

## Final Verification

- [ ] Run the full test suite: `pnpm test` — all pass.
- [ ] Run `pnpm typecheck && pnpm lint` — clean.
- [ ] Manual smoke per Task 4 Step 3 and Task 5 Step 2.
```
