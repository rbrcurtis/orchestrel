# Orcd-owned Pi-native Background Compactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make orchestrel's background compactor (BGC) work again after the Pi 0.78 migration — orcd-owned, writing Pi's native `compaction` tree entry, running as a true parallel background operation, with Pi's native auto-compaction left on as the ~92% safety net.

**Architecture:** orcd watches `context_usage`; at 60% it summarizes the oldest ~50% of the conversation **out-of-band** using Pi's exported `prepareCompaction` + `compact` pure functions (parallel-safe — they read entries, never mutate the live session), then when the session is idle it splices a `compaction` entry into the Pi session tree (`appendCompaction(..., fromHook=true)`) and rebuilds `agent.state.messages`. Pi's own `compaction_start/end` (safety net) are mapped to the same UI signals.

**Tech Stack:** TypeScript (strict), Node, vitest, `@earendil-works/pi-coding-agent` (Pi SDK), Unix-socket orcd daemon.

**Reference:** `docs/specs/2026-06-28-orcd-bgc-pi-native-design.md`

---

## Background the implementer needs

- **orcd layers:** `OrcdServer` (`src/orcd/socket-server.ts`) holds sessions in a `SessionStore`; each `OrcdSession` (`src/orcd/session.ts`) wraps a `PiRuntimeSession` (`src/orcd/pi-runtime.ts`) which wraps Pi's `AgentSession`.
- **Today's broken flow (being replaced):** `OrcdServer.triggerCompaction` builds a `PreparedCompaction` delegate and defers `session.compact()` to `beforeExit` via `pendingSummaries`/`applyPendingCompaction`. Pi's native compaction wins the race and orcd's deferred apply errors. We delete this machinery.
- **Pi compaction format:** a top-level tree entry `{type:"compaction", parentId, summary, firstKeptEntryId, tokensBefore, fromHook}`. On load, `buildSessionContext` keeps `[summary] + entries from firstKeptEntryId onward`.
- **Pi pure functions** (only these are exported from the package root `@earendil-works/pi-coding-agent` — verified against `dist/index.js`; `prepareCompaction` is NOT exported and deep imports are blocked by the `exports` map, so do not use it):
  - `findCutPoint(entries, startIndex, endIndex, keepRecentTokens): {firstKeptEntryIndex, turnStartIndex, isSplitTurn}` — walks backward over message entries accumulating `estimateTokens` until `>= keepRecentTokens`, then snaps to a valid cut (never on a tool_result). `firstKeptEntryIndex` indexes into the passed entries array.
  - `generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn): Promise<string>` — the model call; returns the summary text. Handles provider auth/stream when given the session's `streamFn`.
  - `DEFAULT_COMPACTION_SETTINGS` — `{enabled, reserveTokens: 16384, keepRecentTokens: 20000}`; use `.reserveTokens` for `generateSummary`.
  - `CompactionResult` (type) — `{summary, firstKeptEntryId, tokensBefore, details}` — the shape `prepareBgCompaction` returns (assembled by us).
- **Auth / streamFn:** `modelRegistry.getApiKeyAndHeaders(model)` returns `{apiKey, headers}`. OAuth providers (claude-max) need the session's reshaping stream fn, available as `session.agent.streamFn`. The `AgentSession` exposes public `agent`, `sessionManager`, and `get messages`.
- **Existing emit helpers** (`OrcdSession`): `emitBgcStarted()` and `emitCompactBoundary()` both call `emitSyntheticSystemEvent(...)` which pushes a `stream_event` to subscribers. `lastContextTokens`/`lastContextWindow` are public and updated on every `context_usage`.
- **Run all commands from repo root.** Tests: `corepack pnpm vitest run <file>`. Typecheck: `corepack pnpm typecheck`. Lint: `corepack pnpm lint`. (`pnpm` is only available via `corepack` in this environment.)

