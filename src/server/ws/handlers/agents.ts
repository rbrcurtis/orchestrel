import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { isCreatePending } from '../../controllers/card-sessions';
import { isCompactCommand } from '../../../shared/slash-commands';
import { busRoomBridge } from '../subscriptions';
import { windowForCard } from '../../config/capabilities';
import { compactCardSession, stopCardExecution, submitCardPrompt } from '../../services/card-execution';

export async function handleAgentSend(
  data: { cardId: number; message: string; files?: Array<{ id: string; name: string; mimeType: string; path: string; size: number }> },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId, message, files } = data;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    callback({});

    // Sending a prompt must also (re)join this socket to the card room. The send
    // path isn't room-gated but the receive path is, so without this a socket
    // that reconnected and lost its room membership would prompt the agent yet
    // never see the streamed reply — the card looks hung.
    busRoomBridge.joinCard(socket, cardId);

    if (isCompactCommand(message)) {
      await compactCardSession(cardId);
      return;
    }

    await submitCardPrompt(cardId, message, files);
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
    await compactCardSession(cardId);
    callback({});
  } catch (err) {
    console.error(`[session:${cardId}] agent:compact error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleAgentStop(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:stop received`);
  try {
    await stopCardExecution(cardId);
    callback({});
  } catch (err) {
    console.error(`[session:${cardId}] agent:stop error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleAgentStatus(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId } = data;
  try {
    // Status is polled on every SessionView mount and on reconnect, so it's the
    // reliable reconciliation point: rejoin the card room here so a viewed card
    // keeps receiving live events even after a silent socket reconnect.
    busRoomBridge.joinCard(socket, cardId);

    const card = await Card.findOneBy({ id: cardId });
    const initState = await import('../../init-state');
    const client = card ? initState.getClientByNode(card.nodeName) : null;

    const active = !!(card?.sessionId && client?.isActive(card.sessionId));
    const starting = !!card && card.column === 'running' && (!card.sessionId || isCreatePending(cardId));

    if (!active && !starting && card && card.column === 'running') {
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await card.save();
    }

    socket.emit('agent:status', {
      cardId,
      active,
      status: active ? 'running' : starting ? 'starting' : 'completed',
      sessionId: card?.sessionId ?? null,
      promptsSent: card?.promptsSent ?? 0,
      turnsCompleted: card?.turnsCompleted ?? 0,
      contextTokens: card?.contextTokens ?? 0,
      contextWindow: card ? windowForCard(card) : 200_000,
    });
    callback({});
  } catch (err) {
    console.error(`[session:${cardId}] agent:status error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
