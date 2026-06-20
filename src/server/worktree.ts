import { execFile, execFileSync } from 'child_process';
import { existsSync, copyFileSync } from 'fs';
import { dirname } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  sourceBranch?: string,
): void {
  // Resolve to remote ref for branches like "dev" or "main"
  let resolvedSource = sourceBranch;
  if (sourceBranch && !sourceBranch.includes('/')) {
    execFileSync('git', ['fetch', 'origin', sourceBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    resolvedSource = `origin/${sourceBranch}`;
  }

  try {
    // Try attaching existing branch first
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    console.log(`[worktree:${branch}] existing branch attach failed, creating new branch:`, err instanceof Error ? err.message : err);
    // Branch doesn't exist — create new branch from source
    const args = ['worktree', 'add', worktreePath, '-b', branch];
    if (resolvedSource) args.push(resolvedSource);
    execFileSync('git', args, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  }
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

export async function runSetupCommands(worktreePath: string, commands: string): Promise<void> {
  if (!commands.trim()) {
    console.log(`[worktree:${worktreePath}] runSetupCommands: no commands, skipping`);
    return;
  }
  // `bash -lc` sources login profiles which rebuild PATH from scratch and drop
  // the nvm node dir the service runs with — so `yarn`/`npm` setup steps fail
  // with `env: 'node': No such file or directory`. Re-export node's own bin dir
  // inside the command so it survives the profile reset.
  const nodeBin = dirname(process.execPath);
  await execFileAsync('/bin/bash', ['-lc', `export PATH="${nodeBin}:/home/ryan/.local/bin:$PATH"; ${commands}`], {
    cwd: worktreePath,
    env: {
      ...process.env,
      PATH: `${nodeBin}:/home/ryan/.local/bin:${process.env.PATH ?? ''}`,
    },
    timeout: 120_000,
  });
}

export { slugify } from '../shared/worktree';

export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}

export function copyOpencodeConfig(srcDir: string, destDir: string): void {
  const src = `${srcDir}/opencode.json`
  if (!existsSync(src)) {
    console.log(`[worktree:${destDir}] copyOpencodeConfig: no opencode.json at ${src}, skipping`);
    return;
  }
  copyFileSync(src, `${destDir}/opencode.json`)
}
