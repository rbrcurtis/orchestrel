# Turn-Complete Card Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cards out of `running` when the agent turn is complete while keeping live background sessions alive and independently manageable.

**Architecture:** Add a new `turn_complete` orcd protocol message emitted on SDK `result`. The server handles `turn_complete` as board workflow state (`running` → `review`) and keeps `session_exit` as runtime lifecycle. Manual card movement no longer cancels live sessions; explicit stop remains the process-control path.

**Tech Stack:** TypeScript, Vitest, TypeORM entities, internal orcd socket protocol, Claude Agent SDK event stream.

---

## File Structure

- Modify `src/shared/orcd-protocol.ts`
  - Add `TurnCompleteMessage` to the orcd → client protocol union.

- Modify `src/orcd/session.ts`
  - Include `TurnCompleteMessage` in `SessionEventCallback`.
  - Emit `turn_complete` immediately after each SDK `result`, with `hasPendingAsyncTasks` from `AsyncTaskTracker.hasPending()`.
  - Keep existing `result`, async-task wait, and `session_exit` behavior unchanged.

- Modify `src/orcd/__tests__/session-async-tasks.test.ts`
  - Assert `turn_complete` arrives before delayed `session_exit` when async/background tasks are pending.
  - Assert `turn_complete.hasPendingAsyncTasks` is `false` for ordinary foreground turns.

- Modify `src/server/controllers/card-sessions.ts`
  - Track which sessions completed a turn with pending async/background tasks.
  - Route `turn_complete` messages to cards.
  - Move `running` cards to `review` on `turn_complete` without untracking or canceling sessions.
  - On `session_exit`, move non-archive cards to `ready` only when the previous `turn_complete` reported pending async/background work and the card is no longer in `running`.
  - Remove the implicit cancel-on-leaving-`running` behavior from `registerAutoStart`.
  - Preserve explicit cancel via `handleAgentStop`.

- Modify `src/server/controllers/card-sessions.test.ts`
  - Add router tests for `turn_complete` card movement and pending-background exit behavior.
  - Add board listener tests proving card movement does not cancel sessions and moving into `running` with an active session does not duplicate-start.

- Modify `src/server/ws/handlers/agents.ts`
  - No required behavior change. Verify explicit stop still calls `client.cancel()`.

- Modify `src/server/ws/handlers/agents.test.ts`
  - Keep existing status/stop behavior covered. Add an explicit stop test only if not already covered elsewhere after Task 4.

---

## Task 1: Add the `turn_complete` protocol event

**Files:**
- Modify: `src/shared/orcd-protocol.ts`
- Modify: `src/orcd/session.ts`
- Test: `src/orcd/__tests__/session-async-tasks.test.ts`

- [ ] **Step 1: Write the failing foreground-turn test**

Add this test near the start of `describe('OrcdSession async Agent lifecycle', ...)` in `src/orcd/__tests__/session-async-tasks.test.ts`, after the existing SDK options tests:

```ts
  it('emits turn_complete with no pending async tasks for an ordinary foreground turn', async () => {
    events.push({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      modelUsage: { test: { contextWindow: 200000 } },
    });

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-foreground-turn',
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({ prompt: 'go' });

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'result',
      sessionId: 'session-foreground-turn',
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'turn_complete',
      sessionId: 'session-foreground-turn',
      hasPendingAsyncTasks: false,
    }));
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts -t 'emits turn_complete with no pending async tasks'
```

Expected: FAIL because no message with `type: 'turn_complete'` exists yet.

- [ ] **Step 3: Add protocol type**

In `src/shared/orcd-protocol.ts`, insert this interface after `SessionResultMessage`:

```ts
export interface TurnCompleteMessage {
  type: 'turn_complete';
  sessionId: string;
  eventIndex: number;
  hasPendingAsyncTasks: boolean;
}
```

Then add `TurnCompleteMessage` to the `OrcdMessage` union:

```ts
export type OrcdMessage =
  | SessionCreatedMessage
  | StreamEventMessage
  | SessionResultMessage
  | TurnCompleteMessage
  | SessionErrorMessage
  | SessionExitMessage
  | ContextUsageMessage
  | SessionIdUpdateMessage
  | SessionListMessage;
```

- [ ] **Step 4: Emit `turn_complete` from `OrcdSession`**

