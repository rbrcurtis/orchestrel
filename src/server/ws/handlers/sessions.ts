import type { WebSocket } from 'ws';
import type { ClientMessage, AgentMessage } from '../../../shared/ws-protocol';
import type { ConnectionManager } from '../connections';
import { clientSubs } from '../subscriptions';
import { sessionService } from '../../services/session';

export async function handleSessionLoad(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { cardId, sessionId } = msg.data;
  const { requestId } = msg;

  try {
    const alreadySubscribed = clientSubs.isSubscribed(ws, `card:${cardId}:message`);
    console.log(
      `[session:load] cardId=${cardId} sessionId=${sessionId ?? 'none'} alreadySubscribed=${alreadySubscribed} ` +
        `wsTopics=[${clientSubs
          .topicsFor(ws)
          .filter((t) => t.startsWith(`card:${cardId}:`))
          .join(', ')}] ` +
        `busListeners:message=${clientSubs.listenerCount(`card:${cardId}:message`)}`,
    );

    if (sessionId) {
      const messages = await sessionService.getHistory(sessionId, cardId);
      console.log(`[session:load] cardId=${cardId} loaded ${messages.length} history messages`);
      connections.send(ws, { type: 'session:history', requestId, cardId, messages });
    }
    connections.send(ws, { type: 'mutation:ok', requestId });

    // Already subscribed to this card's events — history was loaded above, nothing else to do
    if (alreadySubscribed) {
      console.log(`[session:load] cardId=${cardId} SKIPPING subscribe (already wired)`);
      return;
    }

    console.log(`[session:load] cardId=${cardId} SUBSCRIBING to bus topics`);

    // Subscribe to live agent messages for this card
    clientSubs.subscribe(ws, `card:${cardId}:message`, (payload) => {
      connections.send(ws, {
        type: 'agent:message',
        cardId,
        data: payload as AgentMessage,
      });
    });

    // Subscribe to card data updates (e.g., column changes)
    clientSubs.subscribe(ws, `card:${cardId}:updated`, (payload) => {
      connections.send(ws, { type: 'card:updated', data: payload as import('../../../shared/ws-protocol').Card });
    });

    // Subscribe to status updates (prompts/turns counters, sessionId)
    clientSubs.subscribe(ws, `card:${cardId}:status`, async (payload) => {
      const card = payload as import('../../models/Card').Card;
      const live = await sessionService.getStatus(cardId);
      connections.send(ws, {
        type: 'agent:status',
        data: live ?? {
          cardId,
          active: false,
          status: 'completed',
          sessionId: card.sessionId,
          promptsSent: card.promptsSent,
          turnsCompleted: card.turnsCompleted,
          contextTokens: card.contextTokens ?? 0,
          contextWindow: card.contextWindow ?? 200_000,
        },
      });
    });

    // Subscribe to session exit events
    clientSubs.subscribe(ws, `card:${cardId}:exit`, (payload) => {
      connections.send(ws, {
        type: 'agent:status',
        data: payload as import('../../../shared/ws-protocol').AgentStatus,
      });
    });

    // Subscribe to live session status changes (starting→running, etc.)
    clientSubs.subscribe(ws, `card:${cardId}:session-status`, (payload) => {
      connections.send(ws, {
        type: 'agent:status',
        data: payload as import('../../../shared/ws-protocol').AgentStatus,
      });
    });
  } catch (err) {
    console.error(`[session:load] error loading session ${sessionId}:`, err);
    connections.send(ws, { type: 'mutation:error', requestId, error: `Failed to load session: ${err}` });
  }
}