---

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/orcd/pi-runtime.ts` | modify | Add `prepareBgCompaction` + `applyBgCompaction` to `PiRuntimeSession`; close over `modelRegistry`/`model`/`thinkingLevel`. The only place that touches Pi compaction internals. |
| `src/orcd/session.ts` | modify | `OrcdSession.prepareBgCompaction`/`applyBgCompaction` delegating to the pi session; `isIdle` accessor; map Pi `compaction_start/end` → synthetic `bgc_started`/`compact_boundary`. |
| `src/orcd/socket-server.ts` | modify | New BGC controller (parallel prepare → idle apply → staleness guard); threshold trigger; repoint manual `/compact`; delete `triggerCompaction`/`applyPendingCompaction`/`pendingSummaries`. |
| `src/orcd/__tests__/socket-server-compaction.test.ts` | rewrite | Cover the new flow. |
| `src/lib/session-compactor.ts` + `.test.ts` | delete | Dead prepare/defer + Claude-shaped parser. |
| `src/lib/summarize-session.ts`, `scripts/summarize.ts`, `scripts/test-summarize.ts` | delete (after import check) | Dead dry-run preview chain. |
| `src/shared/constants.ts` | modify | Remove `AUTO_COMPACT_RATIO`. |
| `src/orcd/import-claude-session.ts` | delete (after import check) | Zero importers. |

---

## Task 1: pi-runtime — out-of-band summarize + apply

**Files:**
- Modify: `src/orcd/pi-runtime.ts`
- Test: `src/orcd/__tests__/pi-runtime-bgc.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/orcd/__tests__/pi-runtime-bgc.test.ts`. Mock the Pi SDK so the test exercises *our* wiring without a live model. Runtime uses the root-exported `findCutPoint` + `generateSummary` + `DEFAULT_COMPACTION_SETTINGS`.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findCutPoint = vi.fn();
const generateSummary = vi.fn();
const appendCompaction = vi.fn(() => 'comp-id');
const buildSessionContext = vi.fn(() => ({ messages: ['m1', 'm2'] }));
const getBranch = vi.fn();
const agentState = { messages: [] as unknown[] };

vi.mock('@earendil-works/pi-coding-agent', () => ({
  findCutPoint: (...a: unknown[]) => findCutPoint(...a),
  generateSummary: (...a: unknown[]) => generateSummary(...a),
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  AuthStorage: { create: () => ({ setRuntimeApiKey: vi.fn() }) },
  ModelRegistry: { create: () => ({
    registerProvider: vi.fn(),
    find: () => ({ id: 'm', api: 'anthropic-messages' }),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'k', headers: {} })),
  }) },
  SessionManager: { create: () => ({}), open: () => ({}), list: vi.fn(async () => []) },
  createAgentSession: vi.fn(async () => ({
    session: {
      sessionId: 'sess-1',
      agent: { state: agentState, streamFn: undefined },
      sessionManager: { getBranch, appendCompaction, buildSessionContext },
      bindExtensions: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
      messages: [],
    },
  })),
  getAgentDir: () => '/tmp/agent',
}));

import { createPiRuntimeSession } from '../pi-runtime';

async function makeSession() {
  return createPiRuntimeSession({ cwd: '/tmp/x', providerId: 'anthropic', modelId: 'm' });
}

describe('pi-runtime BGC', () => {
  beforeEach(() => {
    findCutPoint.mockReset();
    generateSummary.mockReset();
    appendCompaction.mockReset();
    getBranch.mockReset();
    agentState.messages = [];
  });

  it('prepareBgCompaction returns null when there is no older half to summarize', async () => {
    getBranch.mockReturnValue([{ type: 'message', id: 'e0', message: { role: 'user' } }]);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
    const s = await makeSession();
    const r = await s.prepareBgCompaction(0.5, 100_000, new AbortController().signal);
    expect(r).toBeNull();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it('summarizes the oldest entries and returns firstKeptEntryId from the cut', async () => {
    getBranch.mockReturnValue([
      { type: 'message', id: 'e0', message: { role: 'user', content: 'old' } },
      { type: 'message', id: 'e1', message: { role: 'assistant', content: 'keep' } },
    ]);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
    generateSummary.mockResolvedValue('S');
    const s = await makeSession();
    const r = await s.prepareBgCompaction(0.5, 100_000, new AbortController().signal);
    expect(r).toEqual({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 100_000, details: undefined });
    expect(findCutPoint).toHaveBeenCalledWith(expect.anything(), 0, 2, 50_000); // floor(100000*0.5)
    expect(generateSummary.mock.calls[0][0]).toEqual([{ role: 'user', content: 'old' }]); // oldest only
  });

  it('applyBgCompaction appends the entry and rebuilds messages', async () => {
    const s = await makeSession();
    await s.applyBgCompaction({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 42, details: undefined });
    expect(appendCompaction).toHaveBeenCalledWith('S', 'e1', 42, undefined, true);
    expect(agentState.messages).toEqual(['m1', 'm2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run src/orcd/__tests__/pi-runtime-bgc.test.ts`
