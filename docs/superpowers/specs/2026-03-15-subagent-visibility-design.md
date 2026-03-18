# Subagent Visibility & Diagnostic Logging

**Date:** 2026-03-15
**Status:** Approved

## Problem

When OpenCode sessions spawn subagents (via the `task` tool), the orchestrel UI shows no indication of child session activity. The parent session appears hung — no tool calls, no text output, no progress. Users have reported sessions appearing stuck for 30+ minutes when subagents are actively working.

Additionally, the `retry` session status (rate limiting / API throttling) is not surfaced in the UI. The session shows "Running" with no activity, indistinguishable from a hung session.

Diagnostic logging is also insufficient — when investigating stuck sessions, there's no structured way to grep orchestrel logs by session ID and understand the full lifecycle.

## Scope

1. **Subagent activity feed** — live, always-visible stacked rows above the prompt input showing per-child-session activity
2. **Retry/queued state visibility** — amber "Queued" badge with retry message when the session is rate-limited
3. **Diagnostic logging** — structured, grep-friendly session lifecycle logs

Out of scope: detailed subagent conversation view, subagent control (stop/restart), solving the root cause of 30-minute queued states (logging will enable future diagnosis). Subagent feed state is **ephemeral** — not restored from session history on reconnect/reload. History load only returns parent session messages.

## Technical Context

### OpenCode SDK capabilities

- `Session.parentID` — child sessions carry their parent's ID
- `session.children({ sessionID })` — API lists all children of a parent (`GET /session/{id}/children`). Returns `Array<Session>` where each has `id`, `title`, `parentID`, `time`, etc.
- SSE event stream is global — all session events arrive on a single stream. Events carry `sessionID` in `properties.sessionID`, `properties.part.sessionID`, or `properties.info.sessionID`.
- Child session events that arrive on the parent's SSE stream include: `message.part.updated` (tool state changes, step-start/finish), `message.part.delta` (text streaming), `message.updated` (message metadata), `session.status`, `session.idle`, `session.updated`. All confirmed empirically from orchestrel logs.
- Parent session messages contain `tool: "task"` parts for each subagent invocation with `description`, `subagent_type`, `prompt`, `status`
- OpenCode `SessionStatus` types: `idle`, `busy`, `retry` (retry has `attempt`, `message`, `next` fields)

### Current behavior

- `session.ts:191` drops all SSE events where `sessionID !== this.sessionId`
- No handling of `session.status` type `retry`
- Logging dumps full JSON on every SSE event but no structured lifecycle logging
- `DISPLAY_TYPES` in `src/server/services/session.ts` filters which message types are forwarded to the bus

## Design

### 1. Server — Subagent Event Forwarding

**File:** `src/server/agents/opencode/session.ts`

When the SSE event loop encounters a child session event (currently filtered at line 191):

- Maintain a `Map<string, { title: string, status: string }>` of known child sessions
- On first event from an unknown session ID, call `session.children(this.sessionId!)` to resolve title and confirm parent-child relationship. Cache the result. Use a pending promise flag to avoid concurrent calls if multiple child events arrive before the first resolves. Guard against `this.sessionId` being null — defer resolution if so.
- If `session.children()` fails (OpenCode restarted, network error), use the child session ID as a placeholder title and retry resolution on the next event from that child.
- For child `session.status` events with `type: 'retry'`: log with the child prefix per the diagnostic logging table, then skip (do not forward to client). Child retry states are diagnostic-only.
- Instead of dropping the event, normalize it to a lightweight `subagent` message:
  - For `message.part.updated` with `type: "tool"` and `status: "running"`: extract tool name and short target (filename from path, command name for bash). Skip `pending` and `completed` tool states to reduce noise — only forward `running`.
  - For `session.idle` on a child: emit a completion message
  - Skip `message.part.delta`, `message.updated`, `session.updated`, and other high-frequency events
- Emit these as `AgentMessage` with `type: 'subagent'` on the existing `this.emit('message', ...)` path

**SdkClient interface update** — add to the `SdkClient` interface in `session.ts`:
```typescript
session: {
  // ... existing methods ...
  children(opts: { path: { id: string } }): Promise<Array<{ id: string; title: string; parentID?: string }>>;
}
```

**Message shapes:**

```typescript
// Activity update
{
  type: 'subagent',
  role: 'system',
  content: '',
  meta: {
    subtype: 'activity',
    childSessionId: string,
    title: string,       // truncated child session title
    tool: string,        // e.g. 'read', 'write', 'bash'
    target: string,      // e.g. 'SearchView.tsx', 'git status'
    status: 'running',
  },
  timestamp: number,
}

// Child session completed
{
  type: 'subagent',
  role: 'system',
  content: '',
  meta: {
    subtype: 'completed',
    childSessionId: string,
    title: string,
  },
  timestamp: number,
}
```

**Retry/queued state (parent session only):**

When `session.status` event for the parent session has `type: 'retry'`, emit:

```typescript
{
  type: 'system',
  role: 'system',
  content: '',
  meta: {
    subtype: 'retry',
    attempt: number,
    message: string,     // from the retry event
    nextMs: number,      // ms until next retry
  },
  timestamp: number,
}
```

And set `this.status = 'retry'`. When the next `busy` status arrives, transition back to `running` as normal.

