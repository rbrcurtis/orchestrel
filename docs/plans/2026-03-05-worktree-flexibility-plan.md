# Worktree Flexibility & Session Resumption — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support arbitrary folders as repos, optional worktrees with configurable source branches, and Claude session resumption for reopened cards.

**Architecture:** Add `isGitRepo`/`defaultBranch` to repos (auto-detected), `useWorktree`/`sourceBranch` to cards. Rework the card move logic to handle worktree creation/recreation/skip based on these flags. Add `--resume` support to Claude subprocess spawning.

**Tech Stack:** Drizzle ORM (SQLite), tRPC, React, shadcn/ui

---

### Task 1: Add shadcn checkbox component

**Files:**
- Create: `app/components/ui/checkbox.tsx`

**Step 1: Install checkbox**

Run: `pnpm dlx shadcn@latest add checkbox`

If the CLI fails (it has before in this project — see design doc), manually create the component using the shadcn registry.

**Step 2: Verify import works**

Run: `pnpm build 2>&1 | head -20`
Expected: No new errors related to checkbox import.

**Step 3: Commit**

```bash
git add app/components/ui/checkbox.tsx
git commit -m "feat: add shadcn checkbox component"
```

---

### Task 2: Schema changes — repos table

**Files:**
- Modify: `src/server/db/schema.ts`

**Step 1: Add columns to repos table**

Add `isGitRepo` and `defaultBranch` columns to the `repos` table definition:

```typescript
export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  path: text('path').notNull(),
  setupCommands: text('setup_commands').default(''),
  isGitRepo: integer('is_git_repo', { mode: 'boolean' }).notNull().default(false),
  defaultBranch: text('default_branch', { enum: ['main', 'dev'] }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
```

**Step 2: Push schema**

Run: `pnpm db:push`
Expected: Schema pushed successfully, new columns added.

**Step 3: Commit**

```bash
git add src/server/db/schema.ts
git commit -m "feat: add isGitRepo and defaultBranch to repos schema"
```

---

### Task 3: Schema changes — cards table

**Files:**
- Modify: `src/server/db/schema.ts`

**Step 1: Add columns to cards table**

Add `useWorktree` and `sourceBranch` columns:

```typescript
export const cards = sqliteTable('cards', {
  // ... existing columns ...
  useWorktree: integer('use_worktree', { mode: 'boolean' }).notNull().default(true),
  sourceBranch: text('source_branch', { enum: ['main', 'dev'] }),
  // ... existing columns ...
});
```

Place them after `worktreeBranch` and before `createdAt`.

**Step 2: Push schema**

Run: `pnpm db:push`
Expected: Schema pushed successfully.

**Step 3: Commit**

```bash
git add src/server/db/schema.ts
git commit -m "feat: add useWorktree and sourceBranch to cards schema"
```

---

### Task 4: Repo router — auto-detect isGitRepo, add `get` endpoint

**Files:**
- Modify: `src/server/routers/repos.ts`

**Step 1: Add isGitRepo detection helper**

At the top of the file, add:

```typescript
import { existsSync } from 'fs';
```

**Step 2: Update `create` mutation**

Auto-detect `isGitRepo` on create. Add `defaultBranch` to input:

```typescript
create: publicProcedure
  .input(z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    setupCommands: z.string().optional(),
    defaultBranch: z.enum(['main', 'dev']).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    const isGitRepo = existsSync(join(input.path, '.git'));
    const [repo] = await ctx.db.insert(repos)
      .values({ ...input, isGitRepo })
      .returning();
    return repo;
  }),
```

**Step 3: Update `update` mutation**

Re-detect `isGitRepo` when path changes. Add `defaultBranch` to input:

```typescript
update: publicProcedure
  .input(z.object({
    id: z.number(),
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    setupCommands: z.string().optional(),
    defaultBranch: z.enum(['main', 'dev']).nullable().optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    const { id, ...data } = input;
    if (data.path) {
      (data as Record<string, unknown>).isGitRepo = existsSync(join(data.path, '.git'));
    }
    const [repo] = await ctx.db.update(repos)
      .set(data)
      .where(eq(repos.id, id))
      .returning();
    return repo;
  }),
```

**Step 4: Add `get` endpoint**

New endpoint that re-scans `isGitRepo` from filesystem and updates DB if changed:

```typescript
get: publicProcedure
  .input(z.object({ id: z.number() }))
  .query(async ({ ctx, input }) => {
    const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, input.id));
    if (!repo) throw new Error(`Repo ${input.id} not found`);

    const isGitRepo = existsSync(join(repo.path, '.git'));
    if (isGitRepo !== repo.isGitRepo) {
      await ctx.db.update(repos)
        .set({ isGitRepo })
        .where(eq(repos.id, input.id));
      return { ...repo, isGitRepo };
    }
    return repo;
  }),
```

