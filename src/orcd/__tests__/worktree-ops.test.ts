import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { prepareWorktree, removeWorktree } from '../worktree-ops';

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orcd-wt-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('worktree-ops', () => {
  let repo: string;
  afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

  it('prepares a worktree and returns its resolved path', async () => {
    repo = await tempRepo();
    const res = await prepareWorktree({ projectPath: repo, branch: 'feat-x', sourceBranch: undefined, setupCommands: '' });
    expect(res.path).toBe(join(repo, '.worktrees', 'feat-x'));
    expect((await stat(res.path)).isDirectory()).toBe(true);
  });

  it('removes a worktree', async () => {
    repo = await tempRepo();
    const res = await prepareWorktree({ projectPath: repo, branch: 'feat-y', sourceBranch: undefined, setupCommands: '' });
    await removeWorktree(repo, res.path);
    await expect(stat(res.path)).rejects.toThrow();
  });
});
