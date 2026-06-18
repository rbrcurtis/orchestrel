# Turn-Complete Card Lifecycle Design

## Goal

Separate Orchestrel's board workflow state from the live Claude/orcd runtime state.

A card should leave `running` and become available for Ryan's review as soon as the agent's current turn is complete, even if the underlying session remains alive because a background task, monitor, or subagent is still running. Moving cards around the board should not implicitly kill live sessions.

## Problem

Today, `orcd` correctly keeps a session alive while background work is pending and only emits `session_exit` after that work reaches a terminal state. This is good runtime behavior, but the board currently uses `session_exit` as the signal to move a card out of `running`.

That makes cards like 1589 look actively occupied even though the agent has already finished its response and is ready for input. The card stays in `running` because the session is still waiting on background work.

There is also an overly strong coupling in `src/server/controllers/card-sessions.ts`: moving a card out of `running` cancels the session. That makes board organization double as process control, which prevents Ryan from moving waiting cards to `ready`, `done`, or another column just to keep the board clean.

## Design Summary

Introduce a first-class **turn complete** lifecycle signal:

- `turn_complete`: the agent finished its current response and is ready for user input.
- `session_exit`: the SDK iterator fully closed; the runtime session is no longer alive.

Card columns become workflow/attention state. orcd session status remains runtime state.

## Runtime Lifecycle

`orcd` emits a new protocol message when it receives an SDK `result` for the turn:

```ts
{
  type: 'turn_complete';
  sessionId: string;
  eventIndex: number;
  hasPendingAsyncTasks: boolean;
}
```

`turn_complete` does not imply the session is done. If async/background tasks are pending, `orcd` keeps the session alive exactly as it does today and later emits `session_exit` when the SDK iterator actually closes.

This keeps the existing important invariant: background tasks and monitors can keep the session alive. The new event only exposes the agent-turn boundary to the board.

## Card Column Lifecycle

### On `turn_complete`

The backend maps `sessionId` to card and applies:

- If the card is in `running`, move it to `review`.
- Do not cancel, untrack, or stop the session.
- Publish an event to the UI so the session/card can show that the turn is ready for input while background work may still be active.

### On `session_exit`

The backend applies:

- Update/publish runtime exit status as today.
- If the card is still in `running`, move it to `review`.
- If the card is already in another non-archive column and this session had pending async/background work after `turn_complete`, move it to `ready`.
- If the card is already in another non-archive column and there was no pending async/background work after `turn_complete`, leave it alone.
- If the card is in `archive`, leave it in `archive` always.

The intent: if Ryan archived it, he is done with it. Otherwise, completion of previously pending background work should make the card visible in `ready`, not clog `review`. A normal foreground turn that already moved the card to `review` should not later bounce it to `ready` on ordinary `session_exit`.

## Manual Card Movement

Board movement is no longer implicit session cancellation.

### Moving out of `running`

Do not cancel a live orcd session just because the card left `running`.

This allows Ryan to move a waiting card to `ready`, `done`, or another column to keep the board clean while background work continues.

### Moving into `running`

- If the card has a live session, do nothing automatically. The move is visual/workflow state only.
- If the card has no live session, keep the existing auto-start behavior.

Ryan can send a prompt to the existing live session from the session UI when needed.

### Stopping sessions

Stopping/canceling a live session should be explicit through a session control, not a side effect of dragging a card between columns.

## Background Completion Behavior

When a background task, monitor, or subagent finishes after the card has already left `running`:

- If the card is in `archive`, leave it in `archive`.
- Otherwise, move the card to `ready`.

This gives Ryan a lightweight signal that background work finished without treating it as immediate review work.

## UI Semantics

The UI should present two separate ideas:

- Card column: workflow/attention (`running`, `review`, `ready`, `done`, etc.).
- Session runtime status: live session state (`running`, `completed`, `errored`, `stopped`) shown in the session view/status area.

A card can therefore be in `review`, `ready`, or `done` while its session runtime status is still `running` because it is waiting on background work.

## Error Handling

- If `turn_complete` is received for an unknown session/card, log and ignore it.
- If `session_exit` is received for an unknown session/card, preserve existing fallback lookup behavior where possible.
- `archive` is terminal for automatic column moves from background/session events.
- Explicit user actions should always win over automatic lifecycle moves except for non-archive background completion, which intentionally moves the card to `ready` to signal new output.

## Testing

Add or update tests around these cases:

1. A running card receives `turn_complete` while async tasks are pending: card moves to `review`; session remains tracked/live.
2. Moving a card out of `running` no longer calls `orcd.cancel()`.
3. Moving a card into `running` with an existing live session does not start a duplicate session.
4. Moving a card into `running` without a live session still starts one.
5. Background/session completion after Ryan moved a card to a non-archive column moves it to `ready`.
6. Background/session completion after Ryan moved a card to `archive` leaves it archived.
7. `session_exit` still moves a card from `running` to `review` as a fallback.

## Non-Goals

- Do not change async task tracking semantics in `orcd`.
- Do not kill, fail, or orphan background tasks as part of this change.
- Do not add a new board column for waiting/background work.
- Do not infer session completion from SDK `result`; `result` only drives the new `turn_complete` signal.
