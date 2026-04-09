# Streaming Input Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch SessionManager from `prompt: string` to `prompt: AsyncIterable<SDKUserMessage>` so that interrupt, token-by-token streaming, and follow-ups all work through a single bidirectional channel.

**Architecture:** A push-based async channel wraps the initial prompt and follow-ups into a single `AsyncIterable<SDKUserMessage>` passed to the SDK's `query()`. The channel's `push`/`close` functions are stored on `ActiveSession` for use by `sendFollowUp()` and `stop()`.

**Tech Stack:** TypeScript, @anthropic-ai/claude-agent-sdk

**Spec:** `docs/superpowers/specs/2026-04-08-streaming-input-mode-design.md`

---

### Task 1: Create prompt channel

**Files:**
- Create: `src/server/sessions/prompt-channel.ts`

- [ ] **Step 1: Create `prompt-channel.ts`**

```typescript
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface PromptChannel {
  push: (msg: SDKUserMessage) => void;
  close: () => void;
  iterator: AsyncIterableIterator<SDKUserMessage>;
}

export function createPromptChannel(): PromptChannel {
  let resolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  const pending: SDKUserMessage[] = [];
  let done = false;

  const push = (msg: SDKUserMessage) => {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: msg, done: false });
    } else {
      pending.push(msg);
    }
  };

  const close = () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: undefined as never, done: true });
    }
  };

  const iterator: AsyncIterableIterator<SDKUserMessage> = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (pending.length > 0) {
        return Promise.resolve({ value: pending.shift()!, done: false as const });
      }
      if (done) {
        return Promise.resolve({ value: undefined as never, done: true as const });
      }
      return new Promise((r) => { resolve = r; });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined as never, done: true as const });
    },
  };

  return { push, close, iterator };
}

export function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ryan/Code/orchestrel/.worktrees/switch-sessionmanager-to-streaming-input-mode && npx tsc --noEmit src/server/sessions/prompt-channel.ts 2>&1 | head -20`

If `SDKUserMessage` is not directly importable as a type (it's a `declare type`), check the SDK exports. It may need to be imported from a subpath or the type might be called something else. The existing `sendFollowUp()` in `manager.ts:79-86` shows the shape — worst case, define a local type alias that matches.

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/prompt-channel.ts
git commit -m "feat: add prompt channel for streaming input mode"
```

---

### Task 2: Add `pushMessage`, `closeInput`, `stopTimeout` to ActiveSession

**Files:**
- Modify: `src/server/sessions/types.ts`

- [ ] **Step 1: Update `ActiveSession` interface**

In `src/server/sessions/types.ts`, add the import and three new fields:

```typescript
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
```

Add to the `ActiveSession` interface after `cwd: string`:

```typescript
  pushMessage: (msg: SDKUserMessage) => void;
  closeInput: () => void;
  stopTimeout: ReturnType<typeof setTimeout> | null;
```

The full interface becomes:

```typescript
export interface ActiveSession {
  cardId: number;
  query: Query;
  sessionId: string | null;
  provider: string;
  model: string;
  status: SessionStatus;
  promptsSent: number;
  turnsCompleted: number;
  turnCost: number;
  turnUsage: Usage | null;
  cwd: string;
  pushMessage: (msg: SDKUserMessage) => void;
  closeInput: () => void;
  stopTimeout: ReturnType<typeof setTimeout> | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/sessions/types.ts
git commit -m "feat: add pushMessage, closeInput, stopTimeout to ActiveSession"
```

---

### Task 3: Refactor `start()` to use prompt channel

**Files:**
- Modify: `src/server/sessions/manager.ts:1-68`

- [ ] **Step 1: Update imports**

Replace the imports at the top of `manager.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ActiveSession, SessionStartOpts } from './types';
import { consumeSession } from './consumer';
import { ensureWorktree } from './worktree';
import { Card } from '../models/Card';
import { AppDataSource } from '../models/index';
import { createPromptChannel, userMessage } from './prompt-channel';
```

- [ ] **Step 2: Refactor `start()` method**

Replace the `start()` method body. The key changes:
1. Create prompt channel
2. Push initial prompt into channel
3. Pass `channel.iterator` to `query()` instead of `prompt` string
4. Store `push`/`close` on the session

```typescript
  async start(
    cardId: number,
    prompt: string,
    opts: SessionStartOpts,
  ): Promise<ActiveSession> {
    // If session already active, send as follow-up instead
    const existing = this.sessions.get(cardId);
    if (existing && (existing.status === 'running' || existing.status === 'starting' || existing.status === 'retry')) {
      this.sendFollowUp(cardId, prompt);
      return existing;
    }

    // Load card and ensure worktree
    const card = await AppDataSource.getRepository(Card).findOneByOrFail({ id: cardId });
    const cwd = await ensureWorktree(card);

    const channel = createPromptChannel();
    channel.push(userMessage(prompt));

    const isKiroProvider = opts.provider !== 'anthropic';
    const modelStr = isKiroProvider ? `${opts.provider}:${opts.model}` : opts.model;
    const q = query({
      prompt: channel.iterator,
      options: {
        model: modelStr,
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        ...(opts.resume ? { resume: opts.resume } : {}),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          ...(isKiroProvider ? { ANTHROPIC_BASE_URL: process.env.KIRO_PROXY_URL ?? 'http://127.0.0.1:3457' } : {}),
        },
      },
    });

    const session: ActiveSession = {
      cardId,
      query: q,
      sessionId: null,
      provider: opts.provider,
      model: opts.model,
      status: 'starting',
      promptsSent: 1,
      turnsCompleted: 0,
      turnCost: 0,
      turnUsage: null,
      cwd,
      pushMessage: channel.push,
      closeInput: channel.close,
      stopTimeout: null,
    };

    this.sessions.set(cardId, session);

    // Fire-and-forget consumer loop
    consumeSession(session, (s) => {
      if (s.stopTimeout) clearTimeout(s.stopTimeout);
      this.sessions.delete(s.cardId);
    });

    return session;
  }
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /home/ryan/Code/orchestrel/.worktrees/switch-sessionmanager-to-streaming-input-mode && npx tsc --noEmit 2>&1 | head -30`

Expected: errors from `sendFollowUp()` and `stop()` (still using old API) — that's fine, we fix those in the next tasks. No errors from `start()`.

- [ ] **Step 4: Commit**

```bash
git add src/server/sessions/manager.ts
git commit -m "feat: start() uses prompt channel for streaming input mode"
```

---

### Task 4: Refactor `sendFollowUp()` to use prompt channel

**Files:**
- Modify: `src/server/sessions/manager.ts:70-89`

- [ ] **Step 1: Replace `sendFollowUp()` method**

Replace the entire `sendFollowUp` method:

```typescript
  sendFollowUp(cardId: number, message: string): void {
    const session = this.sessions.get(cardId);
    if (!session) throw new Error(`No active session for card ${cardId}`);

    session.promptsSent++;
    session.status = 'starting';
    session.pushMessage(userMessage(message));
  }
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ryan/Code/orchestrel/.worktrees/switch-sessionmanager-to-streaming-input-mode && npx tsc --noEmit 2>&1 | head -20`

Expected: may still have errors from `stop()` — that's next.

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/manager.ts
git commit -m "feat: sendFollowUp() pushes through prompt channel"
```

