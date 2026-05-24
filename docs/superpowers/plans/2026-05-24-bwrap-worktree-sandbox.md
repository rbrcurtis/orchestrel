# bwrap Worktree Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional bwrap filesystem isolation for worktree-backed Orchestrel agent sessions so absolute project-root paths resolve to the session worktree.

**Architecture:** Store sandbox preferences on projects and cards, pass sandbox launch metadata from the server to orcd, and have orcd wrap Claude Code with a small bwrap launcher only when a card uses both worktree and sandbox. The wrapper binds the host worktree to the canonical project path inside the namespace, exposes shared Git metadata through `.git-parent`, and overlays a synthetic `.git` pointer file.

**Tech Stack:** TypeScript strict mode, React, MobX, TypeORM, SQLite, socket.io protocol schemas, Vitest, Claude Agent SDK, Linux `bubblewrap`.

---

## File Structure

- Modify `src/server/models/Project.ts`: add `defaultSandbox` column.
- Modify `src/server/models/Card.ts`: add `sandbox` column.
- Modify `src/server/models/index.ts`: add safe SQLite `ALTER TABLE` migrations for `projects.default_sandbox` and `cards.sandbox`.
- Modify `src/shared/ws-protocol.ts`: expose `defaultSandbox` and `sandbox` in entity schemas and mutation schemas.
- Modify `src/server/services/project.ts`: clear `defaultSandbox` when a project is not a Git repo.
- Modify `src/server/services/project.test.ts`: cover `defaultSandbox` persistence and non-Git normalization.
- Modify `src/server/services/card.ts`: inherit `sandbox` from `Project.defaultSandbox` only when the created card uses a worktree; clear sandbox when updates remove the worktree.
- Modify `src/server/services/card.test.ts`: cover sandbox inheritance and clearing.
- Modify `app/stores/project-store.ts`: include `defaultSandbox` in create/update inputs.
- Modify `app/stores/card-store.ts`: include `sandbox` in create/update inputs.
- Modify `app/components/ProjectForm.tsx`: add project-level default sandbox checkbox gated by Git repo + default worktree.
- Modify `app/components/CardDetail.tsx`: add per-card sandbox checkbox gated by worktree, sync dirty state, and submit sandbox value.
- Modify `app/components/CardDetail.test.tsx`: cover sandbox checkbox behavior.
- Modify `app/routes/settings.projects.tsx`, `app/routes/board.index.tsx`, and affected tests only if local `Project`/`Card` interface literals require the new fields.
- Modify `src/shared/orcd-protocol.ts`: add optional `sandbox` metadata to create actions.
- Modify `src/server/orcd-client.ts`: pass sandbox metadata over the orcd protocol.
- Modify `src/server/controllers/card-sessions.ts`: pass `sandbox` launch metadata when starting a card session.
- Modify `src/server/controllers/card-sessions.test.ts`: assert sandbox metadata is sent for sandboxed worktree cards and omitted/disabled otherwise.
- Create `src/orcd/sandbox.ts`: validate sandbox paths, create synthetic `.git` pointer staging file, build bwrap executable/args/cwd/env metadata.
- Create `src/orcd/__tests__/sandbox.test.ts`: unit tests for bwrap argument construction and validation.
- Modify `src/orcd/session.ts`: accept optional sandbox config and feed Agent SDK `cwd`, `pathToClaudeCodeExecutable`, and `env` from the sandbox launcher.
- Modify `src/orcd/__tests__/session-async-tasks.test.ts`: cover sandboxed SDK options and unsandboxed behavior.
- Modify `src/orcd/socket-server.ts`: hydrate sandbox config from create action and fail closed on sandbox setup errors.
- Modify `src/orcd/__tests__/socket-server-compaction.test.ts` only if TypeScript fixtures require the widened protocol type.

---

## Task 1: Persist sandbox defaults on projects and cards

**Files:**
- Modify: `src/server/models/Project.ts`
- Modify: `src/server/models/Card.ts`
- Modify: `src/server/models/index.ts`
- Modify: `src/shared/ws-protocol.ts`
- Modify: `src/server/services/project.ts`
- Test: `src/server/services/project.test.ts`

- [ ] **Step 1: Write failing project service tests**

Add these tests inside `describe('ProjectService', () => { ... })` in `src/server/services/project.test.ts`:

```ts
  it('persists defaultSandbox for git projects', async () => {
    const { mkdtemp, mkdir } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { projectService } = await import('./project')

    const path = await mkdtemp(join(tmpdir(), 'orchestrel-git-project-'))
    await mkdir(join(path, '.git'))

    const created = await projectService.createProject({
      name: 'Sandbox Git',
      path,
      defaultWorktree: true,
      defaultSandbox: true,
    })

    expect(created.isGitRepo).toBe(true)
    expect(created.defaultWorktree).toBe(true)
    expect(created.defaultSandbox).toBe(true)

    const updated = await projectService.updateProject(created.id, { defaultSandbox: false })
    expect(updated.defaultSandbox).toBe(false)
  })

  it('clears defaultSandbox when project is not a git repo', async () => {
    const { projectService } = await import('./project')

    const project = await projectService.createProject({
      name: 'No Sandbox',
      path: tmpdir(),
      defaultWorktree: true,
      defaultSandbox: true,
    })

    expect(project.isGitRepo).toBe(false)
    expect(project.defaultWorktree).toBe(false)
    expect(project.defaultSandbox).toBe(false)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test -- src/server/services/project.test.ts
```

Expected: FAIL with TypeScript/runtime errors that `defaultSandbox` is not defined or not persisted.

- [ ] **Step 3: Add model columns**

In `src/server/models/Project.ts`, add after `defaultWorktree`:

```ts
  @Column({ name: 'default_sandbox', type: 'integer', default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number | boolean) => !!v } })
  defaultSandbox!: boolean;
```

In `src/server/models/Card.ts`, add after `worktreeBranch`:

```ts
  @Column({ type: 'integer', default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number | boolean) => !!v } })
  sandbox!: boolean;
```

- [ ] **Step 4: Add SQLite migrations**

In `src/server/models/index.ts`, after the existing `archived` migration block and before `await runner.release();`, add:

