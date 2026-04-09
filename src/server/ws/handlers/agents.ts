import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { registerCardSession } from '../../controllers/oc';
import { buildPromptWithFiles } from '../../sessions/manager';

export async function handleAgentSend(
  data: { cardId: number; message: string; files?: Array<{ id: string; name: string; mimeType: string; path: string; size: number }> },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId, message, files } = data;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    // Ack immediately — session start is async
    callback({});

    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    if (!sm) throw new Error('SessionManager not initialized');

    const card = await Card.findOneByOrFail({ id: cardId });
    const prompt = buildPromptWithFiles(message, files);

    if (sm.isActive(cardId)) {
      sm.sendFollowUp(cardId, prompt);
    } else {
      if (card.column !== 'running') {
        card.column = 'running';
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
      await sm.start(cardId, prompt, {
        provider: card.provider,
        model: card.model,
        cwd: process.cwd(),
        resume: card.sessionId ?? undefined,
      });
      registerCardSession(cardId);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[session:${cardId}] agent:send error:`, error);
    // Can't send error via callback (already called). Error surfaces via agent:status.
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
    const sm = initState.getSessionManager();
    if (sm?.isActive(cardId)) {
      sm.sendFollowUp(cardId, 'Please compact your context window. Summarize the conversation so far and continue.');
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
  const sm = initState.getSessionManager();
  sm?.stop(cardId);
}

export async function handleAgentStatus(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId } = data;
  try {
    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    const session = sm?.get(cardId);

    if (session) {
      socket.emit('agent:status', {
        cardId,
        active: sm!.isActive(cardId),
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
        contextTokens: 0,
        contextWindow: 200_000,
      });
    } else {
      const card = await Card.findOneBy({ id: cardId });
      if (card && card.column === 'running' && card.queuePosition == null) {
        card.column = 'review';
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
      socket.emit('agent:status', {
        cardId,
        active: false,
        status: 'completed',
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
        contextTokens: card?.contextTokens ?? 0,
        contextWindow: card?.contextWindow ?? 200_000,
      });
    }
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