In `src/orcd/session.ts`, update the imports/types so `TurnCompleteMessage` is included:

```ts
import type {
  ContextUsageMessage,
  SessionErrorMessage,
  SessionExitMessage,
  SessionIdUpdateMessage,
  SessionResultMessage,
  StreamEventMessage,
  TurnCompleteMessage,
} from '../shared/orcd-protocol';
```

Update `SessionEventCallback`:

```ts
export type SessionEventCallback = (
  msg: StreamEventMessage | SessionResultMessage | TurnCompleteMessage | SessionErrorMessage | SessionExitMessage | ContextUsageMessage | SessionIdUpdateMessage,
) => void;
```

Inside the `if (sdkRecord?.type === 'result')` block, immediately after broadcasting the existing `result` message, add:

```ts
          const turnMsg: TurnCompleteMessage = {
            type: 'turn_complete',
            sessionId: this.id,
            eventIndex,
            hasPendingAsyncTasks: this.asyncTasks.hasPending(),
          };
          for (const cb of this.subscribers) cb(turnMsg);
```

The result block should still publish the original `result` message first, then `turn_complete`, then continue updating context usage as before.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts -t 'emits turn_complete with no pending async tasks'
```

Expected: PASS.

- [ ] **Step 6: Write the pending-async turn test**

In `src/orcd/__tests__/session-async-tasks.test.ts`, update the existing test named `delays session_exit until async task notification appears in JSONL` by adding this assertion after the existing `await vi.waitFor(() => expect(received).toContain('result'));` line:

```ts
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'turn_complete',
        sessionId: 'session',
        hasPendingAsyncTasks: true,
      }));
```

Also add this ordering assertion before the final `expect(received.at(-1)).toBe('session_exit');`:

```ts
      expect(received.indexOf('turn_complete')).toBeGreaterThan(received.indexOf('result'));
      expect(received.indexOf('turn_complete')).toBeLessThan(received.indexOf('session_exit'));
```

- [ ] **Step 7: Run async lifecycle tests**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: PASS. Existing tests that assert `session_exit` is delayed must still pass.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add src/shared/orcd-protocol.ts src/orcd/session.ts src/orcd/__tests__/session-async-tasks.test.ts
git commit -m "feat: emit turn complete lifecycle event"
```

---

## Task 2: Move running cards to review on `turn_complete`

**Files:**
- Modify: `src/server/controllers/card-sessions.ts`
- Test: `src/server/controllers/card-sessions.test.ts`

- [ ] **Step 1: Write the failing router test**

Add this test to `describe('orcd message router', ...)` in `src/server/controllers/card-sessions.test.ts`, after the `routes session_exit...` test:

```ts
  it('moves running cards to review on turn_complete without untracking the live session', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);
    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 9,
      hasPendingAsyncTasks: true,
    });

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).toHaveBeenCalledWith(mockCards[0]);
    expect(sdkSpy).toHaveBeenCalledWith({
      type: 'turn_complete',
      session_id: 'sess-abc',
      has_pending_async_tasks: true,
    });

    sdkSpy.mockClear();
    await handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 10,
      event: { type: 'assistant', message: 'still routed after turn complete' },
    });

    expect(sdkSpy).toHaveBeenCalledWith({ type: 'assistant', message: 'still routed after turn complete' });
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'moves running cards to review on turn_complete'
```

Expected: FAIL because `turn_complete` is not handled by the router yet.

- [ ] **Step 3: Add pending-background tracking and handler helpers**

In `src/server/controllers/card-sessions.ts`, add a map next to `sessionCardMap` and `bgcMap`:

```ts
const pendingAsyncAfterTurnComplete = new Map<string, boolean>();
```

Add this helper above `handleSessionExit`:

```ts
async function handleTurnComplete(
  cardId: number,
  sessionId: string,
  hasPendingAsyncTasks: boolean,
  bus: MessageBus = messageBus,
): Promise<void> {
  pendingAsyncAfterTurnComplete.set(sessionId, hasPendingAsyncTasks);

  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });
  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  bus.publish(`card:${cardId}:sdk`, {
    type: 'turn_complete',
    session_id: sessionId,
    has_pending_async_tasks: hasPendingAsyncTasks,
  });
}
```

- [ ] **Step 4: Route `turn_complete` messages**

In the `client.onMessage` callback in `src/server/controllers/card-sessions.ts`, update the fallback DB lookup condition from:

