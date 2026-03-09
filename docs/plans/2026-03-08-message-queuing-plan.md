# Message Queuing via `streamInput` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Queue user messages during active Claude processing and deliver them at the next turn boundary via the SDK's `streamInput` API, matching Claude Code's native behavior.

**Architecture:** Add an async generator backed by a simple array + wake pattern to `ClaudeSession`. Wire it into the query via `streamInput()` after creation. `sendUserMessage()` pushes to the queue instead of interrupting.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` V1 `streamInput`, TypeScript async generators

---

### Task 1: Add input queue infrastructure to ClaudeSession

**Files:**
- Modify: `src/server/claude/protocol.ts`

**Step 1: Add imports and new members**

Add the SDK type import and new class members:

```ts
// At top of file, update import:
import type { Options as SDKOptions, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// New members in ClaudeSession class (after existing private members):
private inputQueue: SDKUserMessage[] = [];
private inputWake: (() => void) | null = null;
```

**Step 2: Add `createInputStream()` private method**

Add after the `consumeMessages()` method:

```ts
private async *createInputStream(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    while (this.inputQueue.length > 0) {
      yield this.inputQueue.shift()!;
    }
    await new Promise<void>((resolve) => {
      this.inputWake = resolve;
    });
  }
}
```

**Step 3: Commit**

```bash
git add src/server/claude/protocol.ts
git commit -m "feat: add input queue infrastructure for message queuing"
```

---

### Task 2: Wire `streamInput` into query lifecycle

**Files:**
- Modify: `src/server/claude/protocol.ts`

**Step 1: Wire streamInput in `runQuery()`**

After `this.queryInstance = query(...)` (line ~100), add:

```ts
// Wire up input stream for queued messages (fire-and-forget)
this.queryInstance.streamInput(this.createInputStream());
```

**Step 2: Reset queue state in `runQuery()`**

At the top of `runQuery()`, reset the queue so a fresh query starts clean:

```ts
this.inputQueue = [];
this.inputWake = null;
```

**Step 3: Commit**

```bash
git add src/server/claude/protocol.ts
git commit -m "feat: wire streamInput into query lifecycle"
```

---

### Task 3: Rewrite `sendUserMessage()` to use queue

**Files:**
- Modify: `src/server/claude/protocol.ts`

**Step 1: Replace `sendUserMessage()` implementation**

Replace the entire method with:

```ts
async sendUserMessage(content: string): Promise<void> {
  this.promptsSent++;
  // Set queryStartIndex BEFORE push so subscription replay includes this user message
  // (needed for file attachment prefix to render in chat)
  this.queryStartIndex = this.messages.length;
  const msg = { type: 'user', message: { role: 'user', content } };
  this.messages.push(msg);
  this.persistMessage(msg);
  this.emit('message', msg);

  const resumeId = this.sessionId ?? this.resumeSessionId;
  if (!resumeId) return;

  if (this.queryInstance) {
    // Query is running — queue the message for SDK pickup at next turn boundary
    const sdkMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: resumeId,
    };
    this.inputQueue.push(sdkMsg);
    this.inputWake?.();
  } else {
    // Query finished — start a new one (existing resume behavior)
    this.status = 'starting';
    await this.runQuery(content, resumeId);
  }
}
```

**Step 2: Commit**

```bash
git add src/server/claude/protocol.ts
git commit -m "feat: queue messages via streamInput instead of interrupting"
```

---

### Task 4: Manual integration test

**Step 1: Restart the service**

```bash
sudo systemctl restart dispatcher
```

**Step 2: Test the queue behavior**

1. Open dispatcher in browser, start a Claude session on a card
2. While Claude is actively working (tool calls in progress), send a follow-up message
3. Verify: Claude does NOT restart — it continues its current work, then picks up the queued message
4. Verify: The queued user message appears in the chat immediately (optimistic rendering)
5. Verify: After Claude finishes its current turn, it processes the queued message

**Step 3: Test idle resume behavior**

1. Wait for Claude to fully finish (session shows completed)
2. Send a follow-up message
3. Verify: Claude starts a new query and processes the message (same as before)

**Step 4: Commit any fixes if needed**