**Step 5: Verify build**

Run: `pnpm build 2>&1 | head -20`

**Step 6: Commit**

```bash
git add src/server/routers/repos.ts
git commit -m "feat: auto-detect isGitRepo, add defaultBranch, add repos.get endpoint"
```

---

### Task 5: Update worktree.ts — support existing branches and source branches

**Files:**
- Modify: `src/server/worktree.ts`

**Step 1: Update createWorktree signature**

Replace the current `createWorktree` with a version that handles both new and existing branches:

```typescript
export function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  sourceBranch?: string,
): void {
  try {
    // Try attaching existing branch first
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch {
    // Branch doesn't exist — create new branch from source
    const args = ['worktree', 'add', worktreePath, '-b', branch];
    if (sourceBranch) args.push(sourceBranch);
    execFileSync('git', args, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  }
}
```

**Step 2: Verify build**

Run: `pnpm build 2>&1 | head -20`

**Step 3: Commit**

```bash
git add src/server/worktree.ts
git commit -m "feat: worktree creation supports existing branches and source branch"
```

---

### Task 6: Rework card move logic

**Files:**
- Modify: `src/server/routers/cards.ts`

**Step 1: Add `useWorktree` and `sourceBranch` to card update input**

In the `update` mutation input, add:

```typescript
useWorktree: z.boolean().optional(),
sourceBranch: z.enum(['main', 'dev']).nullable().optional(),
```

**Step 2: Rewrite move-to-in_progress logic**

Replace the existing worktree creation block (lines 76-97) with:

```typescript
// Worktree / working directory setup when moving to in_progress
if (columnChanged && input.column === 'in_progress' && existing.repoId) {
  try {
    const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, existing.repoId));
    if (repo) {
      if (!existing.useWorktree) {
        // Non-worktree mode: work directly in repo path
        updates.worktreePath = repo.path;
      } else {
        // Worktree mode
        const slug = existing.worktreeBranch || slugify(existing.title);
        const wtPath = existing.worktreePath || `${repo.path}/.worktrees/${slug}`;
        const branch = slug;
        const source = existing.sourceBranch ?? repo.defaultBranch ?? undefined;

        if (!worktreeExists(wtPath)) {
          createWorktree(repo.path, wtPath, branch, source);
          if (repo.setupCommands) {
            runSetupCommands(wtPath, repo.setupCommands);
          }
        }

        updates.worktreePath = wtPath;
        updates.worktreeBranch = branch;
      }
    }
  } catch (err) {
    console.error(`Failed to set up working directory for card ${existing.id}:`, err);
  }
}
```

**Step 3: Rewrite move-to-done logic**

Replace the existing worktree removal block (lines 99-127) with:

```typescript
// Worktree removal when moving to done (preserve path/branch/session fields)
if (columnChanged && input.column === 'done' && existing.useWorktree && existing.worktreePath && existing.repoId) {
  try {
    const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, existing.repoId));
    if (repo && worktreeExists(existing.worktreePath)) {
      try {
        removeWorktree(repo.path, existing.worktreePath);
      } catch (err) {
        console.error(`Failed to remove worktree for card ${existing.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`Failed to clean up worktree for card ${existing.id}:`, err);
  }
  // Do NOT null worktreePath, worktreeBranch, or sessionId — needed for resumption
}
```

Key changes from current code:
- No `updates.worktreePath = null` / `updates.worktreeBranch = null`
- No `git branch -d` — branch is preserved for resumption
- Only removes worktree if `useWorktree` is true

**Step 4: Verify build**

Run: `pnpm build 2>&1 | head -20`

**Step 5: Commit**

```bash
git add src/server/routers/cards.ts
git commit -m "feat: rework card move logic for optional worktrees and resumption"
```

---

### Task 7: Claude session resumption

**Files:**
- Modify: `src/server/claude/protocol.ts`
- Modify: `src/server/claude/manager.ts`
- Modify: `src/server/routers/claude.ts`

**Step 1: Add resumeSessionId to ClaudeSession constructor**

In `src/server/claude/protocol.ts`, update the constructor and `start()`:

```typescript
export class ClaudeSession extends EventEmitter {
  process: ChildProcess | null = null;
  sessionId: string | null = null;
  status: SessionStatus = 'starting';

