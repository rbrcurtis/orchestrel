# Subagent Visibility & Diagnostic Logging — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make child session (subagent) work visible in the dispatcher UI and add structured diagnostic logging for session lifecycle.

**Architecture:** Server-side SSE event processing in `OpenCodeSession` gains child session tracking and forwards lightweight activity messages. Client-side MobX store tracks subagent state, rendered as stacked rows pinned above the prompt input. All changes ride on existing message bus and WS protocol — no new transport.

**Tech Stack:** TypeScript, MobX, React, Zod, OpenCode SDK (`@opencode-ai/sdk`), Tailwind/shadcn

**Spec:** `docs/superpowers/specs/2026-03-15-subagent-visibility-design.md`

---

## Chunk 1: Type Foundation + Service Plumbing

### Task 1: Add `subagent` and `retry` to type system

**Files:**
- Modify: `src/server/agents/types.ts`
- Modify: `src/shared/ws-protocol.ts`
- Modify: `app/stores/session-store.ts`

- [ ] **Step 1: Update server-side types**

In `src/server/agents/types.ts`, add `'retry'` to `SessionStatus` and `'subagent'` to `AgentMessage.type`:

```typescript
// line 5
export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry'

// line 8 — add 'subagent' to the type union
export type AgentMessage = {
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'system' | 'turn_end' | 'error' | 'user' | 'tool_progress' | 'subagent'
  // ... rest unchanged
}
```

- [ ] **Step 2: Update shared Zod schemas**

In `src/shared/ws-protocol.ts`:

```typescript
// line 102 — add 'retry' to agentStatusSchema
export const agentStatusSchema = z.object({
  cardId: z.number(),
  active: z.boolean(),
  status: z.enum(['starting', 'running', 'completed', 'errored', 'stopped', 'retry']),
  sessionId: z.string().nullable(),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
})

// line 111 — add 'subagent' to agentMessageSchema
export const agentMessageSchema = z.object({
  type: z.enum(['text', 'tool_call', 'tool_result', 'thinking', 'system', 'turn_end', 'error', 'user', 'tool_progress', 'subagent']),
  // ... rest unchanged
})
```

- [ ] **Step 3: Update client-side SessionState status type**

In `app/stores/session-store.ts`, line 25, update the status type to include `'retry'`:

```typescript
status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';
```

Without this, the StatusBadge switch falls through to the default "Errored" case when retry status is received.

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/types.ts src/shared/ws-protocol.ts app/stores/session-store.ts
git commit -m "feat: add subagent and retry types to AgentMessage and SessionStatus"
```

### Task 2: Update DISPLAY_TYPES and getStatus

**Files:**
- Modify: `src/server/services/session.ts`

- [ ] **Step 1: Add `subagent` to DISPLAY_TYPES**

In `src/server/services/session.ts`, line 17:

```typescript
const DISPLAY_TYPES = new Set([
  'user', 'text', 'tool_call', 'tool_result', 'tool_progress',
  'thinking', 'system', 'turn_end', 'error', 'subagent',
])
```

- [ ] **Step 2: Update getStatus to treat retry as active**

In `src/server/services/session.ts`, line 230:

```typescript
active: session.status === 'running' || session.status === 'starting' || session.status === 'retry',
```

- [ ] **Step 3: Commit**

```bash
git add src/server/services/session.ts
git commit -m "feat: allow subagent messages through DISPLAY_TYPES, treat retry as active"
```

## Chunk 2: Server — Diagnostic Logging + Subagent Forwarding

### Task 3: Rewrite logging in OpenCodeSession

**Files:**
- Modify: `src/server/agents/opencode/session.ts`

This task replaces all `console.log` calls in `session.ts` with structured, grep-friendly logging. Each log line uses the format `[session:${id}] event:detail`.

- [ ] **Step 1: Add a `log` helper method and status transition logging**

Add a private method and update `status` to log transitions:

```typescript
// Add to OpenCodeSession class body:
private _status: SessionStatus = 'starting'

get status(): SessionStatus { return this._status }
set status(val: SessionStatus) {
  if (val !== this._status) {
    this.log(`status: ${this._status} → ${val}`)
    this._status = val
  }
}