```ts
    if (cardId == null && msg.type === 'session_exit') {
```

to:

```ts
    if (cardId == null && (msg.type === 'session_exit' || msg.type === 'turn_complete')) {
```

Then add this block before the existing `if (msg.type === 'context_usage')` block:

```ts
    if (msg.type === 'turn_complete') {
      await handleTurnComplete(cardId, msg.sessionId, msg.hasPendingAsyncTasks, bus);
    }
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'moves running cards to review on turn_complete'
```

Expected: PASS.

- [ ] **Step 6: Run router tests**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add src/server/controllers/card-sessions.ts src/server/controllers/card-sessions.test.ts
git commit -m "feat: move cards to review on turn complete"
```

---

## Task 3: Move non-archive cards to ready when pending background work exits

**Files:**
- Modify: `src/server/controllers/card-sessions.ts`
- Test: `src/server/controllers/card-sessions.test.ts`

- [ ] **Step 1: Write failing test for non-archive card moved to ready**

Add this test to `describe('orcd message router', ...)` in `src/server/controllers/card-sessions.test.ts`:

```ts
  it('moves non-archive cards to ready on session_exit after a pending-background turn completed', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 3,
      hasPendingAsyncTasks: true,
    });
    expect(mockCards[0].column).toBe('review');

    mockCards[0].column = 'done';
    mockRepo.save.mockClear();

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('ready');
    expect(mockRepo.save).toHaveBeenCalledWith(mockCards[0]);
  });
```

- [ ] **Step 2: Write failing archive protection test**

Add this test to the same describe block:

```ts
  it('leaves archived cards archived when pending-background sessions exit', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 3,
      hasPendingAsyncTasks: true,
    });

    mockCards[0].column = 'archive';
    mockRepo.save.mockClear();

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('archive');
    expect(mockRepo.save).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Write foreground-exit non-bounce test**

Add this test to the same describe block:

```ts
  it('does not move non-running cards to ready on ordinary foreground session_exit', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 3,
      hasPendingAsyncTasks: false,
    });

    expect(mockCards[0].column).toBe('review');
    mockRepo.save.mockClear();

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Run focused tests and verify at least one fails**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'pending-background|ordinary foreground'
```

Expected: FAIL for the ready/archive behavior because `handleSessionExit` does not yet use `pendingAsyncAfterTurnComplete`.

- [ ] **Step 5: Update `handleSessionExit`**

Change the signature in `src/server/controllers/card-sessions.ts` from:

```ts
async function handleSessionExit(
  cardId: number,
  status: 'completed' | 'errored' | 'stopped',
  bus: MessageBus = messageBus,
): Promise<void> {
```

to:

```ts
async function handleSessionExit(
  cardId: number,
  sessionId: string,
  status: 'completed' | 'errored' | 'stopped',
  bus: MessageBus = messageBus,
): Promise<void> {
```

Replace the column update block with:

```ts
  const hadPendingAsyncAfterTurn = pendingAsyncAfterTurnComplete.get(sessionId) === true;
  pendingAsyncAfterTurnComplete.delete(sessionId);

  if (card && status !== 'errored') {
    if (card.column === 'running') {
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await repo.save(card);
    } else if (hadPendingAsyncAfterTurn && card.column !== 'archive') {
      card.column = 'ready';
      card.updatedAt = new Date().toISOString();
      await repo.save(card);
    }
  }
```

Update the call site from:

```ts
      await handleSessionExit(cardId, msg.state, bus);
```

to:

```ts
      await handleSessionExit(cardId, msg.sessionId, msg.state, bus);
```

- [ ] **Step 6: Transfer pending-background state on session fork**

In the `session_id_update` block in `src/server/controllers/card-sessions.ts`, after the existing `bgcMap` transfer, add:

```ts
      if (pendingAsyncAfterTurnComplete.has(msg.sessionId)) {
        pendingAsyncAfterTurnComplete.set(msg.newSessionId, pendingAsyncAfterTurnComplete.get(msg.sessionId) === true);
        pendingAsyncAfterTurnComplete.delete(msg.sessionId);
      }
```