  constructor(
    private cwd: string,
    private resumeSessionId?: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    const args = [
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--verbose',
      '--permission-mode=bypassPermissions',
    ];

    if (this.resumeSessionId) {
      args.unshift('--resume', this.resumeSessionId);
    } else {
      args.unshift('-p');
    }

    this.process = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // ... rest of start() unchanged ...
```

**Step 2: Update SessionManager.create**

In `src/server/claude/manager.ts`:

```typescript
create(cardId: number, cwd: string, resumeSessionId?: string): ClaudeSession {
  const key = `card-${cardId}`;
  const existing = this.sessions.get(key);
  if (existing && existing.status === 'running') {
    throw new Error(`Session already running for card ${cardId}`);
  }
  const session = new ClaudeSession(cwd, resumeSessionId);
  this.sessions.set(key, session);
  return session;
}
```

**Step 3: Update claude.start mutation**

In `src/server/routers/claude.ts`, change the start mutation:

```typescript
start: publicProcedure
  .input(z.object({ cardId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
    if (!card) throw new Error(`Card ${input.cardId} not found`);
    if (!card.worktreePath) throw new Error(`Card ${input.cardId} has no working directory`);

    const isResume = !!card.sessionId;
    const session = sessionManager.create(
      input.cardId,
      card.worktreePath,
      card.sessionId ?? undefined,
    );
    await session.start();

    // Wait for the system init message to capture session_id
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000);

      const onMessage = (msg: Record<string, unknown>) => {
        if (msg.type === 'system' && msg.subtype === 'init' && session.sessionId) {
          clearTimeout(timeout);
          session.off('message', onMessage);
          resolve();
        }
      };
      session.on('message', onMessage);

      session.on('exit', () => {
        clearTimeout(timeout);
        session.off('message', onMessage);
        reject(new Error('Session exited before init'));
      });
    });

    // Update card with sessionId (may be new or same)
    await ctx.db.update(cards)
      .set({ sessionId: session.sessionId, updatedAt: new Date().toISOString() })
      .where(eq(cards.id, input.cardId));

    // Only send initial prompt for new sessions
    if (!isResume) {
      if (!card.description?.trim()) throw new Error(`Card ${input.cardId} has no description`);
      session.sendUserMessage(card.description.trim());
    }

    return { status: 'started' as const };
  }),
```

Key changes:
- Description check moved to after init (only required for new sessions)
- `card.sessionId` passed to `sessionManager.create` for resume
- Initial prompt only sent for non-resume sessions

**Step 4: Verify build**

Run: `pnpm build 2>&1 | head -20`

**Step 5: Commit**

```bash
git add src/server/claude/protocol.ts src/server/claude/manager.ts src/server/routers/claude.ts
git commit -m "feat: Claude session resumption via --resume flag"
```

---

### Task 8: Repo settings UI — defaultBranch and isGitRepo display

**Files:**
- Modify: `app/components/RepoForm.tsx`
- Modify: `app/routes/settings.repos.tsx`

**Step 1: Update RepoForm interface and state**

Add `isGitRepo` and `defaultBranch` to the `Repo` interface and form state in `app/components/RepoForm.tsx`:

```typescript
interface Repo {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
}
```

Add state:

```typescript
const [defaultBranch, setDefaultBranch] = useState(repo?.defaultBranch ?? '');
```

**Step 2: Add defaultBranch dropdown to form**

After the Setup Commands field, add a conditional `defaultBranch` select. Use the `isGitRepo` from the directory browser's detection (for new repos) or from the repo data (for editing). For editing, call `repos.get` to get fresh detection:

```tsx
{/* Default Branch — only for git repos */}
{isGitRepo && (
  <div>
    <label className="block text-sm font-medium text-muted-foreground mb-1">Default Branch</label>
    <Select
      value={defaultBranch}
      onValueChange={setDefaultBranch}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select branch..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="main">main</SelectItem>
        <SelectItem value="dev">dev</SelectItem>
      </SelectContent>
    </Select>
  </div>
)}
```

To track `isGitRepo` for new repos, capture it from the DirectoryBrowser's `onSelect` callback. The `repos.browse` endpoint already returns `isGitRepo`. Update the `onSelect` handler:

```typescript
const [isGitRepo, setIsGitRepo] = useState(repo?.isGitRepo ?? false);
```

The DirectoryBrowser needs to pass `isGitRepo` back. Update its `onSelect` type from `(path: string) => void` to `(path: string, isGitRepo: boolean) => void`.

For editing existing repos, use `repos.get` query to refresh detection:

```typescript
const { data: freshRepo } = useQuery(
  trpc.repos.get.queryOptions(
    { id: repo!.id },
    { enabled: !!repo }
  )
);
useEffect(() => {
  if (freshRepo) setIsGitRepo(freshRepo.isGitRepo);
}, [freshRepo]);
```

**Step 3: Include defaultBranch in submit data**

Update `handleSubmit` to include `defaultBranch`:

```typescript
const data = {
  name: name.trim(),
  path: path.trim(),
  setupCommands: setupCommands || undefined,
  defaultBranch: isGitRepo && defaultBranch ? defaultBranch : undefined,
};
```

**Step 4: Update validation**

Git repos should require `defaultBranch`:

```typescript
const isValid = name.trim() && path.trim() && (!isGitRepo || defaultBranch);
```

**Step 5: Update settings.repos.tsx Repo interface**

In `app/routes/settings.repos.tsx`, add the new fields to the `Repo` interface:

```typescript
interface Repo {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  createdAt: string;
}
```

**Step 6: Update DirectoryBrowser**

In `app/components/DirectoryBrowser.tsx`:

- Change `onSelect` prop type to `(path: string, isGitRepo: boolean) => void`
- Update the Select button to always be enabled (remove `disabled={!data?.isGitRepo}`)
- Pass `isGitRepo` in the onSelect call:

```tsx
<Button
  onClick={() => onSelect(currentPath, data?.isGitRepo ?? false)}