```ts
    try {
      await runner.query(`ALTER TABLE projects ADD COLUMN default_sandbox INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      console.log(`[db:migrate] default_sandbox column add skipped (likely already exists):`, err instanceof Error ? err.message : err);
    }
    try {
      await runner.query(`ALTER TABLE cards ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      console.log(`[db:migrate] cards.sandbox column add skipped (likely already exists):`, err instanceof Error ? err.message : err);
    }
    await runner.query(`UPDATE projects SET default_sandbox = 0 WHERE default_sandbox IS NULL`);
    await runner.query(`UPDATE cards SET sandbox = 0 WHERE sandbox IS NULL`);
```

- [ ] **Step 5: Add protocol fields**

In `src/shared/ws-protocol.ts`:

Add to `cardSchema` after `worktreeBranch`:

```ts
  sandbox: sqliteBool,
```

Add to `projectSchema` after `defaultWorktree`:

```ts
  defaultSandbox: sqliteBool,
```

Add to `cardCreateSchema` after `worktreeBranch`:

```ts
  sandbox: z.boolean().optional(),
```

Add to `projectCreateSchema` after `defaultWorktree`:

```ts
  defaultSandbox: z.boolean().optional(),
```

- [ ] **Step 6: Normalize non-Git project sandbox settings**

In `src/server/services/project.ts`, inside `createProject()` after detecting `isGitRepo`, add:

```ts
    if (!data.isGitRepo) {
      data.defaultWorktree = false;
      data.defaultSandbox = false;
    } else if (!data.defaultWorktree) {
      data.defaultSandbox = false;
    }
```

Inside `updateProject()`, after detecting `isGitRepo`, add:

```ts
    const nextIsGitRepo = data.isGitRepo ?? proj.isGitRepo;
    const nextDefaultWorktree = data.defaultWorktree ?? proj.defaultWorktree;
    if (!nextIsGitRepo) {
      data.defaultWorktree = false;
      data.defaultSandbox = false;
    } else if (!nextDefaultWorktree) {
      data.defaultSandbox = false;
    }
```

- [ ] **Step 7: Run project service tests**

Run:

```bash
pnpm test -- src/server/services/project.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/models/Project.ts src/server/models/Card.ts src/server/models/index.ts src/shared/ws-protocol.ts src/server/services/project.ts src/server/services/project.test.ts
git commit -m "Add sandbox persistence fields"
```

---

## Task 2: Inherit and clear card sandbox state

**Files:**
- Modify: `src/server/services/card.ts`
- Test: `src/server/services/card.test.ts`

- [ ] **Step 1: Write failing card service tests**

Add these tests inside `describe('CardService', () => { ... })` in `src/server/services/card.test.ts`:

```ts
  it('inherits sandbox when project defaults to worktree sandboxing', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')

    const project = await projectService.createProject({
      name: 'Sandbox Cards',
      path: '/tmp/sandbox-cards',
      isGitRepo: true,
      defaultWorktree: true,
      defaultSandbox: true,
    })

    const card = await cardService.createCard({
      title: 'Use Sandbox',
      description: 'd',
      projectId: project.id,
    })

    expect(card.worktreeBranch).toBe('use-sandbox')
    expect(card.sandbox).toBe(true)
  })

  it('does not enable sandbox when card has no worktree', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')

    const project = await projectService.createProject({
      name: 'Sandbox No Worktree',
      path: '/tmp/sandbox-no-worktree',
      isGitRepo: true,
      defaultWorktree: false,
      defaultSandbox: false,
    })

    const card = await cardService.createCard({
      title: 'No Worktree',
      description: 'd',
      projectId: project.id,
      sandbox: true,
    })

    expect(card.worktreeBranch).toBeNull()
    expect(card.sandbox).toBe(false)
  })

  it('clears sandbox when worktree is removed from a card', async () => {
    const { cardService } = await import('./card')

    const card = await cardService.createCard({
      title: 'Clear Sandbox',
      description: 'd',
      worktreeBranch: 'clear-sandbox',
      sandbox: true,
    })

    const updated = await cardService.updateCard(card.id, {
      worktreeBranch: null,
      sandbox: true,
    })

    expect(updated.worktreeBranch).toBeNull()
    expect(updated.sandbox).toBe(false)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test -- src/server/services/card.test.ts
```

Expected: FAIL because card sandbox inheritance/clearing is not implemented.

- [ ] **Step 3: Implement create inheritance**

In `src/server/services/card.ts`, inside `createCard()`, replace the project default block with this structure:

```ts
    if (data.projectId) {
      const proj = await Project.findOneBy({ id: data.projectId });
      if (proj) {
        providerID = proj.providerID ?? getDefaultProviderID();
        data.model = data.model ?? proj.defaultModel;
        data.thinkingLevel = data.thinkingLevel ?? proj.defaultThinkingLevel;
        if (proj.defaultWorktree && !data.worktreeBranch && data.title) {
          const { slugify } = await import('../../shared/worktree');
          data.worktreeBranch = slugify(data.title);
        }
        if (data.worktreeBranch) {
          data.sandbox = data.sandbox ?? proj.defaultSandbox;
        }
        data.sourceBranch = data.sourceBranch ?? proj.defaultBranch;
      }
    }
    if (!data.worktreeBranch) data.sandbox = false;
```

- [ ] **Step 4: Implement update clearing**

In `src/server/services/card.ts`, inside `updateCard()` before `Object.assign(card, data);`, add:

```ts
    const nextWorktreeBranch = data.worktreeBranch === undefined ? card.worktreeBranch : data.worktreeBranch;
    if (!nextWorktreeBranch) data.sandbox = false;
```

- [ ] **Step 5: Run card service tests**

Run:

```bash
pnpm test -- src/server/services/card.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/card.ts src/server/services/card.test.ts
git commit -m "Inherit sandbox setting for worktree cards"
```

---

## Task 3: Add project/card UI controls and client store fields

**Files:**
- Modify: `app/stores/project-store.ts`
- Modify: `app/stores/card-store.ts`
- Modify: `app/components/ProjectForm.tsx`
- Modify: `app/components/CardDetail.tsx`
- Test: `app/components/CardDetail.test.tsx`
- Modify tests/fixtures as needed: `app/components/CardDetail.test.tsx`, `app/routes/board.test.tsx`, `app/stores/project-store.test.ts`, `app/stores/card-store.test.ts`, `app/components/SessionView.test.tsx`

- [ ] **Step 1: Write failing CardDetail UI test**

In `app/components/CardDetail.test.tsx`, add a test that verifies sandbox appears only with worktree. If the file already has store setup helpers, reuse them. The assertion should match this behavior:

```tsx
it('shows sandbox checkbox only when worktree is enabled', async () => {
  render(<CardDetail cardId={1} onClose={() => undefined} />);

  expect(screen.queryByLabelText('Use sandbox')).toBeNull();

  fireEvent.click(screen.getByLabelText('Use worktree'));

  expect(screen.getByLabelText('Use sandbox')).toBeTruthy();
});
```

If the existing test harness needs a full card/project fixture, create a project fixture with `isGitRepo: true`, `defaultWorktree: false`, `defaultSandbox: true`, and a card fixture with `sandbox: false`.

- [ ] **Step 2: Run UI test to verify it fails**

Run:

```bash
pnpm test -- app/components/CardDetail.test.tsx
```

Expected: FAIL because `Use sandbox` is not rendered.

- [ ] **Step 3: Update project store types**

In `app/stores/project-store.ts`, add `defaultSandbox?: boolean;` to both `createProject()` and `updateProject()` data types after `defaultWorktree?: boolean;`.

No extra emit code is needed because the methods spread `data`.

- [ ] **Step 4: Update card store types and emits**

In `app/stores/card-store.ts`, add `sandbox?: boolean;` to both `createCard()` and `updateCard()` data types after `worktreeBranch?: string | null;`.

In the `card:create` emit object, add:

```ts
      sandbox: data.sandbox,
```

The update method spreads `data`, so no extra update emit field is needed.

- [ ] **Step 5: Update ProjectForm state and submit data**

In `app/components/ProjectForm.tsx`:

Add `defaultSandbox` to the local `Project` interface after `defaultWorktree`:

```ts
  defaultSandbox: boolean;
```

Add state after `defaultWorktree`:

```ts
  const [defaultSandbox, setDefaultSandbox] = useState(project?.defaultSandbox ?? false);
```

Add a helper before `handleSubmit`:

```ts
  function setWorktreeDefault(checked: boolean) {
    setDefaultWorktree(checked);
    if (!checked) setDefaultSandbox(false);
  }
```

In the submit `data`, add after `defaultWorktree`:

```ts
      defaultSandbox: isGitRepo && defaultWorktree ? defaultSandbox : false,
```

Change the existing default worktree checkbox handler to:

```tsx
                    onCheckedChange={(checked) => setWorktreeDefault(checked === true)}
```

After the default worktree checkbox block, add:

```tsx
              {isGitRepo && defaultWorktree && (
                <div className="flex items-center gap-2 pl-6">
                  <Checkbox
                    id="defaultSandbox"
                    checked={defaultSandbox}
                    onCheckedChange={(checked) => setDefaultSandbox(checked === true)}
                  />
                  <label htmlFor="defaultSandbox" className="text-sm font-medium text-muted-foreground">
                    Default to sandbox for worktree cards
                  </label>
                </div>
              )}
```

- [ ] **Step 6: Update CardDetail draft and patch behavior**

In `app/components/CardDetail.tsx`:

Add `sandbox` to `Draft` after `worktreeBranch`:

```ts
  sandbox: boolean;
```

When project selection changes in `CardFields`, compute sandbox from the selected project:

```ts
                sandbox: !!(proj?.isGitRepo && proj.defaultWorktree && proj.defaultSandbox),
```

When the Use worktree checkbox changes, include sandbox clearing/defaulting:

```ts
                sandbox: useWorktree ? !!selectedProject?.defaultSandbox : false,
```

After the Use worktree checkbox block, add:

```tsx
      {!!selectedProject?.isGitRepo && draft.useWorktree && (
        <div className="flex items-center gap-2 pl-6">
          <Checkbox
            id={hasSession ? 'savedUseSandbox' : 'newUseSandbox'}
            checked={draft.sandbox}
            disabled={!!draft.worktreeBranch && projectLocked}
            onCheckedChange={(checked) => {
              void patch({ sandbox: checked === true });
            }}
          />
          <label htmlFor={hasSession ? 'savedUseSandbox' : 'newUseSandbox'} className="text-sm font-medium text-muted-foreground">
            Use sandbox
          </label>
        </div>
      )}
```

Add `sandbox: false` to every `useState<Draft>` initializer.

In the existing-card sync effects, set:

```ts
      sandbox: card.sandbox,
```

Add sandbox to dirty check:

```ts
      draft.sandbox !== card.sandbox ||
```

Pass sandbox to `cardStore.updateCard()`:

```ts
      sandbox: merged.worktreeBranch ? merged.sandbox : false,
```

Pass sandbox to `cardStore.createCard()`:

```ts
        sandbox: draft.useWorktree ? draft.sandbox : false,
```

- [ ] **Step 7: Update fixture types**

Where tests or local object literals fail TypeScript because `Project` or `Card` lacks the new required fields, add:

```ts
defaultSandbox: false,
```

for projects and:

```ts
sandbox: false,
```

for cards.

- [ ] **Step 8: Run UI/store tests**

Run:

```bash
pnpm test -- app/components/CardDetail.test.tsx app/stores/project-store.test.ts app/stores/card-store.test.ts app/routes/board.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/stores/project-store.ts app/stores/card-store.ts app/components/ProjectForm.tsx app/components/CardDetail.tsx app/components/CardDetail.test.tsx app/routes/board.test.tsx app/stores/project-store.test.ts app/stores/card-store.test.ts app/components/SessionView.test.tsx
git commit -m "Add sandbox controls to worktree cards"
```

---

## Task 4: Pass sandbox metadata from server to orcd

**Files:**
- Modify: `src/shared/orcd-protocol.ts`
- Modify: `src/server/orcd-client.ts`
- Modify: `src/server/controllers/card-sessions.ts`
- Test: `src/server/controllers/card-sessions.test.ts`
- Test: `src/server/orcd-client.test.ts`

- [ ] **Step 1: Write failing controller test**

In `src/server/controllers/card-sessions.test.ts`, add or update a start-session test so the mocked orcd client receives sandbox metadata for a sandboxed worktree card:

```ts
expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
  cwd: '/tmp/project/.worktrees/card-42',
  sandbox: {
    enabled: true,
    projectPath: '/tmp/project',
    worktreePath: '/tmp/project/.worktrees/card-42',
  },
}));
```

Also add an assertion for a non-sandbox card:

```ts
expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
  sandbox: undefined,
}));
```

- [ ] **Step 2: Run controller test to verify it fails**

Run:

```bash
pnpm test -- src/server/controllers/card-sessions.test.ts src/server/orcd-client.test.ts
```

Expected: FAIL because `sandbox` is not part of the protocol/client call.

- [ ] **Step 3: Add protocol type**

In `src/shared/orcd-protocol.ts`, add near the top:

```ts
export interface SandboxLaunchConfig {
  enabled: true;
  projectPath: string;
  worktreePath: string;
}
```

Add to `CreateAction`:

```ts
  sandbox?: SandboxLaunchConfig;
```

- [ ] **Step 4: Add client create option**

In `src/server/orcd-client.ts`, import the type if not already imported:

```ts
import type { OrcdAction, OrcdMessage, SandboxLaunchConfig } from '../shared/orcd-protocol';
```

Add to `create(opts: { ... })`:

```ts
    sandbox?: SandboxLaunchConfig;
```

Add to the `this.send({ action: 'create', ... })` payload:

```ts
        sandbox: opts.sandbox,
```

- [ ] **Step 5: Pass sandbox metadata when starting cards**

In `src/server/controllers/card-sessions.ts`, find `startCardSession()`. After `const cwd = await ensureWorktree(card);`, load the project if needed and build:

```ts
  const project = card.projectId ? await Project.findOneByOrFail({ id: card.projectId }) : null;
  const sandbox = card.sandbox && card.worktreeBranch && project
    ? { enabled: true as const, projectPath: project.path, worktreePath: cwd }
    : undefined;
```

Pass `sandbox` into `client.create({ ... })`:

```ts
    sandbox,
```

If `startCardSession()` already has the project loaded, reuse it instead of querying twice.

- [ ] **Step 6: Update orcd-client test**

In `src/server/orcd-client.test.ts`, add sandbox to the create call fixture and assert the raw sent JSON includes it:

```ts
sandbox: { enabled: true, projectPath: '/tmp/project', worktreePath: '/tmp/project/.worktrees/card-42' },
```

Expected JSON fragment:

```ts
expect(sent).toMatchObject({
  action: 'create',
  sandbox: { enabled: true, projectPath: '/tmp/project', worktreePath: '/tmp/project/.worktrees/card-42' },
});
```

- [ ] **Step 7: Run protocol tests**

Run:

```bash
pnpm test -- src/server/controllers/card-sessions.test.ts src/server/orcd-client.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/orcd-protocol.ts src/server/orcd-client.ts src/server/controllers/card-sessions.ts src/server/controllers/card-sessions.test.ts src/server/orcd-client.test.ts
git commit -m "Pass sandbox launch metadata to orcd"
```

---

## Task 5: Build the bwrap sandbox launcher

**Files:**
- Create: `src/orcd/sandbox.ts`
- Test: `src/orcd/__tests__/sandbox.test.ts`

- [ ] **Step 1: Write failing sandbox tests**

Create `src/orcd/__tests__/sandbox.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSandboxLaunch } from '../sandbox';

const dirs: string[] = [];

async function makeRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orc-sandbox-root-'));
  dirs.push(root);
  const projectPath = join(root, 'foo');
  const worktreePath = join(projectPath, '.worktrees', 'card-123');
  await mkdir(join(projectPath, '.git', 'worktrees', 'card-123'), { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await writeFile(join(worktreePath, '.git'), `gitdir: ${join(projectPath, '.git', 'worktrees', 'card-123')}\n`);
  return { projectPath, worktreePath };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('prepareSandboxLaunch', () => {
  it('builds a bwrap launch that maps the worktree to the canonical project path', async () => {
    const { projectPath, worktreePath } = await makeRepoFixture();

    const launch = await prepareSandboxLaunch({
      sessionId: 'session-12345678',
      projectPath,
      worktreePath,
      claudeExecutable: '/home/ryan/.local/bin/claude',
      home: '/home/ryan',
    });

    expect(launch.executable).toBe('bwrap');
    expect(launch.cwd).toBe(projectPath);
    expect(launch.env.HOME).toBe('/home/ryan');
    expect(launch.args).toContain('--bind');
    expect(launch.args).toContain(worktreePath);
    expect(launch.args).toContain(projectPath);
    expect(launch.args).toContain(join(projectPath, '.git-parent'));
    expect(launch.args).toContain(join(projectPath, '.git'));

    const gitFile = await readFile(launch.syntheticGitFile, 'utf8');
    expect(gitFile).toBe(`gitdir: ${join(projectPath, '.git-parent', 'worktrees', 'card-123')}\n`);
  });

  it('rejects a worktree outside the project .worktrees directory', async () => {
    const { projectPath } = await makeRepoFixture();
    const outside = await mkdtemp(join(tmpdir(), 'outside-worktree-'));
    dirs.push(outside);
    await writeFile(join(outside, '.git'), `gitdir: ${join(projectPath, '.git', 'worktrees', 'outside')}\n`);

    await expect(prepareSandboxLaunch({
      sessionId: 'session-12345678',
      projectPath,
      worktreePath: outside,
      claudeExecutable: '/home/ryan/.local/bin/claude',
      home: '/home/ryan',
    })).rejects.toThrow('worktree path must be inside project .worktrees');
  });

  it('rejects a worktree gitdir that does not point under project .git/worktrees', async () => {
    const { projectPath, worktreePath } = await makeRepoFixture();
    await writeFile(join(worktreePath, '.git'), 'gitdir: /tmp/not-this-repo/worktrees/card-123\n');

    await expect(prepareSandboxLaunch({
      sessionId: 'session-12345678',
      projectPath,
      worktreePath,
      claudeExecutable: '/home/ryan/.local/bin/claude',
      home: '/home/ryan',
    })).rejects.toThrow('worktree gitdir must point under project .git/worktrees');
  });
});
```

- [ ] **Step 2: Run sandbox tests to verify they fail**

Run:

```bash
pnpm test -- src/orcd/__tests__/sandbox.test.ts
```

Expected: FAIL because `src/orcd/sandbox.ts` does not exist.

- [ ] **Step 3: Implement sandbox launcher**

Create `src/orcd/sandbox.ts`:

```ts
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { tmpdir } from 'os';

export interface SandboxConfig {
  projectPath: string;
  worktreePath: string;
}

export interface SandboxLaunchOptions extends SandboxConfig {
  sessionId: string;
  claudeExecutable: string;
  home?: string;
}

export interface SandboxLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stagingDir: string;
  syntheticGitFile: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
}

async function readGitdir(worktreePath: string): Promise<string> {
  const text = await readFile(join(worktreePath, '.git'), 'utf8');
  const line = text.split('\n').find((item) => item.startsWith('gitdir: '));
  if (!line) throw new Error('worktree .git file must contain gitdir');
  return line.slice('gitdir: '.length).trim();
}

export async function prepareSandboxLaunch(opts: SandboxLaunchOptions): Promise<SandboxLaunch> {
  const home = opts.home ?? process.env.HOME ?? '/home/ryan';
  const projectPath = await realpath(opts.projectPath);
  const worktreePath = await realpath(opts.worktreePath);
  const projectGitPath = join(projectPath, '.git');
  const projectWorktreesPath = join(projectPath, '.worktrees');
  const realProjectGitPath = await realpath(projectGitPath);
  const realProjectWorktreesPath = await realpath(projectWorktreesPath);

  if (!isInside(realProjectWorktreesPath, worktreePath)) {
    throw new Error(`worktree path must be inside project .worktrees: ${worktreePath}`);
  }

  const gitdir = await realpath(await readGitdir(worktreePath));
  const realGitWorktreesPath = await realpath(join(realProjectGitPath, 'worktrees'));
  if (!isInside(realGitWorktreesPath, gitdir)) {
    throw new Error(`worktree gitdir must point under project .git/worktrees: ${gitdir}`);
  }

  if (!existsSync(join(home, '.claude'))) throw new Error(`${home}/.claude does not exist`);
  if (!existsSync(join(home, '.claude.json'))) throw new Error(`${home}/.claude.json does not exist`);

  const worktreeName = basename(gitdir);
  const stagingDir = await mkdtemp(join(tmpdir(), `orchestrel-bwrap-${opts.sessionId.slice(0, 8)}-`));
  const syntheticGitFile = join(stagingDir, '.git');
  await writeFile(syntheticGitFile, `gitdir: ${join(projectPath, '.git-parent', 'worktrees', worktreeName)}\n`);

  const codeDir = join(home, 'Code');
  const args = [
    '--unshare-pid',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--tmpfs', '/tmp',
    '--tmpfs', home,
    '--dir', codeDir,
    '--bind', worktreePath, projectPath,
    '--bind', realProjectGitPath, join(projectPath, '.git-parent'),
    '--ro-bind', syntheticGitFile, join(projectPath, '.git'),
    '--bind', join(home, '.claude'), join(home, '.claude'),
    '--bind', join(home, '.claude.json'), join(home, '.claude.json'),
    '--setenv', 'HOME', home,
    '--chdir', projectPath,
    opts.claudeExecutable,
  ];

  await mkdir(stagingDir, { recursive: true });

  return {
    executable: 'bwrap',
    args,
    cwd: projectPath,
    env: { HOME: home },
    stagingDir,
    syntheticGitFile,
  };
}
```

- [ ] **Step 4: Run sandbox tests**

Run:

```bash
pnpm test -- src/orcd/__tests__/sandbox.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orcd/sandbox.ts src/orcd/__tests__/sandbox.test.ts
git commit -m "Build bwrap worktree sandbox launcher"
```

---

## Task 6: Wire sandbox launcher into orcd sessions

**Files:**
- Modify: `src/orcd/session.ts`
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/session-async-tasks.test.ts`

- [ ] **Step 1: Write failing session SDK option test**

In `src/orcd/__tests__/session-async-tasks.test.ts`, add a test inside the existing describe block:

```ts
  it('uses bwrap executable and canonical cwd for sandboxed sessions', async () => {
    events.push({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });

    const session = new OrcdSession({
      cwd: '/host/project/.worktrees/card-123',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-sandbox',
      sandboxLaunch: {
        executable: 'bwrap',
        args: ['--bind', '/host/project/.worktrees/card-123', '/host/project', '/home/ryan/.local/bin/claude'],
        cwd: '/host/project',
        env: { HOME: '/home/ryan' },
        stagingDir: '/tmp/orchestrel-bwrap-session-sandbox',
        syntheticGitFile: '/tmp/orchestrel-bwrap-session-sandbox/.git',
      },
    });

    await session.run({ prompt: 'go', env: { ANTHROPIC_BASE_URL: 'http://mlx.example' } });

    expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        cwd: '/host/project',
        pathToClaudeCodeExecutable: 'bwrap',
        env: expect.objectContaining({
          HOME: '/home/ryan',
          ANTHROPIC_BASE_URL: 'http://mlx.example',
        }),
      }),
    }));
  });
