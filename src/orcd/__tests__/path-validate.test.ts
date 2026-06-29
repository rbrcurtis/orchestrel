import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validatePath } from '../worktree-ops';

describe('validatePath', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('reports a non-existent path', async () => {
    const res = await validatePath('/no/such/path-xyz');
    expect(res).toEqual({ exists: false, isGitRepo: false, defaultBranch: null });
  });

  it('detects a git repo and its default branch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orcd-pv-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const res = await validatePath(dir);
    expect(res.exists).toBe(true);
    expect(res.isGitRepo).toBe(true);
    expect(res.defaultBranch).toBe('main');
  });
});
