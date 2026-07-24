import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validatePath } from '../worktree-ops';

describe('validatePath', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('reports a non-existent path', async () => {
    const res = await validatePath('/no/such/path-xyz');
    expect(res).toEqual({ exists: false, isGitRepo: false, defaultBranch: null, gitCommonDir: null });
  });

  it('detects a git repo and its default branch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orcd-pv-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const res = await validatePath(dir);
    expect(res.exists).toBe(true);
    expect(res.isGitRepo).toBe(true);
    expect(res.defaultBranch).toBe('main');
    expect(res.gitCommonDir).toBe(join(realpathSync(dir), '.git'));
  });

  it('returns the same common git dir for a linked worktree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orcd-pv-'));
    const worktree = join(dir, 'linked-worktree');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
    execFileSync('git', ['worktree', 'add', '-b', 'feature', worktree], { cwd: dir });

    const [root, linked] = await Promise.all([validatePath(dir), validatePath(worktree)]);

    expect(linked.gitCommonDir).toBe(root.gitCommonDir);
  });

  it('returns the common git dir for a detached linked worktree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orcd-pv-'));
    const worktree = join(dir, 'detached-worktree');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
    execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: dir });

    const [root, detached] = await Promise.all([validatePath(dir), validatePath(worktree)]);

    expect(detached.defaultBranch).toBeNull();
    expect(detached.gitCommonDir).toBe(root.gitCommonDir);
  });
});
