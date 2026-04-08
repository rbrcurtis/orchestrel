import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { createWorktree, worktreeExists, runSetupCommands, slugify, copyOpencodeConfig } from '../worktree';

/**
 * Ensures the card has a valid worktree directory.
 * Reuses existing worktree if path is valid, creates new one otherwise.
 * Runs project setup commands if configured.
 * Returns the working directory path for the session.
 */
export async function ensureWorktree(card: Card): Promise<string> {
  console.log(
    `[session:${card.id}] ensureWorktree: worktreePath=${card.worktreePath}, useWorktree=${card.useWorktree}, projectId=${card.projectId}`,
  );

  // If worktreePath is set AND the directory still exists on disk, reuse it
  if (card.worktreePath && worktreeExists(card.worktreePath)) return card.worktreePath;

  // Stale worktreePath (directory gone) — clear it so we recreate below
  if (card.worktreePath && !worktreeExists(card.worktreePath)) {
    console.log(`[session:${card.id}] stale worktreePath ${card.worktreePath}, clearing`);
    card.worktreePath = null;
  }

  if (!card.projectId) throw new Error(`Card ${card.id} has no project`);
  const proj = await Project.findOneByOrFail({ id: card.projectId });

  if (!card.useWorktree) {
    card.worktreePath = proj.path;
    card.updatedAt = new Date().toISOString();
    await card.save();
    return proj.path;
  }

  const slug = card.worktreeBranch || slugify(card.title);
  const wtPath = `${proj.path}/.worktrees/${slug}`;
  const branch = slug;
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined;

  if (!worktreeExists(wtPath)) {
    console.log(`[session:${card.id}] worktree setup at ${wtPath}`);
    createWorktree(proj.path, wtPath, branch, source ?? undefined);
    if (proj.setupCommands) {
      console.log(`[session:${card.id}] running setup commands...`);
      runSetupCommands(wtPath, proj.setupCommands);
      console.log(`[session:${card.id}] setup commands done`);
    }
    copyOpencodeConfig(proj.path, wtPath);
  } else {
    console.log(`[session:${card.id}] worktree already exists at ${wtPath}`);
  }

  card.worktreePath = wtPath;
  card.worktreeBranch = branch;
  card.sourceBranch = card.sourceBranch ?? source ?? null;
  card.updatedAt = new Date().toISOString();
  await card.save();
  return wtPath;
}
