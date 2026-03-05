# Worktree Flexibility & Session Resumption Design

## Problem

Conductor currently assumes all repos are git repos and always creates worktrees. Need to support:
1. Arbitrary folders (non-git) as "repos"
2. Working directly in a git repo without worktrees
3. Resuming closed cards (recreate worktree, resume Claude session)
4. Configurable source branch for worktrees

## Schema Changes

### `repos` table — add columns

- `isGitRepo` integer (0/1), default 0 — auto-detected from `.git` directory
- `defaultBranch` text (`'main'` | `'dev'`), nullable — required for git repos, null for non-git folders

### `cards` table — add columns

- `useWorktree` integer (0/1), default 1
- `sourceBranch` text (`'main'` | `'dev'`), nullable — null means use repo's `defaultBranch`

## Server Logic

### Repo create/update

Auto-detect `isGitRepo` via `existsSync(join(path, '.git'))`. Store result in DB.

### `repos.get` (new endpoint)

Fetches single repo by ID, re-scans `isGitRepo` from filesystem, updates DB if changed. Used by repo settings form to get fresh detection.

### Card move to `in_progress`

- No repo → do nothing
- `useWorktree` false → set `worktreePath = repo.path`
- `useWorktree` true:
  - `worktreePath` set and worktree exists → do nothing
  - `worktreePath` set but worktree missing → recreate (try attaching existing branch first, fall back to creating new branch from `card.sourceBranch ?? repo.defaultBranch`)
  - `worktreePath` not set → create new worktree (slug from title, new branch from `card.sourceBranch ?? repo.defaultBranch`)

### Card move to `done`

- `useWorktree` true and worktree exists → remove worktree directory only
- **Preserve** `worktreePath`, `worktreeBranch`, `sessionId` — never null them
- **Preserve** git branch — do not delete

### Claude start

- `card.sessionId` exists → spawn with `--resume <sessionId>` (no initial prompt sent)
- No `sessionId` → spawn fresh, send card description as initial prompt

### `createWorktree` changes

Handle both cases:
- New branch: `git worktree add <path> -b <branch> <sourceBranch>`
- Existing branch: `git worktree add <path> <branch>`

Try existing branch first when recreating (card has `worktreeBranch` set).

## UI Changes

### Repo settings form

- `defaultBranch` dropdown (`main` / `dev`) — visible and required only when `isGitRepo` is true, no default value (blank until set)
- On load, call `repos.get` to refresh `isGitRepo` detection

### Card detail panel

- `useWorktree` checkbox — visible when repo is git, disabled+unchecked when repo is not git
- `sourceBranch` dropdown (`main` / `dev`) — visible only when `useWorktree` is checked, defaults to repo's `defaultBranch`
- "Start Claude" button shows "Resume Claude" when `sessionId` exists
