# Claude Agent SDK Migration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the subprocess-spawn Claude integration with the `@anthropic-ai/claude-agent-sdk` `query()` API so sessions can run to natural completion and support proper resume.

**Architecture:** Replace `ClaudeSession` (which spawns `claude` CLI with `--max-turns 1` and ignores stdin) with an SDK-based session that uses `query()` to create an async generator. The generator streams `SDKMessage` events that we buffer, persist, and emit to tRPC subscribers. Follow-up messages resume via `options.resume`. The manager, router, types, and frontend stay structurally the same — only the protocol layer changes.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, TypeScript, tRPC subscriptions, EventEmitter

---

### Task 1: Install the SDK dependency

**Files:**
- Modify: `package.json`

**Step 1: Add the dependency**

Run: `cd /home/ryan/Code/dispatcher && pnpm add @anthropic-ai/claude-agent-sdk`

**Step 2: Verify it installed**

Run: `pnpm ls @anthropic-ai/claude-agent-sdk`
Expected: Shows version (0.2.x)

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat: add @anthropic-ai/claude-agent-sdk dependency"
```

---

### Task 2: Rewrite protocol.ts to use the SDK

This is the core change. Replace the subprocess spawn with `query()`.

**Files:**
- Rewrite: `src/server/claude/protocol.ts`

**Step 1: Write the new ClaudeSession class**

The new implementation:
- Calls `query({ prompt, options })` which returns an `AsyncGenerator<SDKMessage>`
- Iterates the generator in a background async loop, emitting each message
- For follow-ups, calls `query()` again with `options.resume = sessionId`
- Abort via `abortController.abort()`
- No subprocess, no stdin/stdout, no readline

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, Options as SDKOptions, Query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { SessionStatus } from './types';

const SESSIONS_DIR = join(process.cwd(), 'data', 'sessions');
mkdirSync(SESSIONS_DIR, { recursive: true });

export class ClaudeSession extends EventEmitter {
  sessionId: string | null = null;
  status: SessionStatus = 'starting';
  messages: Record<string, unknown>[] = [];
  promptsSent = 0;
  turnsCompleted = 0;

  private queryInstance: Query | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private cwd: string,
    private resumeSessionId?: string,
  ) {
    super();
  }

  async start(prompt: string): Promise<void> {
    await this.runQuery(prompt, this.resumeSessionId);
  }

  private async runQuery(prompt: string, resumeId?: string): Promise<void> {
    this.abortController = new AbortController();

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const opts: SDKOptions = {
      cwd: this.cwd,
      env,
      abortController: this.abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      includePartialMessages: false,
    };

    if (resumeId) {
      opts.resume = resumeId;
    }

    this.queryInstance = query({ prompt, options: opts });

    // Run generator in background — don't await the full loop
    this.consumeMessages().catch((err) => {
      console.error('Query consumption error:', err);
      this.status = 'errored';
      this.emit('exit', 1);
    });
  }

  private async consumeMessages(): Promise<void> {
    if (!this.queryInstance) return;

    try {
      for await (const msg of this.queryInstance) {
        this.handleMessage(msg as Record<string, unknown>);
      }
      // Generator completed normally
      this.status = 'completed';
      this.emit('exit', 0);
    } catch (err: unknown) {
      // AbortError means we called interrupt/abort — treat as clean exit
      if (err instanceof Error && err.name === 'AbortError') {
        this.status = 'completed';
        this.emit('exit', 0);
      } else {
        console.error('SDK query error:', err);
        this.status = 'errored';
        this.emit('exit', 1);
      }
    } finally {
      this.queryInstance = null;
      this.abortController = null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Capture session ID from system init message
    if (msg.type === 'system' && typeof msg.session_id === 'string') {
      if (!this.sessionId) {
        this.sessionId = msg.session_id as string;
      }
      this.status = 'running';
    }

    // Buffer, persist, emit
    this.messages.push(msg);
    this.persistMessage(msg);
    this.emit('message', msg);

    if (msg.type === 'result') {
      this.turnsCompleted++;
    }
  }

  async sendUserMessage(content: string): Promise<void> {
    this.promptsSent++;
    const msg = { type: 'user', message: { role: 'user', content } };
    this.messages.push(msg);
    this.persistMessage(msg);
    this.emit('message', msg);

    // Always spawn a new query with --resume for follow-ups
    // (the previous query has completed or we abort it first)
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt(); } catch { /* ignore */ }
    }
    if (!this.sessionId) return;
    this.status = 'starting';
    await this.runQuery(content, this.sessionId);
  }

  private persistMessage(msg: Record<string, unknown>): void {
    if (!this.sessionId) return;
    try {
      appendFileSync(
        join(SESSIONS_DIR, `${this.sessionId}.jsonl`),
        JSON.stringify(msg) + '\n',
      );
    } catch { /* ignore */ }
  }

  async kill(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt(); } catch { /* ignore */ }
    }
  }
}
```

