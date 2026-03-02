import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

export function createWorktree(repoPath: string, worktreePath: string, branch: string): void {
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

export function runSetupCommands(worktreePath: string, commands: string): void {
  if (!commands.trim()) return;
  execFileSync('/bin/bash', ['-c', commands], {
    cwd: worktreePath,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}