private log(msg: string): void {
  console.log(`[session:${this.sessionId ?? 'pending'}] ${msg}`)
}

private logChild(childId: string, msg: string): void {
  console.log(`[session:${this.sessionId ?? 'pending'}:child:${childId}] ${msg}`)
}
```

Remove the `status: SessionStatus = 'starting'` property declaration (replaced by `_status` + getter/setter).

- [ ] **Step 2: Replace logging in start(), sendMessage(), kill()**

In `start()`:
```typescript
// Replace: console.log(`[opencode-session:${this.sessionId}] → session.create`)
this.log('prompt:send length=' + prompt.length)
// After promptAsync returns:
this.log('prompt:ack')
```

In `sendMessage()`:
```typescript
this.log('prompt:send length=' + content.length)
// After promptAsync returns:
this.log('prompt:ack')
```

In `kill()` — replace both log lines (lines 118 and 121):
```typescript
// Line 118: Replace console.log(`[opencode-session:${this.sessionId}] → session.abort`)
this.log('kill')
// Line 121: Replace console.error(`[opencode-session:${this.sessionId}] abort error:`, err)
this.log('kill:error ' + String(err))
```

- [ ] **Step 3: Replace logging in SSE event loop**

Replace the per-event verbose log at line 162:
```typescript
// OLD: console.log(`[opencode-session:${this.sessionId}] SSE event #${eventCount}: ${event.type}`, JSON.stringify(event.properties))
// NEW: no per-event log — only log specific events below
```

Replace SSE connect/disconnect/error logging:
```typescript
// In subscribeToEvents(), after SSE connection established:
this.log('sse:connect')

// In catch block:
this.log('sse:disconnect reason=' + String(err))

// In finally:
// (sseAlive = false already there, no log needed)
```

Replace permission logging:
```typescript
// Replace: console.log(`[opencode-session:${this.sessionId}] auto-approving permission...`)
this.log(`permission:approve ${perm.id} type=${perm.type}`)
```

Replace `session.idle` logging (line 246):
```typescript
// OLD: console.log(`[opencode-session:${this.sessionId}] session.idle received!`)
this.log('session:idle')
```

Replace `session.error` logging (line 277):
```typescript
// OLD: console.error(`[opencode-session:${this.sessionId}] session.error:`, JSON.stringify(event.properties))
this.log('session:error ' + JSON.stringify(event.properties))
```

Replace the "skipping event" log in the session ID filter:
```typescript
// OLD: console.log(`[opencode-session:${this.sessionId}] skipping event for session ${sessionID}`)
// Keep the filter block intact — Task 4 will replace this entire block with subagent handling
```

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/opencode/session.ts
git commit -m "feat: structured diagnostic logging for session lifecycle"
```

### Task 4: Subagent event forwarding

**Files:**
- Modify: `src/server/agents/opencode/session.ts`

This task adds child session tracking and forwards lightweight subagent messages instead of dropping events.

- [ ] **Step 1: Add SdkClient children method and child session state**

Extend the `SdkClient` interface:
```typescript
session: {
  // ... existing methods ...
  children(opts: { path: { id: string } }): Promise<Array<{ id: string; title: string; parentID?: string }>>;
}
```

Add class properties:
```typescript
private childSessions = new Map<string, { title: string; status: string }>()
private childrenResolvePending = false
```

- [ ] **Step 2: Add resolveChildren helper**

```typescript
private async resolveChildren(triggeringChildId?: string): Promise<void> {
  if (this.childrenResolvePending || !this.sessionId) return
  this.childrenResolvePending = true
  try {
    const sdk = this.client as unknown as SdkClient
    const children = await sdk.session.children({ path: { id: this.sessionId } })
    for (const child of children) {
      if (!this.childSessions.has(child.id)) {
        this.childSessions.set(child.id, { title: child.title, status: 'running' })
        this.log(`child:discovered ${child.id} title="${child.title.slice(0, 60)}"`)
      }
    }
  } catch (err) {
    this.log(`child:resolve-error ${err}`)
    // Use child session ID as placeholder title — retry resolution on next event
    if (triggeringChildId && !this.childSessions.has(triggeringChildId)) {
      this.childSessions.set(triggeringChildId, { title: triggeringChildId.slice(0, 12), status: 'running' })
      this.log(`child:placeholder ${triggeringChildId}`)
    }
  } finally {
    this.childrenResolvePending = false
  }
}
```

