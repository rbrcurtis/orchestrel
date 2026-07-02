import { Card } from '../models/Card';
import { Project } from '../models/Project';
import type { OrcdClient } from '../orcd-client';

// Resolve a card's working directory on its node. orcd owns all node-local
// filesystem work (worktree create, setup_commands, opencode config copy), so
// the BE asks the node's client to prepare the worktree and hands back the
// resolved path. When the card has no worktree branch, the project path is the
// cwd directly.
export async function ensureWorktree(card: Card, client: OrcdClient): Promise<string> {
  if (!card.projectId) throw new Error(`Card ${card.id} has no project`);
  const proj = await Project.findOneByOrFail({ id: card.projectId });

  if (!card.worktreeBranch) {
    console.log(`[session:${card.id}] ensureWorktree: no worktreeBranch, using project path ${proj.path}`);
    return proj.path;
  }

  console.log(`[session:${card.id}] ensureWorktree: branch=${card.worktreeBranch}, preparing on node ${client.nodeName}`);
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined;
  const res = await client.worktreePrepare({
    projectPath: proj.path,
    branch: card.worktreeBranch,
    sourceBranch: source ?? undefined,
    setupCommands: proj.setupCommands ?? '',
  });
  return res.path;
}
