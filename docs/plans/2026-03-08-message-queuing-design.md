# Message Queuing via SDK `streamInput`

## Problem

When a user sends a follow-up message while Claude is actively processing, the current behavior interrupts the running query and starts a new one. This loses Claude's in-progress work. Claude Code queues the message and delivers it at the next turn boundary — we should match that behavior.

## Solution

Use the SDK's stable V1 `query.streamInput(asyncIterable)` method. This accepts an `AsyncIterable<SDKUserMessage>` that the SDK consumes at turn boundaries, exactly like Claude Code's queued message behavior.

## Design

### New members on `ClaudeSession`

- `inputQueue: SDKUserMessage[]` — pending messages waiting for SDK pickup
- `inputWake: (() => void) | null` — resolves when a message is pushed, unblocking the async generator

### `createInputStream()` — new private method

Returns an `AsyncGenerator<SDKUserMessage>` that:
1. Yields any messages already in `inputQueue`
2. When empty, awaits a Promise that resolves when `inputWake()` is called
3. Loops forever (generator lifetime = query lifetime)

### `start()` changes

After creating the query instance, fire-and-forget `streamInput`:
```ts
this.queryInstance.streamInput(this.createInputStream());
```

### `sendUserMessage()` changes

**When query is running** (`queryInstance` exists):
- Buffer/persist/emit the user message (unchanged)
- Build an `SDKUserMessage` and push onto `inputQueue`
- Call `inputWake()` to unblock the generator
- No interrupt, no new query

**When query is idle** (`queryInstance` is null — Claude finished):
- Buffer/persist/emit the user message (unchanged)
- Start a new query via `runQuery()` with resume ID (current behavior)
- Wire up `streamInput` on the new query

### `SDKUserMessage` shape

```ts
{
  type: 'user',
  message: { role: 'user', content: string },
  parent_tool_use_id: null,
  session_id: string
}
```

### UI changes

None required. The existing optimistic rendering and subscription streaming work as-is. The only behavioral change is that messages queue instead of interrupting.

### Edge cases

- **Multiple queued messages**: All pushed to `inputQueue`, SDK consumes them in order at each turn boundary
- **Session kill**: `kill()` still aborts — the async generator will terminate when the query closes
- **Query errors**: `consumeMessages()` catch block unchanged — generator cleanup is automatic