- [ ] **Step 3: Add extractShortTarget helper**

```typescript
private extractShortTarget(tool: string, input: Record<string, unknown>): string {
  if (tool === 'bash') {
    const cmd = (input.command as string) ?? (input.description as string) ?? ''
    return cmd.slice(0, 40)
  }
  const filePath = (input.filePath ?? input.file_path ?? input.path ?? input.pattern ?? '') as string
  if (filePath) {
    const parts = filePath.split('/')
    return parts[parts.length - 1] || filePath.slice(0, 40)
  }
  return ''
}
```

- [ ] **Step 4: Replace the session ID filter block with subagent handling**

Replace the block at line 186-194 (the `if (sessionID && sessionID !== this.sessionId)` block) with:

```typescript
// Child session event handling
if (sessionID && sessionID !== this.sessionId) {
  // session.idle for a child = subagent completed
  if (event.type === 'session.idle') {
    const child = this.childSessions.get(sessionID)
    if (child) {
      child.status = 'idle'
      this.logChild(sessionID, 'idle')
      this.emit('message', {
        type: 'subagent',
        role: 'system',
        content: '',
        meta: { subtype: 'completed', childSessionId: sessionID, title: child.title },
        timestamp: Date.now(),
      } satisfies AgentMessage)
    }
    continue
  }

  // Child retry — log only, don't forward
  if (event.type === 'session.status') {
    const { status } = event.properties as { status?: { type?: string; attempt?: number; next?: number; message?: string } }
    if (status?.type === 'retry') {
      this.logChild(sessionID, `retry attempt=${status.attempt} next=${status.next}ms`)
    }
    continue
  }

  // Child tool activity — only forward running state
  if (event.type === 'message.part.updated') {
    const part = (event.properties as { part?: { type?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } } }).part
    if (part?.type === 'tool' && part.state?.status === 'running' && part.tool) {
      // Resolve child session info if unknown
      if (!this.childSessions.has(sessionID)) {
        await this.resolveChildren(sessionID)
      }
      const child = this.childSessions.get(sessionID)
      if (!child) { continue } // Not our child — truly skip

      const target = this.extractShortTarget(part.tool, part.state.input ?? {})
      this.logChild(sessionID, `tool:${part.tool} → ${target} (running)`)
      this.emit('message', {
        type: 'subagent',
        role: 'system',
        content: '',
        meta: {
          subtype: 'activity',
          childSessionId: sessionID,
          title: child.title,
          tool: part.tool,
          target,
          status: 'running',
        },
        timestamp: Date.now(),
      } satisfies AgentMessage)
    }
    continue
  }

  // All other child events — skip silently
  continue
}
```

- [ ] **Step 5: Add retry handling for parent session**

In the `session.status` handler block (after the `busy` check), add retry handling:

```typescript
if (event.type === 'session.status') {
  const { status } = event.properties as { sessionID?: string; status?: { type?: string; attempt?: number; message?: string; next?: number } }
  if (status?.type === 'busy' && this.status !== 'running') {
    this.status = 'running'
    this.emit('message', {
      type: 'system',
      role: 'system',
      content: '',
      meta: { subtype: 'init', model: this.modelID, turn: this.promptsSent },
      timestamp: Date.now(),
    } satisfies AgentMessage)
  }
  if (status?.type === 'retry') {
    this.status = 'retry'
    this.log(`retry attempt=${status.attempt} next=${status.next}ms message="${status.message}"`)
    this.emit('message', {
      type: 'system',
      role: 'system',
      content: '',
      meta: {
        subtype: 'retry',
        attempt: status.attempt,
        message: status.message,
        nextMs: status.next,
      },
      timestamp: Date.now(),
    } satisfies AgentMessage)
  }
}
```