Expected: FAIL — `s.prepareBgCompaction is not a function`.

- [ ] **Step 3: Implement the two methods**

In `src/orcd/pi-runtime.ts`:

Add to the value import from the package root (line 2):
```ts
import { AuthStorage, DEFAULT_COMPACTION_SETTINGS, ModelRegistry, SessionManager, createAgentSession, findCutPoint, generateSummary, getAgentDir } from '@earendil-works/pi-coding-agent';
```
Add `CompactionResult` to the type import (line 3):
```ts
import type { AgentSession, AgentSessionEvent, AuthStorage as PiAuthStorage, CompactionResult, ProviderConfig as ProviderConfigInput } from '@earendil-works/pi-coding-agent';
```
> Do NOT import or `declare module` `prepareCompaction` — it is not a real export (verified against `dist/index.js`) and would be `undefined` at runtime.

Extend the `PiRuntimeSession` interface (after `compact(...)`):
```ts
  /** Generate a BGC summary out-of-band (parallel-safe; does not mutate the session). null = nothing to compact. */
  prepareBgCompaction(keepFraction: number, currentTokens: number, signal: AbortSignal): Promise<CompactionResult | null>;
  /** Splice a prepared compaction into the session tree and rebuild context. Call only when idle. */
  applyBgCompaction(result: CompactionResult): void;
```

In `createPiRuntimeSession`, the closure already has `modelRegistry`, `model`, and `opts.effort`. Add these methods to the returned object:
```ts
    async prepareBgCompaction(keepFraction, currentTokens, signal) {
      const sm = session.sessionManager as unknown as {
        getBranch(): Array<{ type: string; id: string; message?: unknown }>;
      };
      const entries = sm.getBranch();
      const keepRecentTokens = Math.floor(currentTokens * keepFraction);
      const cut = findCutPoint(entries as never, 0, entries.length, keepRecentTokens);
      const firstKeptIdx = cut.firstKeptEntryIndex;
      if (firstKeptIdx <= 0) return null; // nothing older to summarize
      const toSummarize = entries
        .slice(0, firstKeptIdx)
        .filter((e) => e.type === 'message' && e.message !== undefined)
        .map((e) => e.message);
      if (toSummarize.length === 0) return null;
      const auth = await modelRegistry.getApiKeyAndHeaders(model as Model<Api>);
      const apiKey = 'apiKey' in auth ? (auth as { apiKey?: string }).apiKey : undefined;
      const headers = 'headers' in auth ? (auth as { headers?: Record<string, string> }).headers : undefined;
      const agent = (session as unknown as { agent: { streamFn?: unknown } }).agent;
      const summary = await generateSummary(
        toSummarize as never,
        model as Model<Api>,
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        apiKey,
        headers,
        signal,
        undefined,
        undefined,
        effortToThinkingLevel(opts.effort),
        agent.streamFn as never,
      );
      return { summary, firstKeptEntryId: entries[firstKeptIdx].id, tokensBefore: currentTokens, details: undefined };
    },

    applyBgCompaction(result) {
      const sm = session.sessionManager as unknown as {
        appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details: unknown, fromHook: boolean): string;
        buildSessionContext(): { messages: unknown[] };
      };
      sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
      const agent = (session as unknown as { agent: { state: { messages: unknown[] } } }).agent;
      agent.state.messages = sm.buildSessionContext().messages;
    },
```
> `session.sessionManager` is typed `ReadonlySessionManager` (omits `getBranch`/`appendCompaction`/`buildSessionContext`); the narrow casts reach the runtime methods. `getApiKeyAndHeaders` returns a discriminated union, so read `apiKey`/`headers` defensively. Keep casts local; no blanket `any`.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run src/orcd/__tests__/pi-runtime-bgc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `corepack pnpm typecheck`
Expected: no errors.
```bash
git add src/orcd/pi-runtime.ts src/orcd/__tests__/pi-runtime-bgc.test.ts
git commit -m "feat(orcd): pi-runtime out-of-band BGC summarize + apply"
```

---

