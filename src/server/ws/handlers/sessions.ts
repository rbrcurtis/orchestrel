import type { WebSocket } from 'ws';
import type { ClientMessage } from '../../../shared/ws-protocol';
import type { ConnectionManager } from '../connections';
import { clientSubs } from '../subscriptions';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

export async function handleSessionLoad(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { cardId, sessionId } = msg.data;
  const { requestId } = msg;

  try {
    const alreadySubscribed = clientSubs.isSubscribed(ws, `card:${cardId}:sdk`);
    console.log(
      `[session:load] cardId=${cardId} sessionId=${sessionId ?? 'none'} alreadySubscribed=${alreadySubscribed}`,
    );

    if (sessionId) {
      const card = await Card.findOneBy({ id: cardId });
      let dir = card?.worktreePath ?? undefined;
      if (!dir && card?.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        dir = proj?.path;
      }
      const messages = await getSessionMessages(sessionId, { dir });
      console.log(`[session:load] cardId=${cardId} loaded ${messages.length} history messages`);
      connections.send(ws, { type: 'session:history', requestId, cardId, messages: messages as unknown[] });
    }
    connections.send(ws, { type: 'mutation:ok', requestId });

    if (alreadySubscribed) {
      console.log(`[session:load] cardId=${cardId} SKIPPING subscribe (already wired)`);
      return;
    }

    console.log(`[session:load] cardId=${cardId} SUBSCRIBING to bus topics`);

    // Subscribe to live SDK messages for this card
    clientSubs.subscribe(ws, `card:${cardId}:sdk`, (msg: unknown) => {
      connections.send(ws, { type: 'session:message', cardId, message: msg });
    });

    // Subscribe to card data updates
    clientSubs.subscribe(ws, `card:${cardId}:updated`, (payload) => {
      connections.send(ws, { type: 'card:updated', data: payload as import('../../../shared/ws-protocol').Card });
    });

    // Subscribe to status updates
    clientSubs.subscribe(ws, `card:${cardId}:status`, (data: unknown) => {
      connections.send(ws, { type: 'agent:status', data: data as import('../../../shared/ws-protocol').AgentStatus });
    });

    // Subscribe to session exit events
    clientSubs.subscribe(ws, `card:${cardId}:exit`, (payload: unknown) => {
      const p = payload as { sessionId: string | null; status: string };
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: false,
          status: p.status as 'completed',
          sessionId: p.sessionId,
          promptsSent: 0,
          turnsCompleted: 0,
          contextTokens: 0,
          contextWindow: 200_000,
        },
      });
    });
  } catch (err) {
    console.error(`[session:load] error loading session ${sessionId}:`, err);
    connections.send(ws, { type: 'mutation:error', requestId, error: `Failed to load session: ${err}` });
  }
}