- [ ] **Step 6: Verify build compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/server/agents/opencode/session.ts
git commit -m "feat: forward subagent activity + retry events instead of dropping"
```

## Chunk 3: Client — Store + UI

### Task 5: Add subagent state to SessionStore

**Files:**
- Modify: `app/stores/session-store.ts`

- [ ] **Step 1: Update SessionState type and defaultSession**

```typescript
// Add to SessionState interface (after contextWindow):
subagents: Map<string, { title: string; lastActivity: string; status: 'running' | 'idle' }>;

// Update status type:
status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';
```

In `defaultSession()`, add:
```typescript
subagents: observable.map(),
```

- [ ] **Step 2: Add subagentTimeouts map and cleanup**

Add class property:
```typescript
private subagentTimeouts = new Map<string, NodeJS.Timeout>();
```

Update `clearConversation`:
```typescript
clearConversation(cardId: number): void {
  const s = this.sessions.get(cardId);
  if (!s) return;
  s.conversation.splice(0);
  s.toolCallIdxMap.clear();
  s.historyLoaded = false;
  s.contextTokens = 0;
  s.contextWindow = 200_000;
  // Clear subagent state
  s.subagents.clear();
  for (const [key, timer] of this.subagentTimeouts) {
    if (key.startsWith(`${cardId}:`)) {
      clearTimeout(timer);
      this.subagentTimeouts.delete(key);
    }
  }
}
```

- [ ] **Step 3: Handle subagent messages in ingest()**

Add at the top of `ingest()`, inside the `runInAction` callback, before existing logic:

```typescript
if (msg.type === 'subagent' && msg.meta) {
  const m = msg.meta as { subtype: string; childSessionId: string; title: string; tool?: string; target?: string };
  if (m.subtype === 'activity') {
    s.subagents.set(m.childSessionId, {
      title: m.title,
      lastActivity: `${m.tool} → ${m.target}`,
      status: 'running',
    });
  } else if (m.subtype === 'completed') {
    const existing = s.subagents.get(m.childSessionId);
    if (existing) {
      existing.status = 'idle';
      existing.lastActivity = 'done';
    }
    // Schedule removal after 2s
    const timeoutKey = `${cardId}:${m.childSessionId}`;
    const prev = this.subagentTimeouts.get(timeoutKey);
    if (prev) clearTimeout(prev);
    this.subagentTimeouts.set(timeoutKey, setTimeout(() => {
      runInAction(() => {
        s.subagents.delete(m.childSessionId);
      });
      this.subagentTimeouts.delete(timeoutKey);
    }, 2000));
  }
  return; // Don't add subagent messages to conversation
}
```

- [ ] **Step 4: Clear subagents on parent session end**

In `handleAgentStatus`, after setting `s.status`, add:

```typescript
// Clear subagent rows when parent session ends
if (data.status === 'completed' || data.status === 'stopped' || data.status === 'errored') {
  s.subagents.clear();
  for (const [key, timer] of this.subagentTimeouts) {
    if (key.startsWith(`${data.cardId}:`)) {
      clearTimeout(timer);
      this.subagentTimeouts.delete(key);
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add app/stores/session-store.ts
git commit -m "feat: track subagent state in SessionStore with auto-cleanup"
```

### Task 6: Create SubagentFeed component

**Files:**
- Create: `app/components/SubagentFeed.tsx`

- [ ] **Step 1: Create the component**

```typescript
import { observer } from 'mobx-react-lite';

type SubagentEntry = {
  title: string;
  lastActivity: string;
  status: 'running' | 'idle';
};

type Props = {
  subagents: Map<string, SubagentEntry>;
};

export const SubagentFeed = observer(function SubagentFeed({ subagents }: Props) {
  if (subagents.size === 0) return null;

  const entries = Array.from(subagents.entries());

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 bg-elevated border-t border-border shrink-0">
      {entries.map(([id, entry]) => (
        <div
          key={id}
          className="flex items-center gap-2 text-[11px] transition-opacity duration-300"
          style={{ opacity: entry.status === 'idle' ? 0.4 : 1 }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: entry.status === 'running' ? '#39ff14' : '#8a8a9e',
              boxShadow: entry.status === 'running' ? '0 0 4px #39ff1466' : 'none',
            }}
          />
          <span className="text-foreground truncate max-w-[200px]">
            {entry.title.replace(/\s*\(@\w+ subagent\)$/, '').slice(0, 40)}
          </span>
          <span className="text-muted-foreground truncate flex-1">
            {entry.lastActivity}
          </span>
        </div>
      ))}
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add app/components/SubagentFeed.tsx
git commit -m "feat: SubagentFeed component — stacked rows for child session activity"
```

### Task 7: Integrate into SessionView + retry StatusBadge

**Files:**
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Import SubagentFeed**

Add import at top:
```typescript
import { SubagentFeed } from './SubagentFeed';
```

- [ ] **Step 2: Extract subagents from session state**

After the existing state extractions (around line 38), add:
```typescript
const subagents = session?.subagents ?? new Map();
```

- [ ] **Step 3: Render SubagentFeed between status bar and prompt input**

In the JSX return, between the status bar section (ending ~line 278) and the `<PromptInput` (starting ~line 281), insert:

```tsx
{/* Subagent activity feed */}
<SubagentFeed subagents={subagents} />
```

- [ ] **Step 4: Update StatusBadge for retry state**

In the `StatusBadge` function, add a case before the `default`:

```typescript
case 'retry':
  variant = 'outline';
  label = 'Queued';
  break;
```

- [ ] **Step 5: Add `retry` to isStarting useEffect**

In the `isStarting` cleanup useEffect (line 77-86), add `retry` to the status list so `isStarting` clears correctly:

```typescript
// Clear isStarting on status transition
useEffect(() => {
  if (
    sessionStatus === 'running' ||
    sessionStatus === 'completed' ||
    sessionStatus === 'errored' ||
    sessionStatus === 'stopped' ||
    sessionStatus === 'retry'
  ) {
    setIsStarting(false);
  }
}, [sessionStatus]);
```

- [ ] **Step 6: Add retry message display in status bar**

In the status bar section, after the `<StatusBadge>`, add retry info display. Extract retry metadata from the last system message:

```typescript
const retryInfo = sessionStatus === 'retry'
  ? conversation.findLast(m => m.type === 'system' && m.meta?.subtype === 'retry')
  : null;
```

Then in the status bar JSX, after `<StatusBadge>`:
```tsx
{retryInfo && (
  <span className="text-[11px] text-neon-amber truncate">
    {String(retryInfo.meta?.message ?? 'Waiting...')}
    {retryInfo.meta?.attempt != null && ` (attempt ${retryInfo.meta.attempt})`}
  </span>
)}
```

- [ ] **Step 7: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: integrate SubagentFeed + retry badge in SessionView"
```

## Chunk 4: Verification

### Task 8: Manual smoke test

- [ ] **Step 1: Restart dispatcher service**

```bash
sudo systemctl restart dispatcher.service
```

- [ ] **Step 2: Test subagent visibility**

Open dispatch.rbrcurtis.com. Start a card in Running with a project and a prompt that triggers subagent usage (e.g. "explore the codebase and implement X"). Verify:
- Subagent rows appear in the feed between status bar and prompt input
- Each row shows green dot + title + tool activity text
- Activity text updates as subagent tools change
- Completed subagents fade and remove after ~2s
- Feed disappears when all subagents finish

- [ ] **Step 3: Test diagnostic logging**

```bash
journalctl -u dispatcher.service --no-pager -n 100 | grep '\[session:'
```

Verify structured log lines appear with `status:`, `prompt:send`, `sse:connect`, `child:discovered`, `child:` prefix for subagent events.

- [ ] **Step 4: Test card switch cleanup**

While subagents are running, switch to a different card and back. Verify no stale subagent rows or console errors.

- [ ] **Step 5: Test retry badge (if observable)**

If rate limiting occurs, verify the amber "Queued" badge appears with the retry message. If not reproducible, verify the code path compiles and the StatusBadge renders correctly for `retry` status.
