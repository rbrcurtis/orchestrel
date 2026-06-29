import { execFile, execFileSync } from 'child_process';
import { existsSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { resolveWorkDir } from '../shared/worktree';

const execFileAsync = promisify(execFile);

function createWorktree(repoPath: string, worktreePath: string, branch: string, sourceBranch?: string): void {
  let resolvedSource = sourceBranch;
  if (sourceBranch && !sourceBranch.includes('/')) {
    execFileSync('git', ['fetch', 'origin', sourceBranch], { cwd: repoPath, stdio: 'pipe' });
    resolvedSource = `origin/${sourceBranch}`;
  }
  try {
    execFileSync('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath, stdio: 'pipe' });
  } catch (err) {
    console.log(`[worktree:${branch}] attach failed, creating new branch:`, err instanceof Error ? err.message : err);
    const args = ['worktree', 'add', worktreePath, '-b', branch];
    if (resolvedSource) args.push(resolvedSource);
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  }
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, stdio: 'pipe' });
}

async function runSetupCommands(worktreePath: string, commands: string): Promise<void> {
  if (!commands.trim()) { console.log(`[worktree:${worktreePath}] runSetupCommands: no commands, skipping`); return; }
  const nodeBin = dirname(process.execPath);
  await execFileAsync('/bin/bash', ['-lc', `export PATH="${nodeBin}:$HOME/.local/bin:$PATH"; ${commands}`], {
    cwd: worktreePath,
    env: { ...process.env, PATH: `${nodeBin}:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}` },
    timeout: 120_000,
  });
}

function copyOpencodeConfig(srcDir: string, destDir: string): void {
  const src = `${srcDir}/opencode.json`;
  if (!existsSync(src)) { console.log(`[worktree] copyOpencodeConfig: no opencode.json at ${src}, skipping`); return; }
  copyFileSync(src, `${destDir}/opencode.json`);
}

export async function prepareWorktree(opts: {
  projectPath: string; branch: string; sourceBranch?: string; setupCommands?: string;
}): Promise<{ path: string; branch: string }> {
  const wtPath = resolveWorkDir(opts.branch, opts.projectPath);
  if (!existsSync(wtPath)) {
    createWorktree(opts.projectPath, wtPath, opts.branch, opts.sourceBranch);
    if (opts.setupCommands) {
      try {
        await runSetupCommands(wtPath, opts.setupCommands);
      } catch (err) {
        // Setup failure must not block the session — the worktree exists and the agent can run.
        console.error(`[worktree:${opts.branch}] setup failed (continuing):`, err instanceof Error ? err.message : String(err));
      }
    }
    copyOpencodeConfig(opts.projectPath, wtPath);
  }
  return { path: wtPath, branch: opts.branch };
}

export async function validatePath(path: string): Promise<{ exists: boolean; isGitRepo: boolean; defaultBranch: string | null }> {
  if (!existsSync(path)) { console.log(`[path_validate] path does not exist: ${path}`); return { exists: false, isGitRepo: false, defaultBranch: null }; }
  const isGitRepo = existsSync(join(path, '.git'));
  let defaultBranch: string | null = null;
  if (isGitRepo) {
    try {
      defaultBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: path, stdio: 'pipe' }).toString().trim() || null;
    } catch (err) {
      console.log(`[path_validate] could not resolve branch for ${path}:`, err instanceof Error ? err.message : err);
    }
  }
  return { exists: true, isGitRepo, defaultBranch };
}