Child session retry states are not surfaced in the UI — only logged for diagnostic purposes.

### 2. Diagnostic Logging

**File:** `src/server/agents/opencode/session.ts`

Replace the current `console.log` calls with structured, scannable lines. All prefixed for grep:

| Event | Log line |
|-------|----------|
| State transition | `[session:${id}] status: ${old} → ${new}` |
| Prompt sent | `[session:${id}] prompt:send length=${n}` |
| Prompt ack | `[session:${id}] prompt:ack` |
| Prompt error | `[session:${id}] prompt:error ${reason}` |
| SSE connected | `[session:${id}] sse:connect` |
| SSE disconnected | `[session:${id}] sse:disconnect reason=${reason}` |
| Child discovered | `[session:${id}] child:discovered ${childId} title="${title}"` |
| Child activity | `[session:${id}:child:${childId}] tool:${name} → ${target} (${status})` |
| Child completed | `[session:${id}:child:${childId}] idle` |
| Child retry | `[session:${id}:child:${childId}] retry attempt=${n} next=${ms}ms` |
| Retry | `[session:${id}] retry attempt=${n} next=${ms}ms message="${msg}"` |
| Permission | `[session:${id}] permission:approve ${permId} type=${type}` |
| SSE event (verbose) | Remove current `JSON.stringify(event.properties)` per-event logging. Only log event type + session ID + key identifiers (e.g. tool name, part ID). |

### 3. Client — SubagentFeed Component

**File:** new `app/components/SubagentFeed.tsx`

Rendered in `SessionView` between the status bar and the prompt input.

```
┌─────────────────────────────────────┐
│ [Running]  2/1 turns   sonnet  high │  ← status bar (existing)
├─────────────────────────────────────┤
│ ● Explore user model    read → ...  │  ← subagent feed (new)
│ ● Update ScheduleDesk   write → ... │
├─────────────────────────────────────┤
│ Send a follow-up message...    [▶]  │  ← prompt input (existing)
└─────────────────────────────────────┘
```

**Behavior:**
- Each row: colored dot (green=running, muted=completed) + truncated title + latest tool activity
- Rows appear when first `subagent` message arrives for a child session
- On `subtype: 'completed'`, row fades (opacity 0.4, dot turns gray, text shows "done") for ~2s, then removes
- When all subagents finish and are removed, the entire feed component unmounts
- When parent session status transitions to `completed`/`stopped`/`errored`, clear all subagent rows immediately (child idle events may never arrive)
- Feed has a subtle background (`bg-elevated`) and border to visually separate from the message stream

**SessionStore changes (`app/stores/session-store.ts`):**

Add to `SessionState`:
```typescript
subagents: ObservableMap<string, {
  title: string;
  lastActivity: string;
  status: 'running' | 'idle';
}>
```

Initialize with `observable.map()` in `defaultSession()`.

`ingestMessage` handles `type: 'subagent'`:
- `subtype: 'activity'` → upsert into map with `lastActivity: "${tool} → ${target}"`
- `subtype: 'completed'` → set status to `'idle'`, schedule removal after 2s using `runInAction` in the callback

**Cleanup:** Track pending removal timeouts in a `Map<string, NodeJS.Timeout>` on the store. Clear all timeouts and the subagents map in `clearConversation()` on card switch / session reset to prevent stale mutations.

### 4. StatusBadge — Retry State

**File:** `app/components/SessionView.tsx`

Add `retry` to the StatusBadge switch:

```typescript
case 'retry':
  variant = 'outline'; // amber-styled
  label = 'Queued';
  break;
```

The retry message and attempt count display in the status bar next to the badge (same line, muted foreground, amber text for the message).

### 5. Type Updates

**Files that need `'subagent'` added to `AgentMessage.type`:**
- `src/server/agents/types.ts` — the server-side `AgentMessage` type union (used by `satisfies AgentMessage`)
- `src/shared/ws-protocol.ts` — the Zod `agentMessageSchema` enum (validated on client receive)

**Files that need `'retry'` added to `SessionStatus`:**
- `src/server/agents/types.ts` — `SessionStatus` type union
- `src/shared/ws-protocol.ts` — `agentStatusSchema` if it mirrors session status
- `app/stores/session-store.ts` — `SessionState.status` type union (so `retry` doesn't fall through to the `default` "Errored" case in StatusBadge)

**`DISPLAY_TYPES` update:**
- `src/server/services/session.ts` — add `'subagent'` to the `DISPLAY_TYPES` set so subagent messages are forwarded to the bus

**`getStatus()` update:**
- `src/server/services/session.ts` — treat `retry` as active: `active: session.status === 'running' || session.status === 'starting' || session.status === 'retry'`

No new WS message types — subagent and retry messages ride on the existing `card:${cardId}:message` bus topic and `agent:message` server→client message.

## Testing

Manual smoke test:
1. Start a card with a project that has subagent-heavy prompts (e.g. "explore the codebase and implement X")
2. Verify subagent rows appear in the feed with live tool activity
3. Verify completed subagents fade and remove
4. Verify feed disappears when all subagents finish
5. Grep journalctl by session ID — verify structured lifecycle logs appear
6. Verify child session events are logged with `child:` prefix
7. Switch cards while subagents are running — verify no stale mutations or errors
