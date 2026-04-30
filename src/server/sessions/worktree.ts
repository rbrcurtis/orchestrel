import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { createWorktree, worktreeExists, runSetupCommands, copyOpencodeConfig } from '../worktree';
import { resolveWorkDir } from '../../shared/worktree';

export async function ensureWorktree(card: Card): Promise<string> {
  if (!card.projectId) throw new Error(`Card ${card.id} has no project`);
  const proj = await Project.findOneByOrFail({ id: card.projectId });

  if (!card.worktreeBranch) {
    console.log(`[session:${card.id}] ensureWorktree: no worktreeBranch, using project path ${proj.path}`);
    return proj.path;
  }

  const wtPath = resolveWorkDir(card.worktreeBranch, proj.path);
  console.log(`[session:${card.id}] ensureWorktree: branch=${card.worktreeBranch}, path=${wtPath}`);

  if (worktreeExists(wtPath)) return wtPath;

  console.log(`[session:${card.id}] creating worktree at ${wtPath}`);
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined;
  createWorktree(proj.path, wtPath, card.worktreeBranch, source);

  if (proj.setupCommands) {
    console.log(`[session:${card.id}] running setup commands...`);
    await runSetupCommands(wtPath, proj.setupCommands);
    console.log(`[session:${card.id}] setup commands done`);
  }
  copyOpencodeConfig(proj.path, wtPath);

  return wtPath;
}
