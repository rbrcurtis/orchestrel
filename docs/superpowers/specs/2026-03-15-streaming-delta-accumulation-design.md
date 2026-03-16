# Streaming Delta Accumulation

## Problem

OpenCode SSE emits `text` and `thinking` events as small deltas (token-by-token). The OC TUI streams these live. Dispatcher's SessionStore pushes each delta as a separate conversation row, so the UI shows one big block when thinking finishes rather than streaming content as it arrives.

## Solution

Accumulate `text` and `thinking` deltas into a single growing conversation row in SessionStore. Use MobX deep observability so direct property mutation triggers re-renders.

## Changes

### SessionState (session-store.ts)

Add two fields:
- `activeTextIdx: number | null` — index of the current open text block
- `activeThinkingIdx: number | null` — index of the current open thinking block

Change conversation array initialization:
```ts
conversation: observable.array([], { deep: true })
```

This makes all row properties deeply observable, so `row.content += delta` inside `runInAction` triggers MobX reactivity without splice or replacement.

### ingest() logic

For `text` and `thinking` messages:
1. If an active block of that type exists, append `msg.content` to the existing row's content via direct mutation.
2. If no active block, push a new row and record its index as the active block.

Block-closing events reset both active indices to null:
- `turn_end`
- `tool_call`
- `user`
- `error`
- `system` (with subtype `init`)

### clearConversation()

Reset `activeTextIdx` and `activeThinkingIdx` to null.

### What doesn't change

- **Server**: OC controller, bus, SSE normalization — all unchanged
- **Protocol**: `agent:message` WS messages — unchanged
- **Components**: MessageBlock, ThinkingBlock, TextBlock — unchanged (they already render from `message.content`)
- **ingestBatch()**: History loads complete blocks, no accumulation needed

## Edge cases

- History load via `ingestBatch()` is unaffected — it prepends complete rows, never hits the accumulation path.
- Tool call dedup via `toolCallIdxMap` is unaffected — accumulation only applies to `text`/`thinking`, not `tool_call`.
- Subagent messages return early before accumulation logic runs.