## Task 2: OrcdSession — delegation, idle accessor, safety-net mapping

**Files:**
- Modify: `src/orcd/session.ts`
- Test: `src/orcd/__tests__/session-bgc.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/orcd/__tests__/session-bgc.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { OrcdSession } from '../session';
import type { OrcdMessage } from '../../shared/orcd-protocol';

function syntheticSubtypes(s: OrcdSession): string[] {
  const seen: string[] = [];
  s.subscribe((m: OrcdMessage) => {
    if (m.type === 'stream_event') {
      const e = m.event as { type?: string; subtype?: string };
      if (e.type === 'system' && e.subtype) seen.push(e.subtype);
    }
  });
  return seen;
}

describe('OrcdSession BGC event mapping', () => {
  it('maps Pi compaction_start/end to bgc_started/compact_boundary', () => {
    const s = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: 'idmap' });
    const seen = syntheticSubtypes(s);
    s['emitMappedPiEvent']({ type: 'compaction_start', reason: 'threshold' });
    s['emitMappedPiEvent']({ type: 'compaction_end', reason: 'threshold', result: { summary: 'x' } });
    expect(seen).toEqual(['bgc_started', 'compact_boundary']);
  });

  it('isIdle reflects the running flag', () => {
    const s = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: 'idle' });
    expect(s.isIdle()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run src/orcd/__tests__/session-bgc.test.ts`
Expected: FAIL — `compact_boundary`/`bgc_started` not emitted, and `s.isIdle is not a function`.

- [ ] **Step 3: Implement**

In `src/orcd/session.ts`:

(a) Map Pi compaction events. At the **top of `emitMappedPiEvent(event)`** (before the existing `const usage = ...` on line 249), add:
```ts
    if (this.isRecord(event) && event.type === 'compaction_start') {
      this.emitBgcStarted();
      return;
    }
    if (this.isRecord(event) && event.type === 'compaction_end') {
      // Pi's own auto-compaction (the ~92% safety net) finished — surface it so
      // the UI context wheel resets even when orcd's BGC didn't drive it.
      this.emitCompactBoundary();
      return;
    }
```
> These return early so Pi's raw compaction events are not also forwarded as ordinary stream events. orcd's *own* BGC apply does not emit these (it calls `appendCompaction` directly), so there is no double signal.

(b) Add an idle accessor. After `cancel()` / near `compact()` (around line 447), add:
```ts
  /** True when no turn is currently streaming — safe to splice a compaction. */
  isIdle(): boolean {
    return !this.running;
  }

  /** Run an out-of-band BGC summary. Parallel-safe; null = nothing to compact. */
  async prepareBgCompaction(keepFraction: number, signal: AbortSignal): Promise<import('@earendil-works/pi-coding-agent').CompactionResult | null> {
    const session = await this.getOrCreatePiSession(undefined);
    return session.prepareBgCompaction(keepFraction, this.lastContextTokens, signal);
  }

  /** Splice a prepared BGC compaction into the session tree. Call only when idle. */
  applyBgCompaction(result: import('@earendil-works/pi-coding-agent').CompactionResult): void {
    if (!this.piSession) return;
    this.piSession.applyBgCompaction(result);
    this.emitCompactBoundary();
  }
```
> `this.running` is the private flag already set in `run()`/`finalizeExit()`. `isRecord` is the existing private guard used elsewhere in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run src/orcd/__tests__/session-bgc.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `corepack pnpm typecheck`
```bash
git add src/orcd/session.ts src/orcd/__tests__/session-bgc.test.ts
git commit -m "feat(orcd): OrcdSession BGC delegation + Pi safety-net event mapping"
```

---

## Task 3: socket-server — BGC controller (parallel prepare → idle apply)