---

### Task 5: Refactor `stop()` with interrupt + close fallback

**Files:**
- Modify: `src/server/sessions/manager.ts:91-100`

- [ ] **Step 1: Replace `stop()` method**

Replace the entire `stop` method. The strategy:
1. Call `interrupt()` (works in streaming input mode)
2. Set a 5s timeout — if the session is still in the map, call `closeInput()` + `close()` as hard kill
3. Store the timeout ID on the session so the `onExit` callback can clear it

```typescript
  stop(cardId: number): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    console.log(`[session:${session.sessionId ?? cardId}] stop requested`);
    session.status = 'stopped';
    session.query.interrupt().catch((err) => {
      console.log(`[session:${session.sessionId ?? cardId}] interrupt cleanup: ${err}`);
    });

    // Hard kill fallback if interrupt doesn't terminate the session
    session.stopTimeout = setTimeout(() => {
      if (!this.sessions.has(cardId)) return;
      console.log(`[session:${session.sessionId ?? cardId}] interrupt timeout, forcing close`);
      session.closeInput();
      session.query.close();
    }, 5_000);
  }
```

- [ ] **Step 2: Verify full project compiles**

Run: `cd /home/ryan/Code/orchestrel/.worktrees/switch-sessionmanager-to-streaming-input-mode && npx tsc --noEmit 2>&1 | head -20`

Expected: clean compile (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/manager.ts
git commit -m "feat: stop() uses interrupt + close fallback with 5s timeout"
```

---

### Task 6: Verify end-to-end behavior

**Files:** None (manual testing)

- [ ] **Step 1: Restart the dev server**

Run: `sudo systemctl restart orchestrel`

- [ ] **Step 2: Test basic session**

Open `http://localhost:6194`, start a session on a card. Watch the server logs for:
- `init sessionId=...` — session started
- `stream_event` messages appearing in the consumer (check if deltas arrive token-by-token vs complete blocks)

- [ ] **Step 3: Test stop button during initial prompt**

Start a new session. Immediately hit the stop button before the first turn completes. Watch logs for:
- `stop requested`
- `consumer stopped cleanly` (interrupt worked)
- Should NOT see the 5s timeout fire

- [ ] **Step 4: Test follow-up messages**

Start a session, wait for first turn to complete. Send a follow-up message. Verify it processes correctly and the agent responds.

- [ ] **Step 5: Test stop timeout fallback**

If interrupt doesn't terminate within 5s (may be hard to trigger naturally), check the logs for the timeout message. This is a safety net — it's OK if it never fires in normal operation.

- [ ] **Step 6: Commit any fixes**

If any consumer error strings need updating (e.g., `close()` produces a different error message than expected), fix the catch filter in `consumer.ts:102` and commit:

```bash
git add src/server/sessions/consumer.ts
git commit -m "fix: handle close() error message in consumer catch filter"
```
