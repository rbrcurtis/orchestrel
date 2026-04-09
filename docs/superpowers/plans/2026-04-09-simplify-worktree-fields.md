# Simplify Worktree Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse three card worktree fields (`worktree_path`, `worktree_branch`, `use_worktree`) into one (`worktree_branch`). Null means no worktree; non-null means use worktree with that branch. The path is derived as `project.path + '/.worktrees/' + worktreeBranch`.

**Architecture:** Remove `worktreePath` and `useWorktree` from the Card entity, ws-protocol schemas, and all frontend/backend consumers. Add a `resolveWorkDir(worktreeBranch, projectPath)` helper to derive paths on the fly. The `defaultWorktree` boolean on Project stays — when true, card creation auto-sets `worktreeBranch = slugify(title)`.

**Tech Stack:** TypeScript, TypeORM (SQLite), Zod, React, MobX

---

### Task 1: Add `resolveWorkDir` helper and move `slugify` to shared

**Files:**
- Create: `src/shared/worktree.ts`
- Create: `src/shared/worktree.test.ts`
- Modify: `src/server/worktree.ts`

- [ ] **Step 1: Write the test**

Create `src/shared/worktree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveWorkDir, slugify } from './worktree';

describe('resolveWorkDir', () => {
  it('returns project path when branch is null', () => {
    expect(resolveWorkDir(null, '/home/user/project')).toBe('/home/user/project');
  });

  it('returns worktree path when branch is set', () => {
    expect(resolveWorkDir('my-feature', '/home/user/project')).toBe(
      '/home/user/project/.worktrees/my-feature',
    );
  });
});

describe('slugify', () => {
  it('converts title to branch-safe slug', () => {
    expect(slugify('Fix Login Bug')).toBe('fix-login-bug');
  });

  it('strips special chars and collapses dashes', () => {
    expect(slugify('hello!! world??')).toBe('hello-world');
  });

  it('truncates to 60 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/worktree.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/shared/worktree.ts`**

```ts
export function resolveWorkDir(worktreeBranch: string | null, projectPath: string): string {
  return worktreeBranch ? `${projectPath}/.worktrees/${worktreeBranch}` : projectPath;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
```

- [ ] **Step 4: Update `src/server/worktree.ts`**

Remove the `slugify` function body and re-export from shared:

```ts
export { slugify } from '../shared/worktree';
```

This keeps existing server-side imports working.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/shared/worktree.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/worktree.ts src/shared/worktree.test.ts src/server/worktree.ts
git commit -m "feat: add resolveWorkDir helper, move slugify to shared"
```

---

### Task 2: Remove `worktreePath` and `useWorktree` from Card entity

**Files:**
- Modify: `src/server/models/Card.ts`

- [ ] **Step 1: Remove the two columns from the entity**

In `src/server/models/Card.ts`, delete these blocks:

```ts
  @Column({ name: 'worktree_path', type: 'text', nullable: true })
  worktreePath!: string | null;
```

```ts
  @Column({ name: 'use_worktree', type: 'integer', default: 1 })
  useWorktree!: boolean;