```

- [ ] **Step 2: Run session test to verify it fails**

Run:

```bash
pnpm test -- src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: FAIL because `OrcdSession` does not accept `sandboxLaunch`.

- [ ] **Step 3: Add sandboxLaunch to OrcdSession**

In `src/orcd/session.ts`, import the type:

```ts
import type { SandboxLaunch } from './sandbox';
```

Add class field:

```ts
  private readonly sandboxLaunch: SandboxLaunch | undefined;
```

Add constructor option:

```ts
    sandboxLaunch?: SandboxLaunch;
```

Set it in constructor:

```ts
    this.sandboxLaunch = opts.sandboxLaunch;
```

Before `const q = sdkQuery({ ... })`, compute:

```ts
    const sdkCwd = this.sandboxLaunch?.cwd ?? this.cwd;
    const pathToClaudeCodeExecutable = this.sandboxLaunch?.executable ?? '/home/ryan/.local/bin/claude';
    const env = {
      ...opts.env,
      ...(this.sandboxLaunch?.env ?? {}),
      ...(this.contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(this.contextWindow) } : {}),
    };
```

Then change SDK options:

```ts
        cwd: sdkCwd,
```

```ts
        pathToClaudeCodeExecutable,
```

```ts
        env,
```

Important: this task only switches the executable to `bwrap`. If the Agent SDK cannot pass wrapper args through `pathToClaudeCodeExecutable`, switch to Task 6B below before committing.

