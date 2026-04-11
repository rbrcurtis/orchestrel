import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { buildPromptWithFiles } from '../../sessions/manager';
import { registerCardSession } from '../../controllers/card-sessions';
import { ensureWorktree } from '../../sessions/worktree';

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
      // Follow-up to active session
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
      });

      card.sessionId = sessionId;
      registerCardSession(cardId, sessionId);

      if (card.column !== 'running') {
        card.column = 'running';
      }
      card.updatedAt = new Date().toISOString();
      await card.save();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[session:${cardId}] agent:send error:`, error);
  }
}

export async function handleAgentCompact(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:compact received`);
  try {
    callback({});
    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    const card = await Card.findOneBy({ id: cardId });
    if (client && card?.sessionId && client.isActive(card.sessionId)) {
      client.message(card.sessionId, 'Please compact your context window. Summarize the conversation so far and continue.');
    }
  } catch (err) {
    console.error(`[session:${cardId}] agent:compact error:`, err);
  }
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

    if (!active && card && card.column === 'running' && card.queuePosition == null) {
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
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