>
  Select
</Button>
```

**Step 7: Update RepoForm DirectoryBrowser usage**

```tsx
<DirectoryBrowser
  initialPath={path || '/home/ryan'}
  onSelect={(selected, gitRepo) => {
    setPath(selected);
    setIsGitRepo(gitRepo);
    setShowBrowser(false);
  }}
  onCancel={() => setShowBrowser(false)}
/>
```

**Step 8: Verify build**

Run: `pnpm build 2>&1 | head -20`

**Step 9: Commit**

```bash
git add app/components/RepoForm.tsx app/components/DirectoryBrowser.tsx app/routes/settings.repos.tsx
git commit -m "feat: repo settings UI with defaultBranch and non-git folder support"
```

---

### Task 9: Card detail UI — useWorktree checkbox and sourceBranch dropdown

**Files:**
- Modify: `app/components/CardDetailPanel.tsx`

**Step 1: Update CardData and RepoData types**

```typescript
type CardData = {
  id: number;
  title: string;
  description: string | null;
  column: string;
  priority: string;
  repoId: number | null;
  prUrl: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  useWorktree: boolean;
  sourceBranch: string | null;
};

type RepoData = {
  id: number;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
};
```

**Step 2: Add imports**

```typescript
import { Checkbox } from '~/components/ui/checkbox';
```

**Step 3: Add useWorktree and sourceBranch to EditableFields**

After the Repository select in `EditableFields`, add:

```tsx
{/* Use Worktree */}
{selectedRepo?.isGitRepo && (
  <div className="flex items-center gap-2">
    <Checkbox
      id="useWorktree"
      checked={card.useWorktree}
      onCheckedChange={(checked) => onUpdate({ useWorktree: checked === true })}
    />
    <label htmlFor="useWorktree" className="text-sm font-medium text-muted-foreground">
      Use worktree
    </label>
  </div>
)}

{/* Non-git repo indicator */}
{card.repoId && selectedRepo && !selectedRepo.isGitRepo && (
  <p className="text-xs text-muted-foreground">
    Working directory (not a git repo)
  </p>
)}

