# Context Wheel Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist context wheel values (tokens used / window size) to the database so the gauge survives card reopen and app restart.

**Architecture:** orcd calls `getContextUsage()` on the SDK Query after each `result` event and broadcasts a new `context_usage` message. The orc backend saves to the card in DB and publishes to the existing `card:${cardId}:context` bus topic. The client-side `result.usage` extraction is removed — context arrives exclusively via `agent:status` websocket events.

**Tech Stack:** TypeScript, Agent SDK (`@anthropic-ai/claude-agent-sdk`), TypeORM, Socket.IO, MobX

**Spec:** `docs/superpowers/specs/2026-04-12-context-wheel-persistence-design.md`

---

### Task 1: Add `ContextUsageMessage` to the orcd protocol

**Files:**

- Modify: `src/shared/orcd-protocol.ts:82-104`

- [ ] **Step 1: Add the `ContextUsageMessage` interface**

In `src/shared/orcd-protocol.ts`, add the new interface after `SessionExitMessage` (after line 87) and before `SessionListMessage`:

```ts
export interface ContextUsageMessage {
  type: 'context_usage';
  sessionId: string;
  contextTokens: number;
  contextWindow: number;
}
```

- [ ] **Step 2: Add `ContextUsageMessage` to the `OrcdMessage` union**

In the same file, add `ContextUsageMessage` to the union type. Change:

```ts
export type OrcdMessage =
  | SessionCreatedMessage
  | StreamEventMessage
  | SessionResultMessage
  | SessionErrorMessage
  | SessionExitMessage
  | SessionListMessage;
```

To:

```ts
export type OrcdMessage =
  | SessionCreatedMessage
  | StreamEventMessage
  | SessionResultMessage
  | SessionErrorMessage
  | SessionExitMessage
  | ContextUsageMessage
  | SessionListMessage;
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new errors (existing errors may be present).

- [ ] **Step 4: Commit**

```bash
git add src/shared/orcd-protocol.ts
git commit -m "feat: add ContextUsageMessage to orcd protocol"
```

---

### Task 2: Emit `context_usage` from OrcdSession after result events

**Files:**

- Modify: `src/orcd/session.ts:7-9,124-131`

- [ ] **Step 1: Update imports and `SessionEventCallback` type**

In `src/orcd/session.ts`, change line 7 from:

```ts
import type {
  StreamEventMessage,
  SessionErrorMessage,
  SessionResultMessage,
  SessionExitMessage,
} from '../shared/orcd-protocol';
```

To:

```ts
import type {
  StreamEventMessage,
  SessionErrorMessage,
  SessionResultMessage,
  SessionExitMessage,
  ContextUsageMessage,
} from '../shared/orcd-protocol';
```

And change line 9 from:

```ts
export type SessionEventCallback = (
  msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionExitMessage,
) => void;
```

To:

```ts
export type SessionEventCallback = (
  msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionExitMessage | ContextUsageMessage,
) => void;
```

- [ ] **Step 2: Add `getContextUsage()` call after result broadcast**

In `src/orcd/session.ts`, after the result broadcast block (after line 131: `for (const cb of this.subscribers) cb(msg);` inside the `if (sdkEvent.type === 'result')` branch), add the context usage fetch. Change:

```ts
        if (sdkEvent.type === 'result') {
          const msg: SessionResultMessage = {
            type: 'result',
            sessionId: this.id,
            eventIndex,
            result: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);
        } else {
```

To:

```ts
        if (sdkEvent.type === 'result') {
          const msg: SessionResultMessage = {
            type: 'result',
            sessionId: this.id,
            eventIndex,
            result: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);

          // Fetch accurate context usage from SDK after each turn
          if (this.activeQuery) {
            try {
              const usage = await this.activeQuery.getContextUsage();
              const cuMsg: ContextUsageMessage = {
                type: 'context_usage',
                sessionId: this.id,
                contextTokens: usage.totalTokens,
                contextWindow: usage.rawMaxTokens,
              };
              for (const cb of this.subscribers) cb(cuMsg);
            } catch {
              // Query may have closed between result and this call — safe to ignore
            }
          }
        } else {
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/orcd/session.ts
git commit -m "feat: emit context_usage from orcd after each result"
```

---

### Task 3: Handle `context_usage` in card-sessions — save to DB and publish to bus

**Files:**

- Modify: `src/server/controllers/card-sessions.ts:59-70`

- [ ] **Step 1: Add `context_usage` handler in `registerCardSession()`**

In `src/server/controllers/card-sessions.ts`, after the `result` handler block (after line 69: the closing `}` of the `if (msg.type === 'result')` block), add the new handler. Change:

```ts
    if (msg.type === 'result') {
      const result = msg.result as Record<string, unknown>;
      messageBus.publish(`card:${cardId}:sdk`, result);

      // Persist turn count (result = one turn done, but session may still be alive for background tasks)
      const card = await repo.findOneBy({ id: cardId });
      if (card) {
        card.turnsCompleted = (card.turnsCompleted ?? 0) + 1;
        card.updatedAt = new Date().toISOString();
        await repo.save(card);
      }
    }

    if (msg.type === 'error') {
```

To:

```ts
    if (msg.type === 'result') {
      const result = msg.result as Record<string, unknown>;
      messageBus.publish(`card:${cardId}:sdk`, result);

      // Persist turn count (result = one turn done, but session may still be alive for background tasks)
      const card = await repo.findOneBy({ id: cardId });
      if (card) {
        card.turnsCompleted = (card.turnsCompleted ?? 0) + 1;
        card.updatedAt = new Date().toISOString();
        await repo.save(card);
      }
    }

    if (msg.type === 'context_usage') {
      const card = await repo.findOneBy({ id: cardId });
      if (card) {
        card.contextTokens = msg.contextTokens;
        card.contextWindow = msg.contextWindow;
        card.updatedAt = new Date().toISOString();
        await repo.save(card);
      }
      messageBus.publish(`card:${cardId}:context`, {
        contextTokens: msg.contextTokens,
        contextWindow: msg.contextWindow,
      });
    }

    if (msg.type === 'error') {
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new errors. TypeScript narrows `msg` to `ContextUsageMessage` inside the `if` block, so `msg.contextTokens` and `msg.contextWindow` are typed correctly.

- [ ] **Step 3: Commit**

```bash
git add src/server/controllers/card-sessions.ts
git commit -m "feat: persist context usage to DB and publish to bus"
```

---

### Task 4: Remove client-side `result.usage` extraction

**Files:**

- Modify: `app/stores/session-store.ts:81-97`

- [ ] **Step 1: Remove the broken extraction block from `ingestSdkMessage()`**

In `app/stores/session-store.ts`, remove the context extraction block from `ingestSdkMessage()`. Change:

```ts
s.accumulator.handleMessage(sdkMsg);

// Extract context info from result messages
if (sdkMsg.type === 'result') {
  const r = sdkMsg as {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      iterations?: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }[];
    };
  };
  if (r.usage) {
    // Top-level usage is cumulative across all iterations in the turn.
    // Use the last iteration to get the actual current context window state.
    const last = r.usage.iterations?.at(-1);
    const u = last ?? r.usage;
    s.contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
}
```

To:

```ts
s.accumulator.handleMessage(sdkMsg);
```

Context values now arrive exclusively via `handleAgentStatus` from the server's `card:${cardId}:context` bus topic → `subscriptions.ts` contextHandler → socket `agent:status` event.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new errors.

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run 2>&1 | tail -20`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/stores/session-store.ts
git commit -m "fix: remove broken client-side context extraction

Context values now arrive from the server via agent:status events,
using the SDK's getContextUsage() for accurate values that persist
across card reopen and app restart."
```

---

### Task 5: Manual verification

- [ ] **Step 1: Build check**

Run: `pnpm build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 2: Restart services**

Run: `sudo systemctl restart orchestrel`

- [ ] **Step 3: Verify live context updates**

Open `http://localhost:6194`. Send a message to a card in the running column. After the turn completes, the context wheel should show a non-zero percentage.

- [ ] **Step 4: Verify persistence on card reopen**

Click away from the card, then click back. The context wheel should still show the same percentage (loaded from DB via `requestStatus` → `handleAgentStatus`).

- [ ] **Step 5: Verify persistence on app restart**

Run: `sudo systemctl restart orchestrel`
Reload the page. Open a card that previously had a session. The context wheel should show the last known percentage.