**Files:**
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/socket-server-compaction.test.ts` (rewrite the `background compaction` describe block)

This task replaces `triggerCompaction`, `applyPendingCompaction`, the `pendingSummaries` map, and the `onBeforeExit` apply hook with a parallel controller. The `compacting` guard, `bgcMap` wiring in the orc backend, and `exitedSessions`/`turnActive` tracking stay.

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('OrcdServer background compaction', ...)` block in `src/orcd/__tests__/socket-server-compaction.test.ts` with:
```ts
describe('OrcdServer background compaction', () => {
  function bgcSession(id: string) {
    const session = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: id });
    session.lastContextTokens = 130_000;
    session.lastContextWindow = 200_000;
    return session;
  }

  it('triggers parallel prepare at threshold and applies when idle', async () => {
    const server = createServer();
    const session = bgcSession('bgc-apply');
    server.store.add(session);
    server['attachLifecycleHooks'](session);

    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 9, details: undefined };
    const prepSpy = vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(result as never);
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(false);

    await server['maybeStartBgc'](session); // 130k/200k = 65% >= 60%

    expect(prepSpy).toHaveBeenCalledWith(0.5, expect.any(Object));
    expect(applySpy).toHaveBeenCalledWith(result);
  });

  it('skips apply when a compaction already landed (staleness guard)', async () => {
    const server = createServer();
    const session = bgcSession('bgc-stale');
    server.store.add(session);
    server['attachLifecycleHooks'](session);

    vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 9, details: undefined } as never);
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(true); // Pi safety net won

    await server['maybeStartBgc'](session);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('does not start a second BGC while one is in flight', async () => {
    const server = createServer();
    const session = bgcSession('bgc-guard');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const prepSpy = vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(null as never);

    await Promise.all([server['maybeStartBgc'](session), server['maybeStartBgc'](session)]);
    expect(prepSpy).toHaveBeenCalledTimes(1);
  });

  it('starts BGC from explicit compact action and emits bgc_started', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('bgc-manual');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const cb: SessionEventCallback = (m) => client.socket.write(JSON.stringify(m));
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 1, details: undefined } as never);
    vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(false);

    server['handleAction'](client as never, { action: 'compact', sessionId: session.id, cwd: '/tmp', provider: 'test', model: 'm' } as CompactAction);
    await new Promise((r) => setTimeout(r, 0));

    const wrote = client.socket.write.mock.calls.map((c) => String(c[0]));
    expect(wrote.some((w) => w.includes('bgc_started'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm vitest run src/orcd/__tests__/socket-server-compaction.test.ts`
Expected: FAIL — `server['maybeStartBgc'] is not a function`, `session.latestEntryIsCompaction is not a function`.

- [ ] **Step 3: Add `latestEntryIsCompaction` to OrcdSession and pi-runtime**

In `src/orcd/pi-runtime.ts`, add to the `PiRuntimeSession` interface:
```ts
  /** True when the newest entry on the branch is already a compaction. */
  latestEntryIsCompaction(): boolean;
```
and to the returned object:
```ts
    latestEntryIsCompaction() {
      const entries = session.sessionManager.getBranch();
      const last = entries[entries.length - 1];
      return !!last && (last as { type?: string }).type === 'compaction';
    },
```
In `src/orcd/session.ts`, add:
```ts
  /** True when the newest branch entry is already a compaction (Pi safety net beat us). */
  latestEntryIsCompaction(): boolean {
    return this.piSession?.latestEntryIsCompaction() ?? false;
  }
```

- [ ] **Step 4: Replace the controller in socket-server.ts**

Delete the `pendingSummaries` field (line ~21) and the `applyingSummaries` usage tied to the old defer (keep `compacting`, `exitedSessions`, `turnActive`). Remove `import { applyCompaction, type PreparedCompaction } from '../lib/session-compactor';` (line 5).

Replace `handleCompact` (so manual `/compact` uses the new path — see Task 4), and replace `triggerCompaction`/`applyPendingCompaction` with the controller below.

> **Implementation note (as shipped, `27be7c8`):** the busy-poll-for-idle shown
> below was replaced during review with an event-driven design — if the session
> isn't idle when the summary is ready, the result is stashed in a `pendingApply`
> map and spliced by a once-registered `onBeforeExit` hook at the next run-end.
> This avoids a mid-run `agent.state.messages` reassignment (a turn longer than
> the poll timeout would otherwise desync live vs. persisted context). The
> staleness check lives in a shared `applyBgcResult`. See the spec for the final
> mechanism.