```

- [ ] **Step 2: Update `beforeUpdate` hook**

In `CardSubscriber.beforeUpdate`, replace `!card.useWorktree` with `!card.worktreeBranch`:

Change line ~111:
```ts
    if (prev?.column !== 'running' && card.column === 'running' && !card.worktreeBranch && card.projectId) {
```

Replace the query filter. Change:

```ts
        const others = await Card.find({
          where: {
            column: 'running',
            projectId: card.projectId,
            useWorktree: false as unknown as boolean,
          },
        });
```

To:

```ts
        const others = await Card.createQueryBuilder('card')
          .where('card.column = :col', { col: 'running' })
          .andWhere('card.project_id = :pid', { pid: card.projectId })
          .andWhere('card.worktree_branch IS NULL')
          .getMany();
```

- [ ] **Step 3: Commit**

```bash
git add src/server/models/Card.ts
git commit -m "feat: remove worktreePath and useWorktree from Card entity"
```

---

### Task 3: Update ws-protocol schemas

**Files:**
- Modify: `src/shared/ws-protocol.ts`

- [ ] **Step 1: Remove fields from `cardSchema`**

Delete these two lines from `cardSchema`:

```ts
  worktreePath: z.string().nullable(),
  useWorktree: sqliteBool,
```

- [ ] **Step 2: Update `cardCreateSchema`**

Delete:

```ts
  useWorktree: z.boolean().optional(),
```

Add:

```ts
  worktreeBranch: z.string().nullable().optional(),
```

`cardUpdateSchema` merges `cardCreateSchema.partial()`, so `worktreeBranch` will automatically be available on update.

- [ ] **Step 3: Commit**

```bash
git add src/shared/ws-protocol.ts
git commit -m "feat: remove worktreePath/useWorktree from ws-protocol schemas"
```

---

### Task 4: Update `ensureWorktree` and session handler

**Files:**
- Modify: `src/server/sessions/worktree.ts`
- Modify: `src/server/ws/handlers/sessions.ts`

- [ ] **Step 1: Rewrite `ensureWorktree`**

Replace the entire file `src/server/sessions/worktree.ts`:

```ts
import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { createWorktree, worktreeExists, runSetupCommands, copyOpencodeConfig } from '../worktree';
import { resolveWorkDir } from '../../shared/worktree';

export async function ensureWorktree(card: Card): Promise<string> {
  if (!card.projectId) throw new Error(`Card ${card.id} has no project`);
  const proj = await Project.findOneByOrFail({ id: card.projectId });

  if (!card.worktreeBranch) return proj.path;

  const wtPath = resolveWorkDir(card.worktreeBranch, proj.path);
  console.log(`[session:${card.id}] ensureWorktree: branch=${card.worktreeBranch}, path=${wtPath}`);

  if (worktreeExists(wtPath)) return wtPath;

  console.log(`[session:${card.id}] creating worktree at ${wtPath}`);
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined;
  createWorktree(proj.path, wtPath, card.worktreeBranch, source);

  if (proj.setupCommands) {
    console.log(`[session:${card.id}] running setup commands...`);
    runSetupCommands(wtPath, proj.setupCommands);
    console.log(`[session:${card.id}] setup commands done`);
  }
  copyOpencodeConfig(proj.path, wtPath);

  return wtPath;
}
```

- [ ] **Step 2: Update session load handler**

In `src/server/ws/handlers/sessions.ts`, find:

```ts
      let dir = card?.worktreePath ?? undefined;
      if (!dir && card?.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        dir = proj?.path;
      }
```

Replace with:

```ts
      let dir: string | undefined;
      if (card?.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        if (proj) {
          const { resolveWorkDir } = await import('../../../shared/worktree');
          dir = resolveWorkDir(card.worktreeBranch, proj.path);
        }
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/worktree.ts src/server/ws/handlers/sessions.ts
git commit -m "feat: derive worktree path instead of reading stored field"
```

---

### Task 5: Update `oc.ts` and `queue-gate`

**Files:**
- Modify: `src/server/controllers/oc.ts`
- Modify: `src/server/services/queue-gate.ts`

- [ ] **Step 1: Update `registerAutoStart` in `oc.ts`**

Replace all `useWorktree` checks with `worktreeBranch` null checks:

Line ~119 (card entering running — non-worktree gate):
```ts
      if (!fullCard.worktreeBranch && fullCard.projectId) {
```

Line ~137 (direct start log):
```ts
        `(worktree=${!!card.worktreeBranch}, project=${card.projectId})`,
```

Line ~158 (card left running):
```ts
      if (!card.worktreeBranch && card.projectId) {
```

- [ ] **Step 2: Update `registerWorktreeCleanup` in `oc.ts`**

Line ~185:
```ts
    if (!c.worktreeBranch || !c.projectId) return;
```

Derive the path instead of reading `c.worktreePath`:

```ts
    try {
      const proj = await Project.findOneBy({ id: c.projectId });
      if (!proj) return;

      const { resolveWorkDir } = await import('../../shared/worktree');
      const wtPath = resolveWorkDir(c.worktreeBranch, proj.path);
      const { removeWorktree, worktreeExists } = await import('../worktree');
      if (worktreeExists(wtPath)) {
        removeWorktree(proj.path, wtPath);
        console.log(`[oc:worktree] removed ${wtPath}`);
      }
    } catch (err) {
      console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err);
    }
```

- [ ] **Step 3: Update exit handler in `registerCardSession`**

Line ~83:
```ts
    if (freshCard && !freshCard.worktreeBranch && freshCard.projectId) {
```

- [ ] **Step 4: Update `queue-gate.ts`**

Replace the `useWorktree: false` filter. Change:

```ts
  const group = await Card.find({
    where: {
      column: 'running',
      projectId,
      useWorktree: false as unknown as boolean,
    },
    order: { queuePosition: 'ASC' },
  });
```

To:

```ts
  const group = await Card.createQueryBuilder('card')
    .where('card.column = :col', { col: 'running' })
    .andWhere('card.project_id = :pid', { pid: projectId })
    .andWhere('card.worktree_branch IS NULL')
    .orderBy('card.queue_position', 'ASC')
    .getMany();
```

- [ ] **Step 5: Commit**

```bash
git add src/server/controllers/oc.ts src/server/services/queue-gate.ts
git commit -m "feat: replace useWorktree checks with worktreeBranch null checks"
```

---

### Task 6: Update card service (create defaults)

**Files:**
- Modify: `src/server/services/card.ts`

- [ ] **Step 1: Update `createCard`**

Replace line ~57:
```ts
        data.useWorktree = data.useWorktree ?? proj.defaultWorktree;
```

With:
```ts
        if (proj.defaultWorktree && !data.worktreeBranch && data.title) {
          const { slugify } = await import('../../shared/worktree');
          data.worktreeBranch = slugify(data.title);
        }
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services/card.ts
git commit -m "feat: auto-set worktreeBranch from title when project defaults to worktree"
```

---

### Task 7: Update frontend — CardDetail

**Files:**
- Modify: `app/components/CardDetail.tsx`

- [ ] **Step 1: Add import**

Add at top of file:

```ts
import { slugify } from '~/shared/worktree';
```

- [ ] **Step 2: Update Draft interface**

Replace `useWorktree: boolean` with `worktreeBranch: string | null` (~line 49).

- [ ] **Step 3: Update draft initialization in CardEditor**

Replace all `useWorktree` references in draft state with `worktreeBranch: card.worktreeBranch`:

- Initial draft (~line 82): `worktreeBranch: card.worktreeBranch,`
- Reset on card change (~line 105): `worktreeBranch: card.worktreeBranch,`
- External update sync (~line 134): `worktreeBranch: card.worktreeBranch,`
- Dirty check (~line 157): `draft.worktreeBranch !== card.worktreeBranch ||`
- Save payload (~line 173): `worktreeBranch: merged.worktreeBranch,`

Remove `useWorktree` from all these locations.

- [ ] **Step 4: Update "Use worktree" checkbox**

~Line 399-411, update the checkbox:

```tsx
  <Checkbox
    id="useWorktree"
    checked={!!draft.worktreeBranch}
    disabled={!!card.worktreeBranch}
    onCheckedChange={(checked) => {
      const branch = checked === true ? slugify(draft.title || card.title) : null;
      setDraft((d) => ({ ...d, worktreeBranch: branch }));
      saveAll({ worktreeBranch: branch });
    }}
  />
```

- [ ] **Step 5: Update source branch visibility**

~Line 416:
```tsx
  {!!selectedProject?.isGitRepo && !!draft.worktreeBranch && (
```

- [ ] **Step 6: Update project change handler**

~Line 362-365, replace:
```ts
  useWorktree: proj?.isGitRepo ? (proj.defaultWorktree ?? false) : false,
```
With:
```ts
  worktreeBranch: proj?.isGitRepo && proj.defaultWorktree ? slugify(draft.title || card.title) : null,
```

- [ ] **Step 7: Update CopyPathButton**

Update call site (~line 283-290):

```tsx
  <CopyPathButton
    worktreeBranch={card.worktreeBranch}
    projectPath={cardProject?.path}
    sourceBranch={card.sourceBranch}
    color={card.worktreeBranch && cardProject?.color ? cardProject.color : undefined}
  />
```

Rewrite function (~line 839-886):

```tsx
function CopyPathButton({
  worktreeBranch,
  projectPath,
  sourceBranch,
  color,
}: {
  worktreeBranch: string | null;
  projectPath?: string;
  sourceBranch?: string | null;
  color?: string;
}) {
  const [copied, setCopied] = useState(false);
  const path = worktreeBranch && projectPath
    ? `${projectPath}/.worktrees/${worktreeBranch}`
    : projectPath;

  function handleCopy() {
    if (!path) return;
    navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const tooltip = worktreeBranch
    ? `${worktreeBranch} from ${sourceBranch ?? 'main'}`
    : path
      ? `Copy path: ${path}`
      : 'No path available';

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!path}
      title={tooltip}
      className="flex items-center shrink-0 hover:opacity-70 transition-opacity disabled:opacity-30 disabled:cursor-default"
      style={worktreeBranch && color ? { color, filter: `drop-shadow(0 0 4px ${color})` } : undefined}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <GitBranch className={cn('size-3.5', !worktreeBranch && 'text-dim')} />
      )}
    </button>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add app/components/CardDetail.tsx
git commit -m "feat: replace useWorktree with worktreeBranch in CardDetail"
```

---

### Task 8: Update frontend — NewCard, card-store, board.index

**Files:**
- Modify: `app/components/CardDetail.tsx` (NewCard section)
- Modify: `app/stores/card-store.ts`
- Modify: `app/routes/board.index.tsx`

- [ ] **Step 1: Update NewCard draft initialization**

~Line 578-601, replace `useWorktree` with `worktreeBranch`:

```ts
  const [draft, setDraft] = useState<Draft>(() => {
    if (initialProjectId != null) {
      const proj = projectStore.getProject(initialProjectId);
      if (proj) {
        return {
          title: '',
          description: '',
          projectId: initialProjectId,
          worktreeBranch: null,
          sourceBranch: null,
          model: proj.defaultModel ?? 'sonnet',
          thinkingLevel: proj.defaultThinkingLevel ?? 'high',
        };
      }
    }
    return {
      title: '',
      description: '',
      projectId: null,
      worktreeBranch: null,
      sourceBranch: null,
      model: 'sonnet',
      thinkingLevel: 'high',
    };
  });
```

Note: `worktreeBranch` starts null because we can't slugify an empty title. The server-side `createCard` will auto-set it if the project has `defaultWorktree=true`.

- [ ] **Step 2: Update NewCard `handleSave`**

~Line 622-631:

```ts
  const card = await cardStore.createCard({
    title: draft.title,
    description: draft.description || undefined,
    column: selectedColumn as Column,
    projectId: draft.projectId,
    worktreeBranch: draft.worktreeBranch,
    sourceBranch: draft.sourceBranch as 'main' | 'dev' | null | undefined,
    model: draft.model,
    thinkingLevel: draft.thinkingLevel,
  });
```

- [ ] **Step 3: Update NewCard project change handler**

~Line 721-724:

```ts
  worktreeBranch: proj?.isGitRepo && proj.defaultWorktree ? (slugify(d.title) || null) : null,
```

- [ ] **Step 4: Update NewCard checkbox**

~Line 752-755:

```tsx
  <Checkbox
    id="newUseWorktree"
    checked={!!draft.worktreeBranch}
    onCheckedChange={(checked) => setDraft((d) => ({
      ...d,
      worktreeBranch: checked === true ? (slugify(d.title) || null) : null,
    }))}
  />
```

- [ ] **Step 5: Update NewCard source branch visibility**

~Line 763:

```tsx
  {!!selectedProject?.isGitRepo && !!draft.worktreeBranch && (
```

- [ ] **Step 6: Update card-store.ts**

Replace `useWorktree?: boolean` with `worktreeBranch?: string | null` in both `createCard` and `updateCard` method parameter types.

In `createCard` payload, replace `useWorktree: data.useWorktree` with `worktreeBranch: data.worktreeBranch`.

In `quickCreate`, remove `useWorktree: false` (server defaults `worktreeBranch` to null).

- [ ] **Step 7: Update board.index.tsx CardItem**

Remove `worktreePath: string | null;` from the `CardItem` interface (~line 53). Keep `worktreeBranch`.

- [ ] **Step 8: Commit**

```bash
git add app/components/CardDetail.tsx app/stores/card-store.ts app/routes/board.index.tsx
git commit -m "feat: replace useWorktree with worktreeBranch across frontend"
```

---

### Task 9: Update tests

**Files:**
- Modify: `src/shared/ws-protocol.test.ts`
- Modify: `src/server/models/Card.test.ts`
- Modify: `src/server/api/controllers/cards.test.ts`
- Modify: `app/lib/resolve-pin.test.ts`
- Modify: `app/lib/use-slots.hook.test.ts`
- Modify: `app/lib/use-slots.test.ts`

- [ ] **Step 1: Update test card fixtures**

In every test file that builds a card fixture, remove `worktreePath` and `useWorktree` properties. Keep `worktreeBranch`.

`src/shared/ws-protocol.test.ts` — three fixtures: remove `worktreePath: null,` and `useWorktree: true/false,` lines.

`src/server/models/Card.test.ts` (~line 106-108): remove `worktreePath: '/tmp/wt',` and `useWorktree: true,`. Also remove the assertion `expect(plain).not.toHaveProperty('worktreePath')` (~line 129).

`src/server/api/controllers/cards.test.ts` (~line 78): remove `expect(card).not.toHaveProperty('worktreePath')`.

`app/lib/resolve-pin.test.ts` (~lines 15-17): remove `worktreePath: null,` and `useWorktree: true,`.

`app/lib/use-slots.hook.test.ts` (~lines 18-20): remove `worktreePath: null,` and `useWorktree: true,`.

`app/lib/use-slots.test.ts` (~lines 24-26): remove `worktreePath: null,` and `useWorktree: true,`.

- [ ] **Step 2: Run all tests**

Run: `pnpm vitest run`
Expected: All tests pass (except the pre-existing provider config failures in 4 test files).

- [ ] **Step 3: Commit**

```bash
git add src/shared/ws-protocol.test.ts src/server/models/Card.test.ts src/server/api/controllers/cards.test.ts app/lib/resolve-pin.test.ts app/lib/use-slots.hook.test.ts app/lib/use-slots.test.ts
git commit -m "test: update fixtures to remove worktreePath and useWorktree"
```

---

### Task 10: DB migration script

**Files:**
- Create: `scripts/migrate-worktree-fields.ts`

- [ ] **Step 1: Write the migration script**

Create `scripts/migrate-worktree-fields.ts`:

```ts
#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import arg from 'arg';

const args = arg({ '--db': String, '--dry-run': Boolean });
const dbPath = args['--db'] ?? 'data/orchestrel.db';
const dryRun = args['--dry-run'] ?? false;

function main() {
  const db = new Database(dbPath);

  // Backfill: cards with use_worktree=1 but no worktree_branch get branch from title
  const needBranch = db
    .prepare('SELECT id, title FROM cards WHERE use_worktree = 1 AND worktree_branch IS NULL')
    .all() as { id: number; title: string }[];

  for (const row of needBranch) {
    const slug = row.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    console.log(`  card ${row.id}: set worktree_branch = '${slug}' (from title '${row.title}')`);
    if (!dryRun) {
      db.prepare('UPDATE cards SET worktree_branch = ? WHERE id = ?').run(slug, row.id);
    }
  }

  // Report cards with use_worktree=0 but worktree_branch set (keep branch as source of truth)
  const ambiguous = db
    .prepare('SELECT id, worktree_branch FROM cards WHERE use_worktree = 0 AND worktree_branch IS NOT NULL')
    .all() as { id: number; worktree_branch: string }[];

  if (ambiguous.length > 0) {
    console.log(`\nNote: ${ambiguous.length} card(s) have use_worktree=0 but worktree_branch set.`);
    console.log('Keeping worktree_branch (branch is source of truth).');
    for (const row of ambiguous) {
      console.log(`  card ${row.id}: keeping worktree_branch='${row.worktree_branch}'`);
    }
  }

  if (!dryRun) {
    console.log('\nDropping columns...');
    db.exec('ALTER TABLE cards DROP COLUMN worktree_path');
    console.log('  dropped worktree_path');
    db.exec('ALTER TABLE cards DROP COLUMN use_worktree');
    console.log('  dropped use_worktree');
  } else {
    console.log('\n[dry-run] Would drop columns: worktree_path, use_worktree');
  }

  db.close();
  console.log('Done.');
}

main();
```

- [ ] **Step 2: Run with --dry-run first**

Run: `pnpm tsx scripts/migrate-worktree-fields.ts --dry-run`
Expected: Shows what would change, no mutations.

- [ ] **Step 3: Back up the DB, then run for real**

```bash
cp data/orchestrel.db data/orchestrel-pre-worktree-migration.db
pnpm tsx scripts/migrate-worktree-fields.ts
```

- [ ] **Step 4: Verify the schema**

```bash
sqlite3 data/orchestrel.db ".schema cards" | grep -E 'worktree|use_worktree'
```

Expected: Only `worktree_branch` remains.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-worktree-fields.ts
git commit -m "feat: migration script to drop worktree_path and use_worktree columns"
```

---

### Task 11: Verify end-to-end

- [ ] **Step 1: Restart the service**

```bash
sudo systemctl restart orchestrel
```

- [ ] **Step 2: Verify board loads**

Open `http://localhost:6194` — board should render, cards should display without errors.

- [ ] **Step 3: Verify worktree indicator**

Open a card with `worktree_branch` set — the git branch icon should glow with the project color.

- [ ] **Step 4: Verify new card creation with worktree**

Create a new card on a project with `defaultWorktree=true`. After save, `worktree_branch` should be auto-set from the title.

- [ ] **Step 5: Verify non-worktree card**

Create a card with the checkbox unchecked. `worktree_branch` should be null.
