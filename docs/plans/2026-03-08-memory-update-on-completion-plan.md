# Memory Update on Card Completion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a card moves to `done` or `archive`, resume its Claude session and send `/m` to store memories, fire-and-forget.

**Architecture:** Hook into `cards.move` mutation server-side. Add a `sendMemoryUpdate` method to `SessionManager` that creates a standalone `ClaudeSession` (not tracked in the sessions map), resumes it with `/m`, and cleans up on exit. Guard the existing auto-move-to-review exit handlers to skip if the card is already in `done`/`archive`. For `archive`, defer worktree removal to the memory session's exit callback.

**Tech Stack:** TypeScript, tRPC, Claude Agent SDK, Drizzle ORM

---

### Task 1: Guard session exit handlers against moving completed cards

**Files:**
- Modify: `src/server/routers/claude.ts:76-90` (start mutation exit handler)
- Modify: `src/server/routers/claude.ts:152-166` (sendMessage mutation exit handler)

**Step 1: Update the exit handler in the `start` mutation**

In `src/server/routers/claude.ts`, replace the exit handler at lines 76-90:

```typescript
session.on('exit', async () => {
  if (session.status !== 'completed' && session.status !== 'errored') return;
  try {
    // Re-read card to check current column — skip if already done/archive
    const [current] = await db.select({ column: cards.column })
      .from(cards).where(eq(cards.id, input.cardId));
    if (current?.column === 'done' || current?.column === 'archive') return;

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
});
```

**Step 2: Update the exit handler in the `sendMessage` mutation**

Same change at lines 152-166:

```typescript
session.on('exit', async () => {
  if (session!.status !== 'completed' && session!.status !== 'errored') return;
  try {
    const [current] = await db.select({ column: cards.column })
      .from(cards).where(eq(cards.id, input.cardId));
    if (current?.column === 'done' || current?.column === 'archive') return;

    await db.update(cards)
      .set({
        column: 'review',
        promptsSent: session!.promptsSent,
        turnsCompleted: session!.turnsCompleted,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(cards.id, input.cardId));
  } catch (err) {
    console.error(`Failed to auto-move card ${input.cardId} to review:`, err);
  }
});
```

**Step 3: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/server/routers/claude.ts
git commit -m "fix: guard session exit handler against moving done/archive cards"
```

---

### Task 2: Add `sendMemoryUpdate` to SessionManager

**Files:**
- Modify: `src/server/claude/manager.ts`

**Step 1: Add the method**

Add a `sendMemoryUpdate` method to the `SessionManager` class. This creates a standalone `ClaudeSession` (not stored in `this.sessions`) that resumes with `/m` and optionally runs a cleanup callback on exit.

In `src/server/claude/manager.ts`, add after the `kill` method (line 30):

```typescript
/** Fire-and-forget: resume a session and send /m to store memories */
sendMemoryUpdate(
  sessionId: string,
  cwd: string,
  projectName?: string,
  onComplete?: () => void,
): void {
  const session = new ClaudeSession(cwd, sessionId, projectName);
  session.on('exit', () => {
    try { onComplete?.(); } catch (err) {
      console.error('[memory-update] cleanup error:', err);
    }
  });
  session.start('/m').catch((err) => {
    console.error('[memory-update] failed to start:', err);
    try { onComplete?.(); } catch { /* ignore */ }
  });
}
```

**Step 2: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/server/claude/manager.ts
git commit -m "feat: add sendMemoryUpdate to SessionManager for fire-and-forget /m"
```

---

### Task 3: Hook memory update into `cards.move` mutation

**Files:**
- Modify: `src/server/routers/cards.ts`

**Step 1: Add imports**

At the top of `src/server/routers/cards.ts`, add the sessionManager import:

```typescript
import { sessionManager } from '../claude/manager';
import { db } from '../db';
```

**Step 2: Add memory update trigger for `done`**

In the `move` mutation, after the DB update at line 154 (`const [card] = await ctx.db.update(cards)...`) and before the `return card;`, add:

```typescript
// Fire-and-forget memory update when moving to done/archive
if (columnChanged && (input.column === 'done' || input.column === 'archive') && existing.sessionId) {
  // handled below per-column
}
```

Actually — the logic differs for `done` vs `archive`, so integrate it into the existing column-specific blocks. Here's the full approach:

After the existing DB update (`const [card] = ...returning()`) and before `return card`, add:

```typescript
// Fire-and-forget memory update when completing a card
if (columnChanged && existing.sessionId && existing.worktreePath) {
  if (input.column === 'done') {
    sessionManager.sendMemoryUpdate(existing.sessionId, existing.worktreePath, projectName);
  }
}
```

Note: `projectName` needs to be resolved. Since the project lookup already happens in the `in_progress` and `archive` blocks, extract it to run earlier. Refactor the project lookup to happen once near the top of the mutation when `existing.projectId` is set:

```typescript
// Resolve project once for all column-change logic
let project: { path: string; name: string; defaultBranch: string | null; setupCommands: string | null } | undefined;
let projectName: string | undefined;
if (columnChanged && existing.projectId) {
  const [p] = await ctx.db.select().from(projects).where(eq(projects.id, existing.projectId));
  if (p) {
    project = p;
    projectName = p.name.toLowerCase();
  }
}
```

Then update the `in_progress` and `archive` blocks to use `project` instead of doing their own lookups.

**Step 3: Handle archive — defer worktree removal**

Replace the archive block (lines 138-152) to fire `/m` first and defer worktree removal to the session exit callback:

```typescript
if (columnChanged && input.column === 'archive') {
  if (existing.sessionId && existing.worktreePath) {
    // Fire /m before removing worktree — removal deferred to exit callback
    const wtPath = existing.worktreePath;
    const repoPath = project?.path;
    const useWt = existing.useWorktree;
    sessionManager.sendMemoryUpdate(existing.sessionId, wtPath, projectName, () => {
      if (useWt && repoPath && wtPath && worktreeExists(wtPath)) {
        try {
          removeWorktree(repoPath, wtPath);
        } catch (err) {
          console.error(`Failed to remove worktree for card ${existing.id}:`, err);
        }
      }
    });
  } else if (existing.useWorktree && existing.worktreePath && project) {
    // No session — remove worktree immediately (existing behavior)
    if (worktreeExists(existing.worktreePath)) {
      try {
        removeWorktree(project.path, existing.worktreePath);
      } catch (err) {
        console.error(`Failed to remove worktree for card ${existing.id}:`, err);
      }
    }
  }
}
```

**Step 4: Build and verify**

Run: `pnpm build`
Expected: Clean build

**Step 5: Commit**

```bash
git add src/server/routers/cards.ts
git commit -m "feat: trigger /m memory update when card moves to done/archive"
```

---

### Task 4: Manual smoke test

**Step 1: Restart the service**

```bash
sudo systemctl restart dispatcher
```

**Step 2: Test done flow**

1. Move an existing card with a `sessionId` to `done`
2. Check server logs (`journalctl -u dispatcher -f`) for `/m` session activity
3. Verify card stays in `done` (not moved back to review)

**Step 3: Test archive flow**

1. Move a card from `done` to `archive`
2. Verify `/m` fires and worktree is removed after session exits
3. Check server logs for any errors

**Step 4: Test no-session card**

1. Move a card without a `sessionId` to `done`
2. Verify no errors, card moves normally