```ts
  private readonly BGC_KEEP_FRACTION = 0.5;

  /**
   * Background compactor: summarize the oldest ~50% off-band (parallel-safe),
   * then splice a Pi-native compaction entry once the session is idle.
   */
  private async maybeStartBgc(session: OrcdSession): Promise<void> {
    const sid = session.id;
    if (this.compacting.has(sid)) return;
    this.compacting.add(sid);
    const controller = new AbortController();
    try {
      session.emitBgcStarted();
      const result = await session.prepareBgCompaction(this.BGC_KEEP_FRACTION, controller.signal);
      if (!result) {
        console.log(`[orcd:${sid.slice(0, 8)}:bgc] nothing to compact`);
        return;
      }
      // Apply only when idle; wait briefly for an in-flight turn to finish.
      for (let waited = 0; !session.isIdle() && waited < 60_000; waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (session.latestEntryIsCompaction()) {
        console.log(`[orcd:${sid.slice(0, 8)}:bgc] stale — a compaction already landed, skipping apply`);
        return;
      }
      session.applyBgCompaction(result);
      console.log(`[orcd:${sid.slice(0, 8)}:bgc] applied (tokensBefore=${result.tokensBefore})`);
    } catch (err) {
      console.error(`[orcd:${sid.slice(0, 8)}:bgc] failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      this.compacting.delete(sid);
    }
  }
```

Update the threshold check inside `attachLifecycleHooks` (the `context_usage` block, currently ~lines 449-471) to call the new controller:
```ts
      if (msg.type === 'context_usage') {
        if (
          session.summarizeThreshold > 0 &&
          msg.contextWindow > 0 &&
          !this.compacting.has(sid) &&
          msg.contextTokens / msg.contextWindow >= session.summarizeThreshold
        ) {
          const pct = ((msg.contextTokens / msg.contextWindow) * 100).toFixed(0);
          console.log(`[orcd:${sid.slice(0, 8)}:bgc] threshold hit (${pct}%), starting`);
          void this.maybeStartBgc(session);
        }
      }
```
Remove the now-unused `onBeforeExit` apply hook body that called `applyPendingCompaction` (delete that hook registration in `attachLifecycleHooks`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `corepack pnpm vitest run src/orcd/__tests__/socket-server-compaction.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `corepack pnpm typecheck`
```bash
git add src/orcd/socket-server.ts src/orcd/session.ts src/orcd/pi-runtime.ts src/orcd/__tests__/socket-server-compaction.test.ts
git commit -m "feat(orcd): parallel BGC controller (prepare off-band, apply when idle)"
```

---

## Task 4: Repoint manual `/compact` at the new mechanism

**Files:**
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/socket-server-compaction.test.ts` (the `rehydrates inactive persisted sessions` test already exercises `handleCompact`)

- [ ] **Step 1: Rewrite `handleCompact`**

`handleCompact` must still rehydrate an inactive persisted session (so `/compact` works after a restart), then run the BGC controller immediately instead of the old defer. Replace its body with:
```ts
  private handleCompact(client: ClientState, action: OrcdAction & { action: 'compact' }): void {
    let session = this.store.get(action.sessionId);
    const hydrated = !session;
    if (!session) {
      session = new OrcdSession({
        cwd: action.cwd,
        model: action.model,
        provider: action.provider,
        providerConfig: this.providers[action.provider],
        sessionId: action.sessionId,
        contextWindow: action.contextWindow,
        summarizeThreshold: action.summarizeThreshold,
      });
      session.state = 'completed';
      this.store.add(session);
      this.attachLifecycleHooks(session);
      console.log(`[orcd:${session.id.slice(0, 8)}:bgc] rehydrated inactive session for manual compact`);
    }
    if (!client.subscriptions.has(session.id)) {
      const cb: SessionEventCallback = (msg) => this.send(client, msg);
      client.subscriptions.set(session.id, cb);
      session.subscribe(cb);
    }
    void this.maybeStartBgc(session).finally(() => {
      if (hydrated) this.store.remove(session.id);
    });
  }