- [ ] **Step 7: Run focused tests and verify they pass**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'pending-background|ordinary foreground'
```

Expected: PASS.

- [ ] **Step 8: Run router tests**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

Run:

```bash
git add src/server/controllers/card-sessions.ts src/server/controllers/card-sessions.test.ts
git commit -m "feat: surface completed background sessions as ready cards"
```

---

## Task 4: Decouple manual card movement from session cancellation

**Files:**
- Modify: `src/server/controllers/card-sessions.ts`
- Test: `src/server/controllers/card-sessions.test.ts`

- [ ] **Step 1: Mock init-state in `card-sessions.test.ts`**

At the top of `src/server/controllers/card-sessions.test.ts`, near the existing mocks, add these hoisted mocks:

```ts
const mockGetOrcdClient = vi.hoisted(() => vi.fn());
const mockCancel = vi.hoisted(() => vi.fn());
const mockIsActive = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
```

Then add this mock after the existing `vi.mock('../sessions/worktree', ...)` block:

```ts
vi.mock('../init-state', () => ({
  getOrcdClient: mockGetOrcdClient,
}));
```

In the top-level `beforeEach` inside `describe('orcd message router', ...)`, reset them:

```ts
    mockCancel.mockReset();
    mockIsActive.mockReset();
    mockCreate.mockReset();
    mockGetOrcdClient.mockReset();
    mockGetOrcdClient.mockReturnValue({
      cancel: mockCancel,
      isActive: mockIsActive,
      create: mockCreate,
    });