Key differences from the old code:
- No `spawn()`, no `ChildProcess`, no `readline`
- `query()` returns an async generator — iterate with `for await`
- `kill()` uses `abortController.abort()` and `queryInstance.interrupt()`
- `sendUserMessage()` interrupts any running query, then starts a new `query()` with `resume`
- `permissionMode: 'bypassPermissions'` replaces `--dangerously-skip-permissions`
- `settingSources: ['project', 'user', 'local']` loads CLAUDE.md files
- No `--max-turns` — sessions run to natural completion

**Step 2: Verify the dev server still starts**

Run: `sudo systemctl restart dispatcher && sleep 3 && sudo systemctl status dispatcher`
Expected: Service is active/running with no import errors

**Step 3: Commit**

```bash
git add src/server/claude/protocol.ts
git commit -m "feat: replace subprocess spawn with claude-agent-sdk query()"
```

---

### Task 3: Update the claude router for SDK changes

The router (`src/server/routers/claude.ts`) has comments referencing `--max-turns 1` and the subprocess model. Clean up these references. The actual logic mostly stays the same since `ClaudeSession` still exposes the same interface (start, sendUserMessage, kill, events).

**Files:**
- Modify: `src/server/routers/claude.ts`

**Step 1: Remove stale comments**

- Line 43: Remove comment about `--max-turns 1` race
- Line 75: Remove comment about CLI arg persistence

**Step 2: Update the exit handler**

The `session.on('exit')` handler currently auto-moves cards to `review` on exit. With the SDK, the session runs longer (many turns). We should only move to review when the query completes normally (not when interrupted for a follow-up). Check that the `status` is `completed` or `errored` before moving.

In the `start` mutation, update the exit handler:

```typescript
session.on('exit', async () => {
  // Only move to review if the session actually finished (not interrupted for follow-up)
  if (session.status === 'completed' || session.status === 'errored') {
    try {
      await db.update(cards)
        .set({
          column: 'review',
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(cards.id, input.cardId));
    } catch (err) {
      console.error(`Failed to auto-move card ${input.cardId} to review:`, err);
    }
  }
});
```

**Step 3: Update the subscription loop exit condition**

The `onMessage` subscription currently exits when `session.status` is `completed` or `errored`. With longer-running sessions, this is still correct — the generator keeps emitting messages until the SDK query finishes. No change needed here, but verify the logic is sound.

**Step 4: Commit**

```bash
git add src/server/routers/claude.ts
git commit -m "refactor: update claude router for SDK session lifecycle"
```

---

### Task 4: Clean up types.ts

The `ControlRequest` type is no longer needed (the SDK handles permissions internally). The rest of the types are still used by the frontend for rendering messages.

**Files:**
- Modify: `src/server/claude/types.ts`

**Step 1: Remove ControlRequest type**

Delete the `ControlRequest` type definition (lines 72-81) and remove it from the `ClaudeMessage` union.

**Step 2: Commit**

```bash
git add src/server/claude/types.ts
git commit -m "refactor: remove ControlRequest type (SDK handles permissions)"
```

---

### Task 5: Verify end-to-end with the browser

**Step 1: Restart the dev server**

Run: `sudo systemctl restart dispatcher`

**Step 2: Open the board in the browser**

Navigate to `http://192.168.4.200:6194`, open the "Icons" card.

**Step 3: Start a session**

Type a simple prompt like "List the files in the current directory" and click Send. Verify:
- Status badge shows "Running"
- Messages stream in (system init, assistant response with tool uses, result)
- Session completes naturally (shows "Turn complete" divider)
- Card moves to Review column

**Step 4: Test follow-up**

Click the card again, send a follow-up message. Verify:
- New query starts with resume
- Previous context is maintained
- New messages appear after the history

**Step 5: Test stop button**

Start a new session with a longer prompt, click Stop. Verify:
- Session stops cleanly
- No error messages

**Step 6: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```

---

### Task 6: Start the Icons card session

Once everything works, start the Icons card with its actual prompt to verify Claude can now do real multi-step work.

**Step 1: Open Icons card and start session**

Use the card's description as the prompt. Claude should be able to:
- Create a new route file
- Add components
- Update the header
- All in one session without hitting max-turns

**Step 2: Verify it completes or makes meaningful progress**

The session should run through multiple tool calls (Read, Write, Edit, Bash) without stopping after 1 turn.
