# Context Wheel Persistence

## Problem

The context wheel (ContextGauge) shows 0% when a card is reopened or after app restart. Context values are never persisted to the DB — they only exist transiently in the client-side MobX store during a live session. Additionally, the client-side extraction from `result.usage` uses cumulative token counts that are inflated for multi-iteration turns.

### Root causes

1. **No publisher for `card:${cardId}:context` bus topic.** `subscriptions.ts` has a listener ready to forward context values to the client, but nothing in the codebase publishes to this topic. The `getContextUsage()` call that previously existed in a `consumer.ts` was lost during the refactor to `card-sessions.ts`.

2. **Context values never saved to the card in DB.** `card-sessions.ts` handles `result` events (incrementing `turnsCompleted`) but never writes `contextTokens` or `contextWindow`. The DB columns exist but are always 0.

3. **Client-side fallback is broken.** `session-store.ts` `ingestSdkMessage()` extracts from `result.usage.iterations?.at(-1)` — but `iterations` is always `[]` in the Agent SDK, so it falls back to cumulative top-level `result.usage` (wrong for multi-tool turns).

4. **Status request returns stale zeros.** `handleAgentStatus` reads `card.contextTokens` from DB → always 0. Client guards with `if (data.contextTokens > 0)` so it never overwrites its in-memory value with 0, but on fresh load there's no in-memory value either.

### Why it sometimes works

During a live session, `ingestSdkMessage()` extracts approximately-correct values from single-iteration `result` events. These live only in the client store and are lost on reload.

## Approach

Use the SDK's `Query.getContextUsage()` method in orcd after each `result` event. Broadcast via a new `context_usage` message type. The orc backend saves to DB and publishes to the existing bus topic. Remove the client-side `result.usage` extraction.

## Design

### 1. orcd protocol — new `context_usage` message

Add to `src/shared/orcd-protocol.ts`:

```ts
export interface ContextUsageMessage {
  type: 'context_usage';
  sessionId: string;
  contextTokens: number;
  contextWindow: number;
}
```

Add `ContextUsageMessage` to the `OrcdMessage` union type.

### 2. OrcdSession — emit context usage after result

In `src/orcd/session.ts`, after broadcasting the `result` message to subscribers (~line 131), call `getContextUsage()` on the active query and broadcast a `context_usage` message:

```ts
if (sdkEvent.type === 'result' && this.activeQuery) {
  try {
    const usage = await this.activeQuery.getContextUsage();
    const cuMsg: ContextUsageMessage = {
      type: 'context_usage',
      sessionId: this.id,
      contextTokens: usage.totalTokens,
      contextWindow: usage.rawMaxTokens,
    };
    for (const cb of this.subscribers) cb(cuMsg);
  } catch { /* query may have closed between result and this call */ }
}
```

**`rawMaxTokens` not `maxTokens`**: The SDK's `maxTokens` may reflect the effective window after auto-compact settings. The UI (`SessionView.tsx` line 206) applies `AUTO_COMPACT_RATIO` to `contextWindow` itself, so we must store the raw model limit to avoid double-applying the ratio.

Wrapped in try/catch because the query might close between the `result` event and the `getContextUsage()` call. Silent failure is fine — the wheel keeps its last known value.

### 3. card-sessions.ts — handle `context_usage`, save to DB, publish to bus

In `src/server/controllers/card-sessions.ts`, add a handler for the new message type inside `registerCardSession()`:

```ts
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
```

This is the missing link: saves to DB (so values survive restart) AND publishes to the bus topic (so the existing `subscriptions.ts` contextHandler forwards to the client in real-time).

### 4. Remove client-side result.usage extraction

In `app/stores/session-store.ts`, remove the `result.usage` extraction block from `ingestSdkMessage()` (lines 82-97). Context values now arrive exclusively via `handleAgentStatus` from the server.

### 5. Initial load path (already works, just needs data)

The existing path already handles this correctly once there's data in the DB:

1. `SessionView.tsx` calls `sessionStore.requestStatus(cardId)` on mount
2. Server `handleAgentStatus` reads `card.contextTokens` / `card.contextWindow` from DB
3. Client `handleAgentStatus` updates the store: `if (data.contextTokens > 0) s.contextTokens = data.contextTokens`
4. `SessionView.tsx` reads `session?.contextTokens || card?.contextTokens || 0`

No changes needed here — once context values are in the DB, this path works.

## Files changed

| File | Change |
|------|--------|
| `src/shared/orcd-protocol.ts` | Add `ContextUsageMessage` interface and to union |
| `src/orcd/session.ts` | Add `ContextUsageMessage` to `SessionEventCallback` type; call `getContextUsage()` after result, broadcast `context_usage` |
| `src/server/controllers/card-sessions.ts` | Handle `context_usage` msg: save to DB + publish to bus |
| `app/stores/session-store.ts` | Remove `result.usage` extraction from `ingestSdkMessage()` |

## Not changing

- `src/server/ws/subscriptions.ts` — the `contextHandler` already listens on `card:${cardId}:context` and forwards to the client. No changes needed.
- `src/server/ws/handlers/agents.ts` — `handleAgentStatus` already reads from DB. No changes needed.
- `app/components/SessionView.tsx` — already reads from session store with card fallback. No changes needed.
- `app/components/ContextGauge.tsx` — presentational only, no changes needed.