```

- [ ] **Step 2: Write failing test that moving out of running does not cancel**

Add a new `describe('registerAutoStart', ...)` block after the router describe block and before `describe('reconcileRunningCards', ...)`:

```ts
describe('registerAutoStart', () => {
  beforeEach(() => {
    mockCancel.mockReset();
    mockIsActive.mockReset();
    mockCreate.mockReset();
    mockGetOrcdClient.mockReset();
    mockGetOrcdClient.mockReturnValue({
      cancel: mockCancel,
      isActive: mockIsActive,
      create: mockCreate,
    });
  });

  it('does not cancel a live session when a card leaves running', async () => {
    const { registerAutoStart } = await import('./card-sessions');
    const localBus = new MessageBus();
    registerAutoStart(localBus);

    localBus.publish('board:changed', {
      card: { ...mockCards[0], id: 42, sessionId: 'sess-abc' },
      oldColumn: 'running',
      newColumn: 'review',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockCancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'does not cancel a live session when a card leaves running'
```

Expected: FAIL because `registerAutoStart` currently calls `client.cancel(card.sessionId)` when old column is `running` and new column is not `running`.

- [ ] **Step 4: Remove implicit cancel from `registerAutoStart`**

In `src/server/controllers/card-sessions.ts`, delete this block from `registerAutoStart`:

```ts
    // Card left running: cancel session
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (card.sessionId) {
        client?.cancel(card.sessionId);
      }
    }
```

Do not replace it with anything. Explicit cancellation remains in `handleAgentStop`.

- [ ] **Step 5: Run focused test and verify it passes**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'does not cancel a live session when a card leaves running'
```

Expected: PASS.

- [ ] **Step 6: Write no-duplicate-start test for moving into running with a live session**

Add this test inside `describe('registerAutoStart', ...)`:

```ts
  it('does not start a duplicate session when a card enters running with a live session', async () => {
    const { registerAutoStart } = await import('./card-sessions');
    const localBus = new MessageBus();
    registerAutoStart(localBus);

    mockCards[0].column = 'running';
    mockCards[0].sessionId = 'sess-abc';
    mockIsActive.mockReturnValue(true);

    localBus.publish('board:changed', {
      card: { ...mockCards[0], id: 42, sessionId: 'sess-abc' },
      oldColumn: 'review',
      newColumn: 'running',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockIsActive).toHaveBeenCalledWith('sess-abc');
    expect(mockCreate).not.toHaveBeenCalled();
  });
```

- [ ] **Step 7: Write start test for moving into running without a live session**

Add this test inside `describe('registerAutoStart', ...)`:

```ts
  it('starts a session when a card enters running without a live session', async () => {
    const { registerAutoStart } = await import('./card-sessions');
    const localBus = new MessageBus();
    registerAutoStart(localBus);

    mockCards[0].column = 'running';
    mockCards[0].sessionId = null;
    mockCreate.mockResolvedValue('sess-new');

    localBus.publish('board:changed', {
      card: { ...mockCards[0], id: 42, sessionId: null, worktreeBranch: 'branch-42', projectId: 1 },
      oldColumn: 'review',
      newColumn: 'running',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreate).toHaveBeenCalledWith({
      prompt: '',
      cwd: '/tmp/project/.worktrees/card-42',
      provider: 'anthropic',
      model: 'sonnet',
      sessionId: undefined,
      contextWindow: 200000,
      summarizeThreshold: 0.6,
    });
    expect(mockCards[0].sessionId).toBe('sess-new');
  });
```

- [ ] **Step 8: Run registerAutoStart tests**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts -t 'registerAutoStart'
```

Expected: PASS.

- [ ] **Step 9: Run card session tests**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

Run:

```bash
git add src/server/controllers/card-sessions.ts src/server/controllers/card-sessions.test.ts
git commit -m "fix: stop canceling sessions on card movement"
```

---

## Task 5: Verify explicit stop and status semantics

**Files:**
- Modify if needed: `src/server/ws/handlers/agents.test.ts`
- Verify: `src/server/ws/handlers/agents.ts`

- [ ] **Step 1: Add explicit stop test if missing**

In `src/server/ws/handlers/agents.test.ts`, add `mockCancel` to the existing mock setup:

```ts
const mockCancel = vi.fn();
```

Update the `vi.mock('../../init-state', ...)` return value:

```ts
vi.mock('../../init-state', () => ({
  getOrcdClient: () => ({
    compact: mockCompact,
    isActive: mockIsActive,
    cancel: mockCancel,
  }),
}));
```

Reset it in both `beforeEach` blocks:

```ts
    mockCancel.mockReset();
```

Add this test after `describe('handleAgentCompact', ...)`:

```ts
describe('handleAgentStop', () => {
  beforeEach(() => {
    mockCancel.mockReset();
    mockFindOneBy.mockReset();
  });

  it('explicitly cancels the live session for a card', async () => {
    const { handleAgentStop } = await import('./agents');
    const callback = vi.fn();
    mockFindOneBy.mockResolvedValue({
      id: 42,
      sessionId: 'sess-abc',
    });

    await handleAgentStop({ cardId: 42 }, callback);

    expect(callback).toHaveBeenCalledWith({});
    expect(mockCancel).toHaveBeenCalledWith('sess-abc');
  });
});
```

- [ ] **Step 2: Run stop/status tests**

Run:

```bash
pnpm test src/server/ws/handlers/agents.test.ts
```

Expected: PASS. `handleAgentStatus` should still report active live sessions as `running` even when their card column is not `running`.

- [ ] **Step 3: Commit Task 5 if the test file changed**

If Step 1 changed the test file, run:

```bash
git add src/server/ws/handlers/agents.test.ts
git commit -m "test: cover explicit agent stop cancellation"
```

If the explicit stop behavior is already covered after inspection, do not commit anything for this task.

---

## Task 6: Final verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run focused lifecycle tests**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts src/server/controllers/card-sessions.test.ts src/server/ws/handlers/agents.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
pnpm lint
```

Expected: `Found 0 warnings and 0 errors.`

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Run build**

Run:

```bash
pnpm build
```

Expected: PASS and production build output under `build/client/`.

- [ ] **Step 5: Commit any verification-only fixes**

If lint/typecheck/build required fixes, commit them:

```bash
git add <fixed-files>
git commit -m "fix: polish turn-complete lifecycle implementation"
```

If no files changed, skip this step.

---

## Self-Review

- Spec coverage:
  - `turn_complete` protocol event: Task 1.
  - `running` → `review` on turn completion without killing session: Task 2.
  - background completion moves non-archive cards to `ready`: Task 3.
  - archive is terminal for automatic moves: Task 3.
  - board movement no longer cancels sessions: Task 4.
  - moving to `running` with live session does nothing: Task 4.
  - explicit stop remains process control: Task 5.
  - verification: Task 6.

- Placeholder scan: no TBD/TODO/fill-in placeholders remain. Every code-changing step includes concrete code.

- Type consistency:
  - Protocol field is `hasPendingAsyncTasks` in TypeScript orcd messages.
  - Synthetic SDK event field is `has_pending_async_tasks` for frontend-style message payload consistency.
  - Session IDs are consistently `sessionId` in protocol messages and `session_id` only in synthetic SDK-style payloads.