- [ ] **Step 4: Verify whether SDK can pass bwrap args**

Run a focused manual check in a scratch Node/TS context or inspect SDK behavior by test mocking. The desired spawned command must be equivalent to:

```bash
bwrap <sandbox args> /home/ryan/.local/bin/claude <sdk-added claude args>
```

If the SDK only accepts an executable path and cannot pass fixed wrapper args, implement Task 6B.

- [ ] **Task 6B: Add generated wrapper script if SDK cannot pass args**

Modify `SandboxLaunch` in `src/orcd/sandbox.ts` to include `wrapperScript: string`.

In `prepareSandboxLaunch()`, write an executable shell script in `stagingDir`:

```bash
#!/usr/bin/env bash
set -ex
exec bwrap <quoted static args except final claude executable> /home/ryan/.local/bin/claude "$@"
```

Use Node `writeFile(wrapperScript, script, { mode: 0o700 })` if available in current Node typings, otherwise write then `chmod(wrapperScript, 0o700)`.

Return:

```ts
executable: wrapperScript,
args: [],
```

Update tests to expect `launch.executable` to be the wrapper script path and the script content to contain `exec bwrap`.

- [ ] **Step 5: Wire socket-server create path**

In `src/orcd/socket-server.ts`, import:

```ts
import { prepareSandboxLaunch } from './sandbox';
```

