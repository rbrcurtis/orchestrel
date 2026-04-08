import type { WebSocket } from 'ws';
import type { ClientMessage } from '../../../shared/ws-protocol';
import type { ConnectionManager } from '../connections';
import { Card } from '../../models/Card';
import { registerCardSession } from '../../controllers/oc';

export async function handleAgentSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:send' }>,
  connections: ConnectionManager,
): Promise<void> {
  const {
    requestId,
    data: { cardId, message },
  } = msg;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    connections.send(ws, { type: 'mutation:ok', requestId });

    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    if (!sm) throw new Error('SessionManager not initialized');

    const card = await Card.findOneByOrFail({ id: cardId });

    if (sm.isActive(cardId)) {
      sm.sendFollowUp(cardId, message);
    } else {
      await sm.start(cardId, message, {
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
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error,
    });
  }
}

export async function handleAgentCompact(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:compact' }>,
  connections: ConnectionManager,
): Promise<void> {
  const {
    requestId,
    data: { cardId },
  } = msg;
  console.log(`[session:${cardId}] agent:compact received`);

  try {
    connections.send(ws, { type: 'mutation:ok', requestId });
    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    if (sm?.isActive(cardId)) {
      sm.sendFollowUp(cardId, 'Please compact your context window. Summarize the conversation so far and continue.');
    }
  } catch (err) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: String(err instanceof Error ? err.message : err),
    });
  }
}

export async function handleAgentStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:stop' }>,
  connections: ConnectionManager,
): Promise<void> {
  const {
    requestId,
    data: { cardId },
  } = msg;
  console.log(`[session:${cardId}] agent:stop received`);
  connections.send(ws, { type: 'mutation:ok', requestId });
  const initState = await import('../../init-state');
  const sm = initState.getSessionManager();
  sm?.stop(cardId);
}

export async function handleAgentStatus(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:status' }>,
  connections: ConnectionManager,
): Promise<void> {
  const {
    requestId,
    data: { cardId },
  } = msg;
  try {
    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    const session = sm?.get(cardId);

    if (session) {
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: sm!.isActive(cardId),
          status: session.status,
          sessionId: session.sessionId,
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
          contextTokens: 0,
          contextWindow: 200_000,
        },
      });
    } else {
      const card = await Card.findOneBy({ id: cardId });
      // Stale running card with no active session → move to review
      if (card && card.column === 'running' && card.queuePosition == null) {
        card.column = 'review';
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: false,
          status: 'completed',
          sessionId: card?.sessionId ?? null,
          promptsSent: card?.promptsSent ?? 0,
          turnsCompleted: card?.turnsCompleted ?? 0,
          contextTokens: card?.contextTokens ?? 0,
          contextWindow: card?.contextWindow ?? 200_000,
        },
      });
    }
    connections.send(ws, { type: 'mutation:ok', requestId });
  } catch (err) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: String(err instanceof Error ? err.message : err),
    });
  }
}