{/* Source Branch */}
{selectedRepo?.isGitRepo && card.useWorktree && (
  <div>
    <label className="block text-xs font-medium text-muted-foreground mb-1">
      Source Branch
    </label>
    <Select
      value={card.sourceBranch ?? selectedRepo.defaultBranch ?? ''}
      onValueChange={(val) => onUpdate({ sourceBranch: val })}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="main">main</SelectItem>
        <SelectItem value="dev">dev</SelectItem>
      </SelectContent>
    </Select>
  </div>
)}
```

The `EditableFields` function needs access to the selected repo. Update its props to pass `repos` as the full repo data (with `isGitRepo` and `defaultBranch`):

```typescript
function EditableFields({
  card,
  repos,
  onUpdate,
}: {
  card: CardData;
  repos: RepoData[];
  onUpdate: (data: { priority?: string; repoId?: number | null; useWorktree?: boolean; sourceBranch?: string | null }) => void;
}) {
  const selectedRepo = repos.find(r => r.id === card.repoId);
  // ... rest of component
```

**Step 4: Update card update mutation input**

In the `update` mutation in `src/server/routers/cards.ts`, ensure `useWorktree` and `sourceBranch` are accepted:

```typescript
useWorktree: z.boolean().optional(),
sourceBranch: z.enum(['main', 'dev']).nullable().optional(),
```

(This was noted in Task 6 Step 1 but listed here as a reminder — make sure it's included.)

**Step 5: Update SessionView start button label**

In `app/components/SessionView.tsx`, in the `StartSessionForm`, change the button text based on whether a session already exists. Pass `sessionId` as a prop:

Update `SessionView` props and the `StartSessionForm`:

```typescript
type Props = {
  cardId: number;
  sessionId?: string | null;
};

export function SessionView({ cardId, sessionId }: Props) {
  // ... existing code ...

  if (!sessionActive && messages.length === 0) {
    return <StartSessionForm cardId={cardId} isResume={!!sessionId} />;
  }
  // ...
}
```

```typescript
function StartSessionForm({ cardId, isResume }: { cardId: number; isResume: boolean }) {
  // ... existing mutation code ...

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 space-y-3">
      <Button
        onClick={() => startMutation.mutate({ cardId })}
        disabled={startMutation.isPending}
        className="w-full"
      >
        <Play className="size-4" />
        {startMutation.isPending
          ? (isResume ? 'Resuming...' : 'Starting...')
          : (isResume ? 'Resume Session' : 'Start Session')}
      </Button>
      {/* ... error display ... */}
    </div>
  );
}
```

Update `InProgressContent` to pass `sessionId`:

```tsx
function InProgressContent({ card }: { card: CardData }) {
  return (
    <div>
      {card.repoId || card.worktreePath ? (
        <SessionView cardId={card.id} sessionId={card.sessionId} />
      ) : (
        <div className="text-sm text-muted-foreground italic">
          No repo linked - assign a repo to enable Claude sessions
        </div>
      )}
    </div>
  );
}
```

**Step 6: Verify build**

Run: `pnpm build 2>&1 | head -20`

**Step 7: Commit**

```bash
git add app/components/CardDetailPanel.tsx app/components/SessionView.tsx src/server/routers/cards.ts
git commit -m "feat: card UI with useWorktree checkbox, sourceBranch, and resume button"
```

---

### Task 10: Backfill existing repos with isGitRepo detection

**Files:**
- No new files — one-time DB operation

**Step 1: Run backfill**

After all schema changes are pushed, backfill existing repos by opening Drizzle Studio or running a quick script:

Run: `pnpm db:push` (ensure schema is current)

Then scan existing repos. This can be done via the app itself: open repo settings, click edit on each repo, save — the update mutation will auto-detect `isGitRepo`. Or write a quick one-liner:

```bash
node -e "
const Database = require('better-sqlite3');
const { existsSync } = require('fs');
const { join } = require('path');
const db = new Database('./data/conductor.db');
const repos = db.prepare('SELECT id, path FROM repos').all();
for (const r of repos) {
  const isGit = existsSync(join(r.path, '.git')) ? 1 : 0;
  db.prepare('UPDATE repos SET is_git_repo = ? WHERE id = ?').run(isGit, r.id);
  console.log(r.path, isGit ? 'git' : 'not git');
}
db.close();
"
```

**Step 2: Verify**

Run: `node -e "const db = require('better-sqlite3')('./data/conductor.db'); console.log(db.prepare('SELECT id, name, is_git_repo, default_branch FROM repos').all()); db.close();"`

Expected: Each repo shows correct `is_git_repo` value.

**Step 3: No commit needed** — this is a data-only operation.

---

### Task 11: Manual smoke test

No automated tests in this project. Verify manually:

1. **Repo settings:** Add a non-git folder (e.g., `/home/ryan/plans`). Confirm `defaultBranch` dropdown is hidden. Save succeeds.
2. **Repo settings:** Edit an existing git repo. Confirm `defaultBranch` dropdown appears (blank, required). Set it and save.
3. **Card detail:** Create a card linked to the non-git folder. Confirm `useWorktree` checkbox is not shown. Move to `in_progress`. Confirm `worktreePath` is set to the folder path.
4. **Card detail:** Create a card linked to a git repo. Confirm `useWorktree` checkbox appears (checked by default). Confirm `sourceBranch` dropdown appears showing repo's default.
5. **Card detail:** Uncheck `useWorktree` on a git-repo card. Confirm `sourceBranch` dropdown hides. Move to `in_progress`. Confirm no worktree created, `worktreePath` is repo root.
6. **Resumption:** Move a worktree card to `done`. Confirm worktree directory removed but card fields preserved. Move it back to `in_progress`. Confirm worktree recreated at same path.
7. **Claude resume:** On the reopened card, click "Resume Session". Confirm Claude starts with `--resume` flag and continues the previous conversation.
