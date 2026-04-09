# Switch SessionManager to Streaming Input Mode

## Problem

The Claude Agent SDK `query()` is currently called with `prompt: string`. This causes three issues:

1. **`interrupt()` silently fails** on the initial prompt — it only works in streaming input mode. The stop button does nothing until after the first turn completes.
2. **No token-by-token streaming** — we get complete `assistant` blocks instead of incremental `stream_event` deltas, likely because streaming input mode is required for true delta streaming.
3. **Follow-ups use a separate mechanism** — `streamInput()` is a bolt-on rather than the same bidirectional channel used for the initial prompt.

## Solution

Replace `prompt: string` with `prompt: AsyncIterable<SDKUserMessage>` to enter streaming input mode. Use a push-based async channel so the initial prompt, follow-ups, and session teardown all flow through a single mechanism.

## Design

### Prompt Channel (`src/server/sessions/prompt-channel.ts`)

A factory function `createPromptChannel()` returns:

- **`push(msg: SDKUserMessage): void`** — enqueues a message. If the iterator is awaiting, resolves immediately. Otherwise buffers.
- **`close(): void`** — terminates the iterable. Any pending `next()` resolves with `done: true`.
- **`iterator: AsyncIterableIterator<SDKUserMessage>`** — passed to `query({ prompt: iterator })`.

All state is closure-local (queue array, pending resolve, done flag). No module-level variables. This ensures HMR safety — the closures survive because they're reachable from `ActiveSession` objects stored in the `init-state.ts` singleton.

~25 lines. Helper to build an `SDKUserMessage` from a text string:

```typescript
function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}
```

### SessionManager.start() changes

1. Create a prompt channel via `createPromptChannel()`
2. Push the initial prompt as `userMessage(prompt)` into the channel
3. Pass `channel.iterator` as `prompt` to `query()`
4. Store `pushMessage` and `closeInput` on the `ActiveSession`

### SessionManager.sendFollowUp() changes

Replace `streamInput()` call with `session.pushMessage(userMessage(message))`. Same effect, same channel.

### SessionManager.stop() changes

1. Call `interrupt()` (now works in streaming input mode)
2. Set a 5-second timeout
3. If session hasn't exited by timeout, call `query.close()` as hard kill
4. Call `closeInput()` to terminate the prompt channel

### ActiveSession type changes

Add two fields:

```typescript
pushMessage: (msg: SDKUserMessage) => void;
closeInput: () => void;
```

No AbortController needed — `interrupt()` + `close()` fallback covers stop, and the prompt channel's `close()` handles input teardown.

### consumer.ts

No changes needed. The `for await (const msg of session.query)` loop works identically regardless of whether the SDK was started with a string prompt or an async iterable.

### HMR Safety

The prompt channel is safe across Vite dev server restarts because:

- `createPromptChannel()` is a stateless factory — module reload doesn't matter
- Channel instances (closures) are stored on `ActiveSession` properties
- `ActiveSession` lives in `SessionManager.sessions` Map in `init-state.ts` (dynamically imported)
- The `iterator` reference is held by the SDK `query()` process
- The running `consumeSession()` async task is unaffected by module re-evaluation

No module-level state is introduced.

## Files Changed

| File | Change |
|------|--------|
| `src/server/sessions/prompt-channel.ts` | New file: `createPromptChannel()`, `userMessage()` |
| `src/server/sessions/manager.ts` | `start()`: use channel + iterator. `sendFollowUp()`: use `pushMessage()`. `stop()`: add `close()` timeout fallback + `closeInput()`. |
| `src/server/sessions/types.ts` | Add `pushMessage` and `closeInput` to `ActiveSession` |

## Verification

After the change, confirm:
1. Stop button works during initial prompt (not just after first turn)
2. `stream_event` messages with token-by-token deltas arrive in the consumer
3. Follow-ups still work correctly
4. HMR restart doesn't break active sessions