Change `handleCreate` to prepare sandbox before constructing `OrcdSession`:

```ts
    const sandboxLaunch = action.sandbox
      ? await prepareSandboxLaunch({
          sessionId: action.sessionId ?? crypto.randomUUID(),
          projectPath: action.sandbox.projectPath,
          worktreePath: action.sandbox.worktreePath,
          claudeExecutable: '/home/ryan/.local/bin/claude',
        })
      : undefined;
```

Because `handleCreate` is currently synchronous, refactor it into an async helper:

```ts
  private handleCreate(client: ClientState, action: OrcdAction & { action: 'create' }): void {
    this.createSession(client, action).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orcd] create failed:`, msg);
      this.send(client, { type: 'error', sessionId: action.sessionId ?? '', error: `Sandbox setup failed: ${msg}` });
    });
  }

  private async createSession(client: ClientState, action: OrcdAction & { action: 'create' }): Promise<void> {
    // move the existing handleCreate body here
  }
```

Use a local session id before sandbox prep so the staging dir and session agree:

```ts
    const sessionId = action.sessionId ?? randomUUID();
```

Then pass `sessionId` to both `prepareSandboxLaunch()` and `new OrcdSession({ sessionId, ... })`.

- [ ] **Step 6: Run orcd tests**

Run:

```bash
pnpm test -- src/orcd/__tests__/session-async-tasks.test.ts src/orcd/__tests__/socket-server-compaction.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orcd/session.ts src/orcd/socket-server.ts src/orcd/sandbox.ts src/orcd/__tests__/session-async-tasks.test.ts src/orcd/__tests__/sandbox.test.ts src/orcd/__tests__/socket-server-compaction.test.ts
git commit -m "Launch sandboxed worktree sessions with bwrap"
```

---

## Task 7: End-to-end verification and docs cleanup

**Files:**
- Modify only if verification reveals gaps.

- [ ] **Step 1: Run full targeted test suite**

Run:

```bash
pnpm test -- src/server/services/project.test.ts src/server/services/card.test.ts src/server/controllers/card-sessions.test.ts src/server/orcd-client.test.ts src/orcd/__tests__/sandbox.test.ts src/orcd/__tests__/session-async-tasks.test.ts app/components/CardDetail.test.tsx app/stores/project-store.test.ts app/stores/card-store.test.ts app/routes/board.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS with 0 errors.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Manual bwrap smoke test**

