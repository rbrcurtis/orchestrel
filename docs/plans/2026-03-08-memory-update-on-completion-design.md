# Memory Update on Card Completion

## Problem

When a card moves to `done` or `archive`, the Claude session that worked on it has accumulated context about the work. We want Claude to store memories (via the `/m` command and shared-memory MCP) before the session is fully closed out.

## Design

### Trigger

Server-side, in the `cards.move` mutation (`src/server/routers/cards.ts`). When `input.column` is `done` or `archive` and the card has a `sessionId`, fire a background memory update.

### Flow

**Moving to `done`:**
1. Card status updates immediately in DB (existing behavior)
2. Fire-and-forget: resume the existing session via `sessionManager` and send `/m`
3. Worktree still exists — resume works normally
4. Session exit handler skips auto-move-to-review (card already in `done`)

**Moving to `archive`:**
1. Fire-and-forget: resume the existing session and send `/m` BEFORE removing the worktree (worktree must exist for SDK resume since session storage is keyed by cwd)
2. Card status updates immediately in DB
3. Worktree removal is deferred to the `/m` session's exit callback instead of happening inline

### Suppressing Auto-Move-to-Review

The session exit handler in `src/server/routers/claude.ts` auto-moves cards to `review` on exit. This needs a guard: re-read the card's current column from DB before moving, and skip if already in `done` or `archive`.

### Changes

1. **`src/server/routers/cards.ts` — `move` mutation:**
   - When moving to `done`/`archive` and card has `sessionId`, call `sessionManager.sendMemoryUpdate()`
   - For `archive`: fire `/m` first, then defer worktree removal to session exit callback (instead of inline removal)

2. **`src/server/claude/manager.ts` — new `sendMemoryUpdate` method:**
   - Accepts `sessionId`, `worktreePath`, `projectName`, and optionally a cleanup callback (for deferred worktree removal)
   - Resumes the session with the card's `worktreePath` as cwd
   - Sends `/m` as the prompt
   - On exit: runs cleanup callback (if any), no card status changes
   - Errors are logged but don't propagate (fire-and-forget)

3. **`src/server/routers/claude.ts` — session exit handler:**
   - Before auto-moving to `review`, re-read card column from DB
   - If already `done` or `archive`, skip the move

### Edge Cases

- **No sessionId:** Card was never worked on by Claude — skip silently
- **Session already running:** `sendMessage` on an active session works fine — the `/m` gets queued as a follow-up turn
- **Worktree removal fails after `/m`:** Log error, don't throw — same pattern as existing worktree cleanup
- **`/m` session errors out:** Log and discard — memory update is best-effort
- **Non-worktree projects (`useWorktree: false`):** `worktreePath` points to project base path, which always exists — resume works fine, no cleanup needed
