import type { AckResponse } from '../../../shared/ws-protocol';
import { applyCompaction, prepareCompaction } from '../../../lib/session-compactor';
import { loadConfig } from '../../../shared/config';
import { messageBus } from '../../bus';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { buildPromptWithFiles } from '../../sessions/manager';
import { trackSession } from '../../controllers/card-sessions';
import { ensureWorktree } from '../../sessions/worktree';
import { resolveWorkDir } from '../../../shared/worktree';

export async function handleAgentSend(
  data: { cardId: number; message: string; files?: Array<{ id: string; name: string; mimeType: string; path: string; size: number }> },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId, message, files } = data;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    callback({});

    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    if (!client) throw new Error('OrcdClient not initialized');

    const card = await Card.findOneByOrFail({ id: cardId });
    const prompt = buildPromptWithFiles(message, files);

    // Increment prompts sent
    card.promptsSent = (card.promptsSent ?? 0) + 1;

    if (card.sessionId && client.isActive(card.sessionId)) {
      // Follow-up to active session — ensure tracked in router map
      trackSession(cardId, card.sessionId);
      client.message(card.sessionId, prompt);
      card.updatedAt = new Date().toISOString();
      await card.save();
    } else {
      // New session or resume
      const cwd = await ensureWorktree(card);
      const sessionId = await client.create({
        prompt,
        cwd,
        provider: card.provider,
        model: card.model,
        sessionId: card.sessionId ?? undefined,
        contextWindow: card.contextWindow,
        summarizeThreshold: card.summarizeThreshold,
      });

      card.sessionId = sessionId;
      trackSession(cardId, sessionId);

      if (card.column !== 'running') {
        card.column = 'running';
      }
      card.updatedAt = new Date().toISOString();
      await card.save();
    }
  } catch (err) {
    console.error(`[session:${cardId}] agent:send error:`, err instanceof Error ? err.message : String(err));
  }
}

export async function handleAgentCompact(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:compact received`);

  try {
    const card = await Card.findOneBy({ id: cardId });
    if (!card?.sessionId) {
      callback({ error: 'No session to compact' });
      return;
    }

    callback({});
    void compactSessionInBackground(card.id);
  } catch (err) {
    console.error(`[session:${cardId}] agent:compact error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

async function compactSessionInBackground(cardId: number): Promise<void> {
  try {
    const card = await Card.findOneBy({ id: cardId });
    if (!card?.sessionId) {
      console.log(`[session:${cardId}] manual compact skipped: no session`);
      return;
    }

    const cwd = await resolveCardCwd(card);
    const prepared = await prepareCompaction({
      sessionId: card.sessionId,
      projectPath: cwd,
      model: card.model,
    });

    await applyCompaction(prepared);

    card.contextTokens = 0;
    card.updatedAt = new Date().toISOString();
    await card.save();

    messageBus.publish(`card:${cardId}:sdk`, {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: card.sessionId,
      source: 'orchestrel-manual-compact',
      timestamp: Date.now(),
    });
    console.log(`[session:${cardId}] manual compact applied`);
  } catch (err) {
    console.error(`[session:${cardId}] manual compact error:`, err instanceof Error ? err.message : err);
  }
}

async function resolveCardCwd(card: Card): Promise<string> {
  let cwd: string;

  if (card.projectId) {
    const project = await Project.findOneBy({ id: card.projectId });
    if (!project) throw new Error(`Project ${card.projectId} not found for card ${card.id}`);
    cwd = resolveWorkDir(card.worktreeBranch ?? null, project.path);
  } else {
    const cfg = loadConfig();
    if (!cfg.defaultCwd) throw new Error(`Card ${card.id} has no project and config.defaultCwd is unset`);
    cwd = cfg.defaultCwd;
  }

  return cwd;
}

export async function handleAgentStop(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:stop received`);
  callback({});
  const initState = await import('../../init-state');
  const client = initState.getOrcdClient();
  const card = await Card.findOneBy({ id: cardId });
  if (client && card?.sessionId) {
    client.cancel(card.sessionId);
  }
}

export async function handleAgentStatus(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId } = data;
  try {
    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    const card = await Card.findOneBy({ id: cardId });

    const active = !!(card?.sessionId && client?.isActive(card.sessionId));

    if (!active && card && card.column === 'running') {
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await card.save();
    }

    socket.emit('agent:status', {
      cardId,
      active,
      status: active ? 'running' : 'completed',
      sessionId: card?.sessionId ?? null,
      promptsSent: card?.promptsSent ?? 0,
      turnsCompleted: card?.turnsCompleted ?? 0,
      contextTokens: card?.contextTokens ?? 0,
      contextWindow: card?.contextWindow ?? 200_000,
    });
    callback({});
  } catch (err) {
    console.error(`[session:${cardId}] agent:status error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