```
> A rehydrated session has `lastContextTokens === 0`, so `prepareBgCompaction` computes `keepRecentTokens = 0` → Pi keeps a minimal tail and summarizes the rest, which is the desired "compact everything now" behavior for a cold manual compact. (`prepareCompaction` returns `undefined` only when the session is too small / already compacted, handled as a no-op.)

The `beginCompaction` helper added earlier for `/compact` wiring is now folded into `maybeStartBgc`; delete `beginCompaction` if no other caller remains (grep first).

- [ ] **Step 2: Run the compaction test file**

Run: `corepack pnpm vitest run src/orcd/__tests__/socket-server-compaction.test.ts`
Expected: PASS (including `rehydrates inactive persisted sessions for explicit compact action`). Update that test's assertions if it still references the removed `pendingSummaries`/`preparedCall.compact()` API — it should now assert `prepareBgCompaction` was called.

- [ ] **Step 3: Typecheck + commit**

Run: `corepack pnpm typecheck`
```bash
git add src/orcd/socket-server.ts src/orcd/__tests__/socket-server-compaction.test.ts
git commit -m "feat(orcd): manual /compact routes through the BGC controller"
```

---

## Task 5: Delete dead Claude-era code

**Files:** see table. Verify zero importers before each `git rm`.

- [ ] **Step 1: Verify importers are gone**

Run:
```bash
grep -rn "session-compactor" src app scripts | grep -v "src/lib/session-compactor"
grep -rn "summarize-session\|summarizeSession" src app scripts | grep -v "src/lib/summarize-session"
grep -rn "AUTO_COMPACT_RATIO" src app scripts
grep -rn "import-claude-session\|importClaudeSession" src app scripts | grep -v "src/orcd/import-claude-session"
```
Expected: only the scripts slated for deletion (`scripts/summarize.ts`, `scripts/test-summarize.ts`) reference `summarize-session`; everything else returns nothing. If any *other* file still imports these, STOP and fix that caller first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/lib/session-compactor.ts src/lib/session-compactor.test.ts \
       src/lib/summarize-session.ts \
       scripts/summarize.ts scripts/test-summarize.ts \
       src/orcd/import-claude-session.ts
```
(Adjust if any listed file does not exist — confirm with `ls` first.)

- [ ] **Step 3: Remove `AUTO_COMPACT_RATIO`**

Edit `src/shared/constants.ts` — delete the `AUTO_COMPACT_RATIO` export and its doc comment. If the file becomes empty, `git rm` it and remove any import of it.

- [ ] **Step 4: Typecheck + lint + full test run**

Run: `corepack pnpm typecheck`
Expected: no errors (proves nothing referenced the deleted code).
Run: `corepack pnpm lint`
Expected: 0 warnings / 0 errors.
Run: `corepack pnpm vitest run src/orcd src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(orcd): remove dead Claude-era compaction/import code"
```

---

## Task 6: Integration verification (manual)

- [ ] **Step 1: Restart services**

```bash
sudo systemctl restart orcd.service && sleep 1 && sudo systemctl restart orchestrel.service
systemctl is-active orcd.service orchestrel.service   # both: active
```

- [ ] **Step 2: Drive a real session over 60%**

On a non-critical card, send prompts until `context_tokens / context_window ≥ 0.6`. In `journalctl -u orcd.service -f`, expect `[orcd:<id>:bgc] threshold hit` then `[orcd:<id>:bgc] applied`.

- [ ] **Step 3: Confirm the Pi-native artifact + UI**

```bash
# newest compaction entry should be fromHook=true and the file keeps full history
grep -c '"type":"compaction"' ~/.pi/agent/sessions/<slug>/<ts>_<sessionId>.jsonl
```
Confirm in the UI that the context wheel dropped after the BGC fired, and again if you let a session reach ~92% (Pi safety net → `compact_boundary` via the new mapping).

- [ ] **Step 4: Manual `/compact`**

Type `/compact` in the card chat. Expect `bgc_started` → a new `compaction` entry → wheel resets. No `"/compact"` text reply from the model.

---

## Self-review notes (already reconciled)

- **Spec coverage:** trigger threshold (Task 3), 50% keep via `keepRecentTokens` (Task 1), Pi-native `compaction` write + reload (Tasks 1–2), parallel prepare / idle apply / staleness guard (Task 3), safety-net `compaction_start/end` mapping (Task 2), manual `/compact` (Task 4), dead-code cleanup (Task 5), verification (Task 6).
- **Type consistency:** `prepareBgCompaction(keepFraction, currentTokens, signal)` on pi-runtime vs `prepareBgCompaction(keepFraction, signal)` on `OrcdSession` (the session supplies `currentTokens` from `lastContextTokens`); `applyBgCompaction(result)` and `latestEntryIsCompaction()` consistent across both layers; controller entry point `maybeStartBgc(session)` used by both the threshold hook and `handleCompact`.
- **No placeholders:** every code step shows the code; commands have expected output.
