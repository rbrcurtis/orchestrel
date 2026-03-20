import type { WebSocket } from 'ws';
import type { ClientMessage } from '../../../shared/ws-protocol';
import type { ConnectionManager } from '../connections';
import { sessionService } from '../../services/session';
import { Card } from '../../models/Card';

export async function handleAgentSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:send' }>,
  connections: ConnectionManager,
): Promise<void> {
  const {
    requestId,
    data: { cardId, message, files },
  } = msg;
  console.log(`[session:${cardId}] agent:send, len=${message.length}, files=${files?.length ?? 0}`);

  try {
    connections.send(ws, { type: 'mutation:ok', requestId });

    // startSession handles everything: follow-ups to active sessions,
    // queueing for non-worktree cards, and direct launch for worktree cards.
    sessionService.startSession(cardId, message, files).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[session:${cardId}] startSession error:`, error);
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: false,
          status: 'errored',
          sessionId: null,
          promptsSent: 0,
          turnsCompleted: 0,
          contextTokens: 0,
          contextWindow: 200_000,
        },
      });
    });
  } catch (err) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: String(err instanceof Error ? err.message : err),
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

  connections.send(ws, { type: 'mutation:ok', requestId });

  // Send status + message directly to the calling WS (bus may not reach this client)
  const card = await Card.findOneBy({ id: cardId });
  const mkStatus = (active: boolean, status: string) => ({
    type: 'agent:status' as const,
    data: {
      cardId,
      active,
      status: status as 'running' | 'completed',
      sessionId: card?.sessionId ?? null,
      promptsSent: card?.promptsSent ?? 0,
      turnsCompleted: card?.turnsCompleted ?? 0,
      contextTokens: card?.contextTokens ?? 0,
      contextWindow: card?.contextWindow ?? 200_000,
    },
  });

  connections.send(ws, mkStatus(true, 'running'));

  try {
    await sessionService.compactSession(cardId);
    // Send compact boundary message directly to calling WS
    connections.send(ws, {
      type: 'agent:message',
      cardId,
      data: {
        type: 'system',
        role: 'system',
        content: 'Context compacted',
        meta: { subtype: 'compact_boundary' },
        timestamp: Date.now(),
      },
    });
    connections.send(ws, mkStatus(false, 'completed'));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[session:${cardId}] compactSession error:`, error);
    connections.send(ws, mkStatus(false, 'completed'));
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
  sessionService.stopSession(cardId).catch((err) => {
    console.error(`[session:${cardId}] stopSession error:`, err);
  });
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
    const live = await sessionService.getStatus(cardId);
    if (live) {
      connections.send(ws, { type: 'agent:status', data: live });
    } else {
      // No active session — read counters from DB via model
      const card = await Card.findOneBy({ id: cardId });
      // Stale running card with no active session → move to review
      // But skip queued cards — they're waiting for their turn, not stale
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
