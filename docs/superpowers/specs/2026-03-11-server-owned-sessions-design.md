# Server-Owned Session Lifecycle

## Problem

Sessions can start twice due to race conditions between client and server. The client decides when to start sessions (auto-start useEffect in SessionView, drag-to-in_progress logic in board.index.tsx), but the server has no effective guard — `SessionManager.create` only blocks `running` status, not `starting`, leaving a window where two sessions can be created for the same card.

## Solution

Move all session lifecycle decisions to the server. The client becomes a dumb terminal: it updates cards and sends messages. The server decides when to create sessions, set up worktrees, and transition card columns.

## Column Rename

`in_progress` → `running` globally. DB migration to update existing rows.

Columns: `backlog` | `ready` | `running` | `review` | `done` | `archive`

Semantic meaning:
- `running` = active Claude session. Card enters this column only when a session is starting/running.
- `review` = session ended (completed, stopped, or errored). Card lands here automatically.

## Card Lifecycle

### Validation

- Card creation requires `projectId` (always).
- Column `running` requires non-empty `title` and `description`. Enforced on both `card:create` and `card:update`. Mutation is rejected if invalid.

### Route 1: Create card directly in `running`

1. Client sends `card:create` with `column: 'running'`
2. Server validates (title, description required), creates card in DB
3. Server responds with created card
4. Server async: `beginSession(card, undefined)`

### Route 2: Create in `ready`, move to `running`

1. Client sends `card:create` with `column: 'ready'` — card created
2. Client sends `card:update` with `column: 'running'`
3. Server validates, updates card in DB, responds with updated card, broadcasts
4. Server async: `beginSession(card, undefined)`

### Route 3: Send message to a card

1. Client sends `claude:send` with `cardId` and `message`
2. Server loads card, calls `updateCard(cardId, { column: 'running' })` (validates)
3. Server broadcasts `card:updated`
4. Server calls `beginSession(card, message)`

## `beginSession(card, message?)`

Single server-side entry point for session lifecycle.

```
beginSession(card, message?):
  assert(card.description)

  if no session exists:
    prompt = message ? card.description + '\n' + message : card.description
    setupWorktree(card)
    createSession(card)
    session.start(prompt)

  else (session exists):
    assert(message)
    session.sendUserMessage(message)
```

## Session Exit

- Natural completion: server moves card to `review`, broadcasts update.
- `claude:stop`: server kills session, moves card to `review`, broadcasts update.
- Error: server moves card to `review`, broadcasts update with error status.

## `SessionManager.create` Guard

Block both `starting` and `running` status to close the race window:

```typescript
if (existing && (existing.status === 'running' || existing.status === 'starting')) {
  throw new Error(`Session already running for card ${cardId}`);
}
```

## WS Protocol Changes

### Removed

- `card:move` — absorbed into `card:update`
- `claude:start` — replaced by server-side `beginSession`

### Modified

- `card:update` — gains worktree setup/teardown on column transitions, auto-starts session on transition to `running`
- `claude:send` — moves card to `running`, calls `beginSession(card, message)`
- `claude:stop` — kills session, moves card to `review`

### Unchanged

- `claude:status`, `session:load`, `card:create`, `card:delete`

## Client Simplification

### Removed

- `CardStore.moveCard()` — replaced by `updateCard({ id, column, position })`
- `SessionStore.startSession()` — replaced by `sendMessage()` which sends `claude:send`
- `SessionView` auto-start `useEffect`
- `autoStartPrompt` prop threading through `CardDetail`

### Modified

- Board drag-and-drop: `onDragEnd` calls `updateCard` instead of `moveCard`
- `SessionView` prompt input: always "send message" mode, no start vs follow-up split
- `SessionStore.sendMessage()` is the only message mutation

## Verbose Server Logging

Structured logging throughout session lifecycle, prefixed for easy filtering.

**Card transitions:**
- `[card:${id}] column ${old} → ${new}`
- `[card:${id}] rejected: missing title/description for running`

**Session lifecycle:**
- `[session:${cardId}] beginSession called, existingSession=${exists}, message=${!!message}`
- `[session:${cardId}] no session, creating. prompt length=${n}`
- `[session:${cardId}] existing session, sending follow-up`
- `[session:${cardId}] worktree setup at ${path}`
- `[session:${cardId}] created, model=${model}, thinking=${level}, resume=${!!resumeId}`
- `[session:${cardId}] blocked: session already ${status}`
- `[session:${cardId}] SDK query started`
- `[session:${cardId}] status → running`
- `[session:${cardId}] turn completed (${n} total)`
- `[session:${cardId}] exit, status=${status}`
- `[session:${cardId}] kill() called`
