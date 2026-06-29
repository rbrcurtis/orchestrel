import type { AckResponse } from '../../../shared/ws-protocol';
import type { AppSocket } from '../types';
import { busRoomBridge } from '../subscriptions';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { resolveWorkDir } from '../../../shared/worktree';

export async function handleSessionLoad(
  data: { cardId: number; sessionId?: string },
  callback: (res: AckResponse<{ messages: unknown[] }>) => void,
  socket: AppSocket,
): Promise<void> {
  const { cardId } = data;

  try {
    const room = `card:${cardId}`;
    const alreadyJoined = socket.rooms.has(room);
    console.log(
      `[session:load] cardId=${cardId} alreadyJoined=${alreadyJoined}`,
    );

    let messages: unknown[] = [];
    const card = await Card.findOneBy({ id: cardId });

    if (card?.sessionId && card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj) {
        const cwd = resolveWorkDir(card.worktreeBranch ?? null, proj.path);
        try {
          const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
          const sessionMsgs = await getSessionMessages(card.sessionId, {
            dir: cwd,
          });
          messages = sessionMsgs;
          console.log(`[session:load] cardId=${cardId} loaded ${messages.length} messages via SDK`);
        } catch (err) {
          console.warn(`[session:load] cardId=${cardId} SDK getSessionMessages failed:`, err);
        }
      }
    }

    // Join the card room for live events
    if (!alreadyJoined) {
      socket.join(room);
      busRoomBridge.ensureCardListeners(cardId);
      console.log(`[session:load] cardId=${cardId} joined room ${room}`);
    }

    // Subscribe to orcd for live events (if session is active)
    if (card?.sessionId) {
      const initState = await import('../../init-state');
      const client = initState.getClientByNode(card.nodeName);
      if (client?.isActive(card.sessionId)) {
        client.subscribe(card.sessionId);
      }
    }

    callback({ data: { messages } });
  } catch (err) {
    console.error(`[session:load] error loading session:`, err);
    callback({ error: `Failed to load session: ${err}` });
  }
}