On the Orchestrel host, verify `bwrap` exists:

```bash
command -v bwrap
```

Expected: prints a path such as `/usr/bin/bwrap`.

Create or choose a test card for a Git project with worktree enabled and sandbox enabled. Move it to running with a prompt that asks the agent to run:

```bash
pwd
git status
cd /home/ryan/Code/<project-name> && touch sandbox-proof.txt
```

Expected:

- The `pwd` shown to the agent is `/home/ryan/Code/<project-name>`.
- `git status` works.
- `sandbox-proof.txt` exists in `/home/ryan/Code/<project-name>/.worktrees/<branch>/sandbox-proof.txt`.
- `sandbox-proof.txt` does not exist in `/home/ryan/Code/<project-name>/sandbox-proof.txt`.

Remove the proof file from the worktree after verification:

```bash
rm /home/ryan/Code/<project-name>/.worktrees/<branch>/sandbox-proof.txt
```

- [ ] **Step 5: Store implementation memory**

After the smoke test passes, store a memory with:

- the exact sandbox mount strategy that worked
- whether a generated wrapper script was required
- any bwrap package/setup command needed on the Orchestrel host
- the verification card/project used

- [ ] **Step 6: Commit any verification fixes**

If any code changed during verification:

```bash
git add <changed-files>
git commit -m "Verify bwrap worktree sandbox"
```

If no code changed, skip this commit.

---

## Self-Review

Spec coverage:

- Product model: Tasks 1-3 add project/card fields, defaults, and UI controls.
- Launch metadata: Task 4 passes host worktree path, canonical project path, and sandbox flag to orcd.
- bwrap mount layout: Task 5 builds and validates the mount layout and synthetic `.git` pointer.
- orcd launch integration: Task 6 wires sandbox launch into Agent SDK sessions and fails closed on setup errors.
- Testing: Each task starts with failing tests and Task 7 runs targeted tests, lint, build, and manual smoke verification.
- Non-goals: no task adds network isolation, session clones, Docker, or selective `.git` hardening.

Placeholder scan: No TBD/TODO/fill-later placeholders remain. Task 6 includes a concrete branch (Task 6B) for SDK wrapper-argument compatibility because this behavior must be verified during implementation.

Type consistency: `defaultSandbox`, `sandbox`, and `SandboxLaunchConfig` names are used consistently across DB models, protocol schemas, stores, UI, server, and orcd.
